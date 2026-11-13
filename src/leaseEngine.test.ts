// Device leases through the daemon's methods, against fake drivers: which calls take a device and which only look,
// what `force` may do, the boot paths (a free simulator, a twin, a new simulator, a second emulator instance), a
// reused emulator serial, and the push gateway's routing. Leases live in a temporary PITBOX_HOME (src/test-setup.ts).

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {bundlerProbe, Engine} from './daemon/engine.ts';
import {AndroidDriver, avdDir, avdLocked, avdStamp, avdTaken, createAvdLike, deleteAvd, insideFolder, killTree, lockPid, type AndroidDevice, type Launch} from './drivers/android/driver.ts';
import {avdHome} from './drivers/android/sdk.ts';
import type {Simulator} from './drivers/apple/driver.ts';
import {isCreated, listCreated, recordCreated} from './lease/created.ts';
import {leaseDir, readLease} from './lease/lease.ts';
import {PushCenter} from './push/push.ts';

type Sim = Simulator;

class FakeApple {
  sims: Sim[];
  deleted: string[] = [];
  stopped: string[] = [];

  constructor(sims: Partial<Sim>[]) {
    this.sims = sims.map((s, i) => ({udid: `U${i + 1}`, name: 'iPhone 17', state: 'Shutdown', runtime: 'iOS-27-2', os: 'iOS 27.2', kind: 'phone', available: true, deviceType: 'iPhone-17', ...s}));
    for (const s of this.sims) if (s.state === 'Booted') this.marks.set(s.udid, `launchd_sim:${8000 + this.marks.size}@1700000000`);
  }

  /** udid -> the boot it runs (its launchd_sim): a simulator booted again runs another. */
  marks = new Map<string, string>();
  #boots = 0;
  bootMarks = async () => new Map(this.marks);
  /** Boots it outside pitbox (by hand, Xcode). */
  bootElsewhere = (udid: string) => {
    this.sims.find(x => x.udid === udid)!.state = 'Booted';
    this.marks.set(udid, `launchd_sim:${9000 + ++this.#boots}@1700000000`);
  };
  simulators = async () => this.sims.map(s => ({...s}));
  booted = async () => this.sims.filter(s => s.state === 'Booted').map(s => ({...s}));
  resolve = async (sel?: string) => {
    const b = this.sims.filter(s => s.state === 'Booted' && (!sel || s.udid === sel || s.name === sel));
    if (b.length !== 1) throw new Error(`no booted simulator matches "${sel ?? ''}"`);
    return b[0]!.udid;
  };
  boot = async (sel: string) => {
    const s = this.sims.find(x => x.udid === sel || x.name === sel)!;
    const already = s.state === 'Booted';
    s.state = 'Booted';
    if (!already) this.marks.set(s.udid, `launchd_sim:${100 + ++this.#boots}@1700000000`);
    return {udid: s.udid, name: s.name, ms: 1, already};
  };
  shutdown = async (udid: string) => {
    this.sims.find(x => x.udid === udid)!.state = 'Shutdown';
    this.marks.delete(udid);
    return {ms: 1, gone: true};
  };
  createLike = async (like: Sim, name: string) => {
    const s = {...like, udid: `NEW${this.sims.length + 1}`, name, state: 'Shutdown'};
    this.sims.push(s);
    return {...s};
  };
  delete = async (udid: string) => {
    this.sims = this.sims.filter(x => x.udid !== udid);
    this.deleted.push(udid);
  };
  stop = async (udid: string) => void this.stopped.push(udid);
  packages = async () => ['com.example.app'];
  screenshot = async (_udid: string, file: string) => ({file});
}

class FakeAndroid {
  adbPath = 'adb';
  devs: AndroidDevice[] = [];
  bootOpts: Record<string, unknown>[] = [];
  stopped: string[] = [];
  aborted: string[] = [];
  avdNames = ['Test_Phone_Lease'];
  deletedAvds: string[] = [];
  /** Instances started -read-only (the emulator runs a second instance of an AVD only beside read-only ones). */
  readOnlyIds = new Set<string>();
  /** AVDs whose next boot never finishes. */
  hang = new Set<string>();
  /** AVD -> the instance holding its lock while one runs. */
  locks = new Map<string, string>();
  #boots = 0;

  devices = async () => this.devs.map(d => ({...d}));
  avds = () => this.avdNames.map(name => ({name, kind: 'phone'}));
  /** Discovery files: emulators launched but not listed by adb yet. */
  starting: {serial: string; avd: string; instance: string; readOnly: boolean}[] = [];
  running = () => [...this.starting, ...this.devs.filter(d => d.avd && d.instance).map(d => ({serial: d.serial, avd: d.avd!, instance: d.instance!, readOnly: this.readOnly(d.instance)}))];
  readOnly = (instance?: string) => !!instance && this.readOnlyIds.has(instance);
  lockedBy = (avd: string) => this.locks.get(avd) ?? this.devs.find(d => d.avd === avd && !this.readOnly(d.instance))?.instance;
  avdTaken = (name: string) => this.avdNames.includes(name);
  avdStamp = (name: string) => (this.avdNames.includes(name) ? `stamp-${name}` : undefined);
  createLike = (like: string, name: string) => {
    if (!this.avdNames.includes(like) || this.avdNames.includes(name)) throw new Error('bad clone');
    this.avdNames.push(name);
  };
  deleteAvd = (name: string) => {
    this.avdNames = this.avdNames.filter(n => n !== name);
    this.deletedAvds.push(name);
  };
  resolve = async (sel?: string) => {
    const hit = this.devs.filter(d => !sel || d.serial === sel || d.avd === sel);
    if (hit.length !== 1) throw new Error(`no online device matches "${sel ?? ''}"`);
    return hit[0]!.serial;
  };
  /** A new emulator takes the lowest free port, as the emulator does: a serial comes back after a shutdown. */
  launch = async (avd: string, opts: Record<string, unknown>) => {
    this.bootOpts.push(opts);
    if (!this.avdNames.includes(avd)) throw new Error(`unknown AVD "${avd}"`);
    // The emulator's own rule: a second instance only when it and every running one are -read-only.
    if (this.devs.some(d => d.avd === avd && !(opts.newInstance && this.readOnly(d.instance)))) throw new Error('Another emulator instance is running');
    let port = 5554;
    while (this.devs.some(d => d.serial === `emulator-${port}`)) port += 2;
    const serial = `emulator-${port}`;
    const instance = `pid:${++this.#boots}`;
    if (opts.newInstance) this.readOnlyIds.add(instance);
    this.devs.push({serial, state: 'device', avd, emulator: true, instance});
    return {avd, serial, readOnly: !!opts.newInstance} as unknown as Launch;
  };
  untilListed = async () => undefined;
  untilBooted = async (l: Launch) => {
    if (this.hang.has(l.avd)) throw new Error(`${l.avd} did not finish booting in 600s`);
    return {serial: l.serial!, ms: 1, already: false, ...(l.readOnly ? {readOnly: true} : {})};
  };
  abort = async (l: Launch) => {
    this.aborted.push(l.serial!);
    this.devs = this.devs.filter(d => d.serial !== l.serial);
  };
  shutdown = async (serial: string) => {
    this.devs = this.devs.filter(d => d.serial !== serial);
    return {ms: 1, gone: true};
  };
  stop = async (serial: string) => void this.stopped.push(serial);
  packages = async () => ['com.example.app'];
  screenshot = async (_s: string, file: string) => ({file});
  reverseList = async () => [];
  reverse = async (_s: string, ports: number[]) => ports;
}

const dirs: string[] = [];
const session = async (name: string, drivers: {android?: FakeAndroid | null; apple?: FakeApple | null}, extra: Record<string, unknown> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pitbox-${name}-`));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({app: {android: 'com.example.app', apple: 'com.example.app'}, ...extra}));
  return Engine.create(path.join(dir, 'pitbox.config.json'), undefined, {android: (drivers.android ?? null) as never, apple: (drivers.apple ?? null) as never});
};

beforeEach(() => {
  fs.rmSync(leaseDir(), {recursive: true, force: true});
  // The created-devices list lives beside the leases: each test starts with none.
  fs.rmSync(path.join(path.dirname(leaseDir()), 'created-simulators.json'), {force: true});
});
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

describe('simulators', () => {
  it('boots the named simulator for the first session and a new one for the second, deleted when given back', async () => {
    const apple = new FakeApple([{}]);
    const a = await session('alice', {apple});
    const b = await session('bob', {apple});
    expect(await a.methods.boot({avd: 'iPhone 17'})).toMatchObject({udid: 'U1', already: false});
    expect(readLease('apple', 'U1')).toMatchObject({booted: true});
    const r = (await b.methods.boot({avd: 'iPhone 17'})) as {udid: string; instead: string};
    expect(r.udid).toBe('NEW2');
    expect(r.instead).toMatch(/^iPhone 17 is held by "pitbox-alice-.*\); created iPhone 17 \(pitbox 2\) instead/);
    expect(readLease('apple', 'NEW2')).toMatchObject({created: true, booted: true});
    expect(await b.methods.release({})).toMatchObject({released: 'iPhone 17 (pitbox 2)', gone: true});
    expect(apple.deleted).toEqual(['NEW2']);
    expect(apple.sims.find(s => s.udid === 'U1')?.state).toBe('Booted');
  });

  it('leaves a simulator that runs with no lease alone and takes an idle twin', async () => {
    const apple = new FakeApple([{state: 'Booted'}, {}]);
    const b = await session('bob', {apple});
    const r = (await b.methods.boot({avd: 'iPhone 17'})) as {udid: string; instead: string};
    expect(r.udid).toBe('U2');
    expect(r.instead).toMatch(/runs without a lease .*: left alone; took iPhone 17 instead/);
    expect(readLease('apple', 'U1')).toBeUndefined();
  });

  it('takes, looks and refuses by method', async () => {
    const apple = new FakeApple([{}]);
    const a = await session('alice', {apple});
    const b = await session('bob', {apple});
    await a.methods.boot({avd: 'iPhone 17'});
    // Driving: refused with or without the device named.
    await expect(b.methods.stopApp({})).rejects.toThrow(/no device of this session is online:\niPhone 17 — held by "pitbox-alice-/);
    await expect(b.methods.stopApp({device: 'U1'})).rejects.toThrow(/^iPhone 17 is held by "pitbox-alice-.*pitbox does not touch another session's device/);
    await expect(b.methods.lease({device: 'U1'})).rejects.toThrow(/held by "pitbox-alice-/);
    await expect(b.methods.shutdown({device: 'U1'})).rejects.toThrow(/held by "pitbox-alice-/);
    expect(apple.stopped).toEqual([]);
    // Looking: allowed.
    expect(await b.methods.apps({})).toEqual({packages: ['com.example.app']});
    expect(await b.methods.screenshot({device: 'U1', file: 'x.png'})).toMatchObject({udid: 'U1'});
    // The holder drives as before.
    expect(await a.methods.stopApp({})).toEqual({udid: 'U1'});
    expect(apple.stopped).toEqual(['U1']);
  });

  it('takes a running simulator nobody leased only when it is named', async () => {
    const apple = new FakeApple([{state: 'Booted'}]);
    const b = await session('bob', {apple});
    await expect(b.methods.stopApp({})).rejects.toThrow(/running, unleased\nhint: .*device=U1/);
    expect(await b.methods.stopApp({device: 'U1'})).toEqual({udid: 'U1'});
    expect(readLease('apple', 'U1')?.root).toMatch(/pitbox-bob-/);
    // Taken, not booted here: given back, it stays up.
    expect(await b.methods.release({})).toEqual({released: 'iPhone 17'});
    expect(apple.sims[0]!.state).toBe('Booted');
  });

  it('forces only onto a named device, and says whose it was', async () => {
    const apple = new FakeApple([{}]);
    const a = await session('alice', {apple});
    const b = await session('bob', {apple});
    await a.methods.boot({avd: 'iPhone 17'});
    await expect(b.methods.shutdown({force: true})).rejects.toThrow(/force needs a named device/);
    await expect(b.methods.release({force: true})).rejects.toThrow(/force needs a named device/);
    const r = (await b.methods.shutdown({device: 'U1', force: true})) as {note: string};
    expect(r.note).toMatch(/^it was held by "pitbox-alice-/);
    expect(readLease('apple', 'U1')).toBeUndefined();
  });

  it('refuses to shut down a running device nobody leased unless forced', async () => {
    const apple = new FakeApple([{state: 'Booted'}]);
    const b = await session('bob', {apple});
    await expect(b.methods.shutdown({device: 'U1'})).rejects.toThrow(/not this session's: pitbox neither booted nor leased it here/);
    expect(apple.sims[0]!.state).toBe('Booted');
  });

  it('shuts down what it booted on an explicit stop, and leaves what it found', async () => {
    const apple = new FakeApple([{}, {name: 'iPad', deviceType: 'iPad', state: 'Booted'}]);
    const a = await session('alice', {apple});
    await a.methods.boot({avd: 'iPhone 17'});
    await a.methods.lease({device: 'U2'});
    await a.stopAll({release: true});
    expect(apple.sims.map(s => s.state)).toEqual(['Shutdown', 'Booted']);
    expect(fs.readdirSync(leaseDir()).filter(f => f.endsWith('.json'))).toEqual([]);
  });

  it('keeps its leases and its devices running on any stop but an explicit one (a restart, a signal, a version swap)', async () => {
    const apple = new FakeApple([{}]);
    const a = await session('alice', {apple});
    await a.methods.boot({avd: 'iPhone 17'});
    await a.stopAll();
    expect(apple.sims[0]!.state).toBe('Booted');
    expect(readLease('apple', 'U1')).toMatchObject({booted: true});
  });

  it('hands its devices to the next daemon of the project, which still shuts down only what pitbox booted', async () => {
    const apple = new FakeApple([{}, {name: 'iPad', deviceType: 'iPad', state: 'Booted'}]);
    const a = await session('alice', {apple});
    await a.methods.boot({avd: 'iPhone 17'});
    await a.methods.lease({device: 'U2'});
    await a.stopAll();
    const next = await Engine.create(a.loaded.file, undefined, {android: null, apple: apple as never});
    expect(apple.sims.map(s => s.state)).toEqual(['Booted', 'Booted']);
    await next.stopAll({release: true});
    expect(apple.sims.map(s => s.state)).toEqual(['Shutdown', 'Booted']);
  });

  it('cleans only the simulators it recorded creating, never one named like them by hand', async () => {
    // A user's own simulator named like pitbox's, of another model so no session takes it as a twin.
    const apple = new FakeApple([{}, {name: 'iPhone 17 (pitbox 3)', deviceType: 'iPhone-16e'}]);
    const a = await session('alice', {apple});
    const b = await session('bob', {apple});
    await a.methods.boot({avd: 'iPhone 17'});
    await b.methods.boot({avd: 'iPhone 17'});
    expect(isCreated('NEW3')).toBe(true);
    // bob's daemon goes away keeping its lease: a held simulator is not cleaned, even a created one.
    await b.stopAll();
    expect(await a.methods.cleanDevices({})).toEqual({deleted: []});
    await b.methods.release({});
    expect(isCreated('NEW3')).toBe(false);
    // One recorded but left behind (a daemon killed before it gave it back).
    apple.sims.push({...apple.sims[0]!, udid: 'LEFT', name: 'iPhone 17 (pitbox 4)', state: 'Shutdown'});
    recordCreated('LEFT', 'iPhone 17 (pitbox 4)');
    recordCreated('GONE', 'iPhone 17 (pitbox 5)');
    expect(await a.methods.cleanDevices({})).toEqual({deleted: ['iPhone 17 (pitbox 4)']});
    expect(apple.sims.map(s => s.name)).toEqual(['iPhone 17', 'iPhone 17 (pitbox 3)']);
    expect(isCreated('GONE')).toBe(false);
  });

  it('records the boot it made, and on a stop leaves a simulator booted again since by hand running', async () => {
    const apple = new FakeApple([{}, {name: 'iPad', deviceType: 'iPad'}]);
    const a = await session('alice', {apple});
    await a.methods.boot({avd: 'iPhone 17'});
    await a.methods.boot({avd: 'iPad'});
    expect(readLease('apple', 'U1')?.boot).toBe(apple.marks.get('U1'));
    // The daemon goes away keeping its leases; meanwhile U1 is shut down and booted again by hand.
    await a.stopAll();
    await apple.shutdown('U1');
    apple.bootElsewhere('U1');
    const next = await Engine.create(a.loaded.file, undefined, {android: null, apple: apple as never});
    await next.stopAll({release: true});
    expect(apple.sims.map(s => s.state)).toEqual(['Booted', 'Shutdown']);
    expect(fs.readdirSync(leaseDir()).filter(f => f.endsWith('.json'))).toEqual([]);
  });

  it('leaves running, on a release, a simulator whose lease has no boot mark (an older pitbox) or that was booted again', async () => {
    const apple = new FakeApple([{}, {name: 'iPad', deviceType: 'iPad'}]);
    const a = await session('alice', {apple});
    await a.methods.boot({avd: 'iPhone 17'});
    await a.methods.boot({avd: 'iPad'});
    const file = path.join(leaseDir(), 'apple-U1.json');
    const {boot: _, ...older} = readLease('apple', 'U1')!;
    fs.writeFileSync(file, JSON.stringify(older));
    expect(await a.methods.release({device: 'U1'})).toMatchObject({note: expect.stringMatching(/^left running: it no longer runs the boot pitbox made/)});
    apple.bootElsewhere('U2');
    expect(await a.methods.release({device: 'U2'})).toMatchObject({note: expect.stringMatching(/^left running/)});
    expect(apple.sims.map(s => s.state)).toEqual(['Booted', 'Booted']);
  });

  it('never shuts down a device another session holds when it stops', async () => {
    const apple = new FakeApple([{}]);
    const a = await session('alice', {apple});
    const b = await session('bob', {apple});
    await a.methods.boot({avd: 'iPhone 17'});
    await b.stopAll({release: true});
    expect(apple.sims[0]!.state).toBe('Booted');
    expect(readLease('apple', 'U1')).toMatchObject({booted: true});
  });
});

describe('emulators', () => {
  it('creates an AVD of its own beside a writable instance another session holds, deleted when given back', async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    expect(await a.methods.boot({avd: 'Test_Phone_Lease'})).toMatchObject({serial: 'emulator-5554', already: false});
    const r = (await b.methods.boot({avd: 'Test_Phone_Lease'})) as {serial: string; avd: string; instead: string};
    expect(r).toMatchObject({serial: 'emulator-5556', avd: 'Test_Phone_Lease_pitbox_2'});
    expect(android.bootOpts.map(o => o.newInstance)).toEqual([false, false]);
    expect(r.instead).toMatch(/^Test_Phone_Lease runs for "pitbox-alice-.*\); created Test_Phone_Lease_pitbox_2 instead/);
    expect(readLease('android', 'emulator-5556')).toMatchObject({created: true, name: 'Test_Phone_Lease_pitbox_2'});
    expect(await b.methods.stopApp({})).toEqual({serial: 'emulator-5556'});
    await expect(b.methods.stopApp({device: 'emulator-5554'})).rejects.toThrow(/held by "pitbox-alice-/);
    expect(await b.methods.release({})).toMatchObject({released: 'Test_Phone_Lease_pitbox_2', gone: true});
    expect(android.deletedAvds).toEqual(['Test_Phone_Lease_pitbox_2']);
    expect(android.devs.map(d => d.serial)).toEqual(['emulator-5554']);
  });

  it('starts a second -read-only instance beside one that runs -read-only', async () => {
    const android = new FakeAndroid();
    const b = await session('bob', {android});
    android.devs.push({serial: 'emulator-5554', state: 'device', avd: 'Test_Phone_Lease', emulator: true, instance: 'pid:ro'});
    android.readOnlyIds.add('pid:ro');
    const r = (await b.methods.boot({avd: 'Test_Phone_Lease'})) as {serial: string; instead: string; note: string};
    expect(r.serial).toBe('emulator-5556');
    expect(r.instead).toMatch(/runs without a lease .*: left alone; started another instance/);
    expect(r.note).toMatch(/-read-only/);
    expect(android.avdNames).toEqual(['Test_Phone_Lease']);
  });

  it('does not let a lease follow a serial to the next emulator', async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    // alice's emulator goes away without pitbox; bob's comes up on the same serial
    android.devs = [];
    expect(await b.methods.boot({avd: 'Test_Phone_Lease'})).toMatchObject({serial: 'emulator-5554', already: false});
    expect(readLease('android', 'emulator-5554')?.root).toMatch(/pitbox-bob-/);
    expect(await b.methods.stopApp({})).toEqual({serial: 'emulator-5554'});
    // alice, with no device named, does not take bob's emulator for her old one
    await expect(a.methods.stopApp({})).rejects.toThrow(/held by "pitbox-bob-/);
    await expect(a.methods.shutdown({})).rejects.toThrow(/held by "pitbox-bob-/);
    expect(android.stopped).toEqual(['emulator-5554']);
  });

  it('on a stop leaves running an emulator that took the serial of one it booted (an adopted lease)', async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    expect(readLease('android', 'emulator-5554')).toMatchObject({instance: 'pid:1', boot: 'pid:1'});
    await a.stopAll();
    // alice's emulator dies; another one, nobody's, comes up on its serial.
    android.devs = [{serial: 'emulator-5554', state: 'device', avd: 'Other', emulator: true, instance: 'pid:77'}];
    const next = await Engine.create(a.loaded.file, undefined, {android: android as never, apple: null});
    await next.stopAll({release: true});
    expect(android.devs.map(d => d.serial)).toEqual(['emulator-5554']);
    expect(readLease('android', 'emulator-5554')).toBeUndefined();
  });

  it('shuts down on a stop the emulator it booted while it still runs', async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    await a.stopAll({release: true});
    expect(android.devs).toEqual([]);
  });

  it('lists who holds each device', async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    android.devs.push({serial: 'emulator-5580', state: 'device', avd: 'Other', emulator: true, instance: 'pid:x'});
    const r = (await b.methods.devices({})) as {devices: {serial: string; holder?: string}[]};
    expect(r.devices.map(d => `${d.serial} ${d.holder}`)).toEqual([expect.stringMatching(/^emulator-5554 held by "pitbox-alice-/), 'emulator-5580 running, unleased']);
  });
});

describe('project tools on the session device', () => {
  const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));
  const args = `${node} -e "console.log(JSON.stringify(process.argv.slice(1)))"`;
  const tools = {
    tools: {
      install: {run: `${args} {apple_device} {app}`, params: {app: 'app path'}},
      reset: {run: `${args} {android_device}`},
    },
  };
  const run = async (e: Awaited<ReturnType<typeof session>>, name: string, params: Record<string, string> = {}) =>
    ((await e.methods.tool({name, params})) as {output: string}).output;

  it("fills {apple_device} with this session's simulator, never another booted one", async () => {
    const apple = new FakeApple([{}]);
    const a = await session('alice', {apple}, tools);
    const b = await session('bob', {apple}, tools);
    await a.methods.boot({avd: 'iPhone 17'});
    // Another session's simulator is booted, this one holds none: the tool does not run.
    await expect(run(b, 'install', {app: 'x.app'})).rejects.toThrow(/tool install runs on \{apple_device\}, and this session holds no booted simulator\nhint: `device action=boot`/);
    await b.methods.boot({avd: 'iPhone 17'});
    expect(await run(b, 'install', {app: 'x.app'})).toBe('["NEW2","x.app"]');
    expect(await run(a, 'install', {app: 'x.app'})).toBe('["U1","x.app"]');
    // A caller cannot point it elsewhere.
    expect(await run(b, 'install', {app: 'x.app', apple_device: 'U1'})).toBe('["NEW2","x.app"]');
  }, 30_000);

  it('refuses a simulator that runs with no lease, and several of its own', async () => {
    const apple = new FakeApple([{state: 'Booted'}, {}, {}]);
    const b = await session('bob', {apple}, tools);
    await expect(run(b, 'install', {app: 'x.app'})).rejects.toThrow(/holds no booted simulator/);
    await b.methods.boot({avd: 'U2'});
    await b.methods.boot({avd: 'U3'});
    await expect(run(b, 'install', {app: 'x.app'})).rejects.toThrow(/holds several: iPhone 17 \(U2\), iPhone 17 \(U3\)/);
  }, 30_000);

  it("fills {android_device} with this session's emulator", async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android}, tools);
    const b = await session('bob', {android}, tools);
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    await expect(run(b, 'reset')).rejects.toThrow(/tool reset runs on \{android_device\}, and this session holds no online Android device/);
    expect(await run(a, 'reset')).toBe('["emulator-5554"]');
  }, 30_000);
});

describe("another stand's bundler", () => {
  const listen = (port: number, cwd: string) => {
    const child = spawn(process.execPath, ['-e', `require('http').createServer((q, s) => s.end('packager-status:running')).listen(${port}, '::', () => console.log('up'))`], {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let err = '';
    child.stderr.on('data', d => (err += d));
    // Fails at once when the stand-in cannot listen, instead of hanging the test until its timeout.
    return new Promise<typeof child>((resolve, reject) => {
      child.stdout.once('data', () => resolve(child));
      child.once('exit', code => reject(new Error(`the bundler stand-in on port ${port} exited (${code}): ${err.trim()}`)));
    });
  };
  // Waits for the exit too: Windows will not remove a folder a live process runs in.
  const stop = (child: ReturnType<typeof spawn>) => new Promise<void>(resolve => (child.exitCode !== null || child.signalCode !== null ? resolve() : (child.once('exit', () => resolve()), child.kill())));

  // Windows cannot name a port's listener, so there it is adopted as before.
  it.skipIf(process.platform === 'win32')('is not adopted: the dev server fails with its pid, and the proxy is not started', async () => {
    const [port, internalPort] = [await freePort(), await freePort()];
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-other-'));
    dirs.push(elsewhere);
    const theirs = await listen(internalPort, elsewhere);
    try {
      const e = await session('bob', {}, {devserver: {adapter: 'command', start: 'node -e "setInterval(() => {}, 1000)"', port, internalPort}});
      const r = (await e.methods.up({services: ['devserver']})) as {services: {name: string; status: string; detail?: string}[]};
      const dev = r.services.find(s => s.name === 'devserver');
      expect(dev?.status).toBe('failed');
      expect(dev?.detail).toMatch(new RegExp(`^port ${internalPort}, the bundler's, is taken by pid ${theirs.pid}`));
      expect(await new Promise(resolve => net.connect(port, '127.0.0.1').once('connect', () => resolve(true)).once('error', () => resolve(false)))).toBe(false);
    } finally {
      await stop(theirs);
    }
  }, 60_000);

  describe('with every listener of the port named', () => {
    const realListeners = bundlerProbe.listeners;
    afterEach(() => (bundlerProbe.listeners = realListeners));
    /** A repository with the project in `app/` and another folder of it beside. */
    const repo = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-repo-'));
      dirs.push(dir);
      fs.mkdirSync(path.join(dir, '.git'));
      fs.mkdirSync(path.join(dir, 'app'));
      fs.mkdirSync(path.join(dir, 'tools'));
      return dir;
    };
    /** Brings the dev server up beside a bundler stand-in run in `cwd`; `owners`, when given, is who lsof names. */
    const up = async (root: string, cwd: string, owners?: {pid: number; cwd?: string}[]) => {
      const [port, internalPort] = [await freePort(), await freePort()];
      const file = path.join(root, 'app', 'pitbox.config.json');
      fs.writeFileSync(file, JSON.stringify({devserver: {adapter: 'command', start: 'node -e "setInterval(() => {}, 1000)"', port, internalPort}}));
      const e = await Engine.create(file, undefined, {android: null, apple: null});
      if (owners) bundlerProbe.listeners = async () => owners;
      const child = await listen(internalPort, cwd);
      try {
        const r = (await e.methods.up({services: ['devserver']})) as {services: {name: string; status: string; detail?: string}[]};
        const dev = r.services.find(s => s.name === 'devserver')!;
        if (dev.status === 'external') await e.methods.down({});
        return dev;
      } finally {
        await stop(child);
      }
    };

    it("adopts a bundler run anywhere in the project's repository, as services do", async () => {
      const root = repo();
      expect((await up(root, path.join(root, 'tools'))).status).toBe('external');
    }, 60_000);

    it("is foreign when any of several listeners is not the project's, and adopted where none can be named", async () => {
      const root = repo();
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-other-'));
      dirs.push(elsewhere);
      const dev = await up(root, path.join(root, 'app'), [{pid: 4242, cwd: path.join(root, 'app')}, {pid: 4343, cwd: elsewhere}]);
      expect(dev.status).toBe('failed');
      expect(dev.detail).toMatch(/is taken by pid 4343 in /);
      const other = repo();
      expect((await up(other, path.join(other, 'app'), [])).status).toBe('external');
    }, 60_000);
  });

  it("is adopted when it runs in the dev server's own folder", async () => {
    const [port, internalPort] = [await freePort(), await freePort()];
    const e = await session('alice', {}, {devserver: {adapter: 'command', start: 'node -e "setInterval(() => {}, 1000)"', port, internalPort}});
    const mine = await listen(internalPort, dirs.at(-1)!);
    try {
      const r = (await e.methods.up({services: ['devserver']})) as {services: {name: string; status: string}[]};
      expect(r.services.find(s => s.name === 'devserver')?.status).toBe('external');
      await e.methods.down({});
    } finally {
      await stop(mine);
    }
  }, 60_000);
});

describe('push gateway routing', () => {
  const center = (online: {android: string[]; apple: string[]}) =>
    new PushCenter({target: async () => Promise.reject(new Error('unused')), online: async () => online, ui: async () => Promise.reject(new Error('unused'))});

  it("routes only to this session's devices and skips a token bound to a device it no longer holds", async () => {
    const c = center({android: ['emulator-5556'], apple: []});
    c.tokens.set('tok', 'emulator-5554');
    expect(await c.route('fcm', 'tok')).toEqual({device: 'emulator-5556', note: 'the token is bound to emulator-5554, which this session does not hold now: routed by kind instead'});
    c.tokens.set('mine', 'emulator-5556');
    expect(await c.route('fcm', 'mine')).toEqual({device: 'emulator-5556'});
    expect(await center({android: [], apple: []}).route('apns')).toEqual({device: undefined});
  });
});

const freePort = () =>
  new Promise<number>(resolve => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

describe('AVD copies', () => {
  const grace = Engine.COPY_GRACE_MS;
  const letGo = Engine.AVD_LET_GO_MS;
  const offlineWait = Engine.OWN_OFFLINE_WAIT_MS;
  afterEach(() => {
    Engine.COPY_GRACE_MS = grace;
    Engine.AVD_LET_GO_MS = letGo;
    Engine.OWN_OFFLINE_WAIT_MS = offlineWait;
  });

  it('answers its own copy while it is offline instead of making another', async () => {
    Engine.OWN_OFFLINE_WAIT_MS = 50;
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    await b.methods.boot({avd: 'Test_Phone_Lease'});
    android.devs.find(d => d.serial === 'emulator-5556')!.state = 'offline';
    expect(await b.methods.boot({avd: 'Test_Phone_Lease'})).toMatchObject({serial: 'emulator-5556', already: true, avd: 'Test_Phone_Lease_pitbox_2', note: expect.stringMatching(/offline: still this session's/)});
    expect(android.avdNames).toEqual(['Test_Phone_Lease', 'Test_Phone_Lease_pitbox_2']);
  });

  it('never takes another emulator that took its copy\'s port, and does not wait for a copy that is gone', async () => {
    Engine.OWN_OFFLINE_WAIT_MS = 5000;
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    await b.methods.boot({avd: 'Test_Phone_Lease'});
    // bob's copy died; an emulator of someone else came up on its port.
    android.devs = android.devs.filter(d => d.serial !== 'emulator-5556');
    android.avdNames.push('Other');
    android.devs.push({serial: 'emulator-5556', state: 'offline', avd: 'Other', emulator: true, instance: 'pid:other'});
    const t0 = Date.now();
    const r = (await b.methods.boot({avd: 'Test_Phone_Lease'})) as {serial: string; already: boolean};
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({serial: 'emulator-5558', already: false});
    expect(android.devs.find(d => d.serial === 'emulator-5556')?.instance).toBe('pid:other');
    expect(android.aborted).toEqual([]);
  });

  it('answers its own copy that only its discovery file shows while adb lists nothing', async () => {
    Engine.OWN_OFFLINE_WAIT_MS = 50;
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    await b.methods.boot({avd: 'Test_Phone_Lease'});
    // adb restarting: an empty list for a moment; the emulators still run.
    android.starting = android.running();
    android.devs = [];
    expect(await b.methods.boot({avd: 'Test_Phone_Lease'})).toMatchObject({serial: 'emulator-5556', already: true, note: expect.stringMatching(/not listed by adb: still this session's/)});
    expect(android.avdNames).toEqual(['Test_Phone_Lease', 'Test_Phone_Lease_pitbox_2']);
  });

  it('counts an instance adb does not list yet (seen by its discovery file) as running', async () => {
    const android = new FakeAndroid();
    const b = await session('bob', {android});
    android.starting.push({serial: 'emulator-5554', avd: 'Test_Phone_Lease', instance: 'pid:s', readOnly: false});
    expect(await b.methods.boot({avd: 'Test_Phone_Lease'})).toMatchObject({avd: 'Test_Phone_Lease_pitbox_2'});
    expect(android.bootOpts[0]).toMatchObject({newInstance: false, noSnapshot: true});
  });

  it('answers the copy it holds on the next boot instead of making another', async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    await b.methods.boot({avd: 'Test_Phone_Lease'});
    expect(await b.methods.boot({avd: 'Test_Phone_Lease'})).toMatchObject({serial: 'emulator-5556', already: true, avd: 'Test_Phone_Lease_pitbox_2'});
    expect(android.avdNames).toEqual(['Test_Phone_Lease', 'Test_Phone_Lease_pitbox_2']);
    expect(await b.methods.stopApp({})).toEqual({serial: 'emulator-5556'});
  });

  it('boots a copy without snapshots and with more time, and kills and deletes one that does not come up', async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    android.hang.add('Test_Phone_Lease_pitbox_2');
    await expect(b.methods.boot({avd: 'Test_Phone_Lease'})).rejects.toThrow(/did not finish booting/);
    expect(android.bootOpts[1]).toMatchObject({noSnapshot: true, timeoutMs: 600_000, newInstance: false});
    expect(android.aborted).toEqual(['emulator-5556']);
    expect(android.deletedAvds).toEqual(['Test_Phone_Lease_pitbox_2']);
    expect(listCreated()).toEqual([]);
    expect(readLease('android', 'emulator-5556')).toBeUndefined();
  });

  it('says when a copy outlives its release, and a later sweep deletes it', async () => {
    Engine.AVD_LET_GO_MS = 50;
    Engine.COPY_GRACE_MS = 0;
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    await b.methods.boot({avd: 'Test_Phone_Lease'});
    // Its emulator is slow to let go of the AVD.
    android.locks.set('Test_Phone_Lease_pitbox_2', 'pid:99');
    expect(await b.methods.release({})).toMatchObject({note: expect.stringMatching(/Test_Phone_Lease_pitbox_2 not deleted yet: its emulator still runs/)});
    expect(android.avdNames).toContain('Test_Phone_Lease_pitbox_2');
    android.locks.delete('Test_Phone_Lease_pitbox_2');
    expect(await a.methods.cleanDevices({})).toEqual({deleted: ['Test_Phone_Lease_pitbox_2']});
  });

  it('lets two sessions booting one AVD at once each end up with an emulator of its own', async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    const [ra, rb] = (await Promise.all([a.methods.boot({avd: 'Test_Phone_Lease'}), b.methods.boot({avd: 'Test_Phone_Lease'})])) as {serial: string; avd: string}[];
    expect(new Set([ra!.serial, rb!.serial]).size).toBe(2);
    expect([ra!.avd, rb!.avd].sort()).toEqual(['Test_Phone_Lease', 'Test_Phone_Lease_pitbox_2']);
    expect(android.aborted).toEqual([]);
  });

  it('makes a copy beside a writable instance that is still starting or offline, never a -read-only instance', async () => {
    const android = new FakeAndroid();
    const b = await session('bob', {android});
    android.devs.push({serial: 'emulator-5554', state: 'offline', avd: 'Test_Phone_Lease', emulator: true, instance: 'pid:w'});
    expect(await b.methods.boot({avd: 'Test_Phone_Lease'})).toMatchObject({avd: 'Test_Phone_Lease_pitbox_2'});
    expect(android.bootOpts[0]).toMatchObject({newInstance: false, noSnapshot: true});
  });

  it('sweeps only copies older than the grace, never a folder made later under the same name', async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    android.avdNames.push('Test_Phone_Lease_pitbox_2', 'Test_Phone_Lease_pitbox_3');
    recordCreated('android:Test_Phone_Lease_pitbox_2', 'Test_Phone_Lease_pitbox_2', {like: 'Test_Phone_Lease', stamp: 'stamp-Test_Phone_Lease_pitbox_2'});
    recordCreated('android:Test_Phone_Lease_pitbox_3', 'Test_Phone_Lease_pitbox_3', {like: 'Test_Phone_Lease', stamp: 'an older folder'});
    // Just made: maybe booting right now.
    expect(await a.methods.cleanDevices({})).toEqual({deleted: []});
    Engine.COPY_GRACE_MS = 0;
    expect(await a.methods.cleanDevices({})).toEqual({deleted: ['Test_Phone_Lease_pitbox_2']});
    expect(android.avdNames).toEqual(['Test_Phone_Lease', 'Test_Phone_Lease_pitbox_3']);
    expect(listCreated()).toEqual([]);
  });
});

describe('push gateway through the daemon', () => {
  it("delivers only to the session's own device, and never takes a device for POST /push", async () => {
    const android = new FakeAndroid();
    const pa = await freePort();
    const pb = await freePort();
    const a = await session('alice', {android}, {mocks: {push: {port: pa}}});
    const b = await session('bob', {android}, {mocks: {push: {port: pb}}});
    try {
      await a.methods.boot({avd: 'Test_Phone_Lease'});
      await a.methods.up({});
      await b.methods.up({});
      const fcm = (port: number) =>
        fetch(`http://127.0.0.1:${port}/v1/projects/p/messages:send`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({message: {token: 't1', notification: {title: 'hi'}}})});
      // bob holds nothing: alice's emulator is not his to deliver to.
      expect((await fcm(pb)).status).toBe(503);
      // alice holds it: routed to it (whatever the fake makes of the delivery).
      expect((await fcm(pa)).status).not.toBe(503);
      // An explicit device on POST /push neither drives nor takes another session's emulator.
      const r = await fetch(`http://127.0.0.1:${pb}/push`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({device: 'emulator-5554', title: 'hi'})});
      expect(r.status).toBe(400);
      expect(((await r.json()) as {verdict: string}).verdict).toMatch(/held by "pitbox-alice-/);
      expect(readLease('android', 'emulator-5554')?.root).toMatch(/pitbox-alice-/);
      // A running emulator nobody leased is not taken by POST /push either.
      android.devs.push({serial: 'emulator-5580', state: 'device', avd: 'Other', emulator: true, instance: 'pid:x'});
      const free = await fetch(`http://127.0.0.1:${pb}/push`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({device: 'emulator-5580', title: 'hi'})});
      expect(free.status).toBe(400);
      expect(readLease('android', 'emulator-5580')).toBeUndefined();
    } finally {
      await a.stopAll({release: true});
      await b.stopAll({release: true});
    }
  });
});

describe('android driver: emulator identity', () => {
  // A stand-in adb: `devices -l` prints the list file; `emu avd discoverypath` the path file; each emu call is counted.
  const fakeAdb = (alive: Set<number> = new Set()) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-adb-'));
    const running = path.join(dir, 'running');
    fs.mkdirSync(running);
    dirs.push(dir);
    const bin = path.join(dir, 'adb');
    fs.writeFileSync(
      bin,
      `#!/bin/sh
D=${JSON.stringify(dir)}
SERIAL=""
[ "$1" = "-s" ] && SERIAL="$2" && shift 2
case "$1 $2 $3" in
  "devices -l "*) echo "List of devices attached"; cat "$D/list";;
  "emu avd name") echo emu >> "$D/calls"; echo "Test_Phone_Lease"; echo OK;;
  "emu avd discoverypath") echo emu >> "$D/calls"; cat "$D/path"; echo; grep -q '^KO' "$D/path" || echo OK;;
  "emu kill "*) echo "$SERIAL" >> "$D/kills"; echo OK;;
esac
`,
      {mode: 0o755},
    );
    const set = (list: string, where = '') => {
      fs.writeFileSync(path.join(dir, 'list'), list);
      fs.writeFileSync(path.join(dir, 'path'), where);
    };
    const calls = () => (fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').split('\n').filter(Boolean).length : 0);
    /** A discovery file, as an emulator writes it when it starts. */
    const discover = (pid: number, port: number, avd: string, opts: {readOnly?: boolean; launch?: string} = {}) => {
      alive.add(pid);
      const extra = `${opts.readOnly ? ' "-read-only"' : ''}${opts.launch ? ` "-prop" "qemu.pitbox_launch=${opts.launch}"` : ''}`;
      fs.writeFileSync(path.join(running, `pid_${pid}.ini`), `avd.id=${avd}\nport.serial=${port}\nport.adb=${port + 1}\navd.name=${avd}\ncmdline="/sdk/qemu" "-avd" "${avd}"${extra}\n`);
    };
    const kills = () => (fs.existsSync(path.join(dir, 'kills')) ? fs.readFileSync(path.join(dir, 'kills'), 'utf8').split('\n').filter(Boolean) : []);
    /** Processes killed by pid: through the driver's stand-in, never a real kill. */
    const killed: number[] = [];
    /** Start times by pid (seconds since the epoch): a pid given to another process gets another one. */
    const starts = new Map<number, number>();
    const driver = new AndroidDriver(bin, {
      runningDirs: [running],
      alive: pid => alive.has(pid),
      kill: pid => {
        killed.push(pid);
        alive.delete(pid);
      },
      start: pid => starts.get(pid) ?? 1000,
      cacheMs: 0,
    });
    return {driver, set, calls, discover, kills, alive, killed, starts};
  };
  const line = (transport: number, state = 'device') => `emulator-5554          ${state} product:sdk model:sdk_phone device:emu transport_id:${transport}\n`;

  it.skipIf(process.platform === 'win32')('takes the instance from the emulator process, asks again on a new connection and after it went offline', async () => {
    const adb = fakeAdb();
    adb.set(line(1), '/Users/x/.android/avd/running/pid_4242.ini');
    expect((await adb.driver.devices())[0]).toMatchObject({serial: 'emulator-5554', avd: 'Test_Phone_Lease', instance: 'pid:4242'});
    await adb.driver.devices();
    expect(adb.calls()).toBe(2);
    // A quickboot snapshot brings back the same boot_id; the process is new, and so is adb's connection.
    adb.set(line(2), '/Users/x/.android/avd/running/pid_5151.ini');
    expect((await adb.driver.devices())[0]?.instance).toBe('pid:5151');
    expect(adb.calls()).toBe(4);
    // Offline: no answers kept, no instance claimed; back online on the same connection, asked again.
    adb.set(line(2, 'offline'), '/Users/x/.android/avd/running/pid_6060.ini');
    expect((await adb.driver.devices())[0]).toMatchObject({state: 'offline'});
    expect((await adb.driver.devices())[0]?.instance).toBeUndefined();
    adb.set(line(2), '/Users/x/.android/avd/running/pid_6060.ini');
    expect((await adb.driver.devices())[0]?.instance).toBe('pid:6060');
  });
  it.skipIf(process.platform === 'win32')('asks again for an instance the console did not give, and keeps one it did', async () => {
    const adb = fakeAdb();
    adb.set(line(7), 'KO: unknown command');
    expect((await adb.driver.devices())[0]).toMatchObject({avd: 'Test_Phone_Lease'});
    expect((await adb.driver.devices())[0]?.instance).toBeUndefined();
    // Not asked again at once (the console is slow to answer), but after a while.
    expect(adb.calls()).toBe(2);
    adb.set(line(7), '/Users/x/.android/avd/running/pid_7070.ini');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16_000);
    try {
      expect((await adb.driver.devices())[0]?.instance).toBe('pid:7070');
      expect((await adb.driver.devices())[0]?.instance).toBe('pid:7070');
    } finally {
      clock.mockRestore();
    }
    // The name was kept: only the instance was asked again, once.
    expect(adb.calls()).toBe(3);
  });

  const launchOf = (over: Partial<Launch>): Launch => ({avd: 'Copy', t0: Date.now(), deadline: Date.now() + 3000, timeoutMs: 3000, readOnly: false, earlier: new Set(), earlierInstances: new Set(), id: 'L1', starts: new Map(), ...over});

  it.skipIf(process.platform === 'win32')('names the AVD and process of an offline emulator from its discovery file, without its console', async () => {
    const adb = fakeAdb();
    adb.set(line(3, 'offline'));
    adb.discover(4100, 5554, 'Phone');
    expect((await adb.driver.devices())[0]).toMatchObject({serial: 'emulator-5554', state: 'offline', avd: 'Phone', instance: 'pid:4100'});
    expect(adb.calls()).toBe(0);
    adb.discover(4200, 5556, 'Phone', {readOnly: true});
    expect(adb.driver.readOnly('pid:4200')).toBe(true);
    expect(adb.driver.readOnly('pid:4100')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('lets other boots go as soon as the launched emulator writes its discovery file, before adb lists it', async () => {
    const adb = fakeAdb();
    adb.set('');
    adb.discover(4100, 5554, 'Phone');
    // The launcher runs (this test process stands in for it); its emulator is not up yet. Another tool starts an
    // instance of the AVD meanwhile: not taken for this launch's, which is known by its marker.
    const l = launchOf({avd: 'Phone', pid: process.pid, earlierInstances: new Set(['pid:4100'])});
    setTimeout(() => adb.discover(4250, 5558, 'Phone'), 100);
    setTimeout(() => adb.discover(4300, 5556, 'Phone', {launch: 'L1'}), 300);
    const t0 = Date.now();
    await adb.driver.untilListed(l, 5000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(l.instance).toBe('pid:4300');
  });

  it.skipIf(process.platform === 'win32')('gives up on a launch that never shows, instead of letting it come up unaccounted for', async () => {
    const adb = fakeAdb();
    adb.set('');
    const l = launchOf({avd: 'Phone', pid: process.pid});
    await expect(adb.driver.untilListed(l, 1200)).rejects.toThrow(/did not show in 1s/);
  });

  it.skipIf(process.platform === 'win32')('never kills a pid that now belongs to another process', async () => {
    const adb = fakeAdb();
    adb.set('');
    adb.discover(5100, 5556, 'Copy', {launch: 'L1'});
    const l = launchOf({avd: 'Copy', starts: new Map([[5100, 1000]])});
    // The emulator died and the system gave its pid to a newer process.
    adb.starts.set(5100, 9000);
    await adb.driver.abort(l);
    expect(adb.killed).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('never takes the next emulator on a serial its launch gave up for its own, and never kills it', async () => {
    const adb = fakeAdb();
    // The launch's copy came up as emulator-5556 and died; another session's emulator took the port.
    adb.set('emulator-5556          device product:sdk model:sdk_phone device:emu transport_id:9\n');
    adb.discover(5200, 5556, 'Other');
    const l = launchOf({avd: 'Copy', serial: 'emulator-5556', instance: 'pid:5100', deadline: Date.now() + 2500});
    await expect(adb.driver.untilBooted(l)).rejects.toThrow(/exited/);
    await adb.driver.abort(l);
    expect(adb.kills()).toEqual([]);
    expect(adb.killed).toEqual([]);
    expect(adb.alive.has(5200)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('kills its own launch by its serial while adb shows it as its own', async () => {
    const adb = fakeAdb();
    adb.set('emulator-5556          offline transport_id:9\n');
    adb.discover(5100, 5556, 'Copy');
    const l = launchOf({avd: 'Copy', serial: 'emulator-5556', instance: 'pid:5100'});
    await adb.driver.abort(l);
    expect(adb.kills()).toEqual(['emulator-5556']);
    expect(adb.killed).toEqual([5100]);
  });
});

describe('android AVD files', () => {
  const previous = {...process.env};
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-avdhome-'));
    dirs.push(home);
    for (const k of ['ANDROID_AVD_HOME', 'ANDROID_EMULATOR_HOME', 'ANDROID_USER_HOME', 'ANDROID_PREFS_ROOT', 'ANDROID_SDK_HOME']) delete process.env[k];
  });
  afterEach(() => {
    process.env = {...previous};
  });

  it('finds the AVD home the way the emulator does', () => {
    process.env.ANDROID_SDK_HOME = path.join(home, 'sdkhome');
    expect(avdHome()).toBe(path.join(home, 'sdkhome', '.android', 'avd'));
    process.env.ANDROID_USER_HOME = path.join(home, 'user');
    expect(avdHome()).toBe(path.join(home, 'user', 'avd'));
    process.env.ANDROID_EMULATOR_HOME = path.join(home, 'emu');
    expect(avdHome()).toBe(path.join(home, 'emu', 'avd'));
    process.env.ANDROID_AVD_HOME = path.join(home, 'avds');
    expect(avdHome()).toBe(path.join(home, 'avds'));
  });

  it('reads an AVD lock as a file holding the pid (macOS, Linux) or a folder with a pid file (Windows)', () => {
    const avds = path.join(home, 'avds');
    fs.mkdirSync(path.join(avds, 'Phone.avd'), {recursive: true});
    process.env.ANDROID_AVD_HOME = avds;
    fs.writeFileSync(path.join(avds, 'Phone.ini'), `path=${path.join(avds, 'Phone.avd')}\n`);
    const lock = path.join(avds, 'Phone.avd', 'hardware-qemu.ini.lock');
    expect(lockPid('Phone')).toBeUndefined();
    fs.writeFileSync(lock, '33417 ');
    expect(lockPid('Phone')).toBe(33417);
    fs.rmSync(lock);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), '4242');
    expect(lockPid('Phone')).toBe(4242);
    // This test's own process holds no emulator: the lock does not count.
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    expect(avdLocked('Phone')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('kills a process by pid', async () => {
    const child = spawn('sleep', ['30'], {stdio: 'ignore'});
    const gone = new Promise(r => child.on('exit', r));
    killTree(child.pid!);
    await gone;
    expect(child.signalCode).toBe('SIGTERM');
  });

  it('tells a path inside a folder by whole parts, and without case on Windows', () => {
    expect(insideFolder('/a/Phone.avd/sdcard.img', '/a/Phone.avd', false)).toBe(true);
    expect(insideFolder('/a/Phone.avd', '/a/Phone.avd', false)).toBe(true);
    expect(insideFolder('/a/Phone.avd2/sdcard.img', '/a/Phone.avd', false)).toBe(false);
    expect(insideFolder('/a/phone.avd/sdcard.img', '/a/Phone.avd', false)).toBe(false);
    expect(insideFolder('system-images/x/', '/a/Phone.avd', false)).toBe(false);
    expect(insideFolder('C:\\Users\\me\\.android\\avd\\phone.AVD\\sdcard.img', 'C:\\Users\\Me\\.android\\avd\\Phone.avd', true)).toBe(true);
    expect(insideFolder('C:\\Users\\me\\.android\\avd\\Phone.avd2\\x', 'C:\\Users\\me\\.android\\avd\\Phone.avd', true)).toBe(false);
  });

  it('copies an AVD from where its pointer says, never pointing back into it, and deletes only the copy', () => {
    const avds = path.join(home, 'avds');
    const elsewhere = path.join(home, 'disk2', 'Phone.avd');
    fs.mkdirSync(avds, {recursive: true});
    fs.mkdirSync(elsewhere, {recursive: true});
    process.env.ANDROID_AVD_HOME = avds;
    fs.writeFileSync(path.join(avds, 'Phone.ini'), `avd.ini.encoding=UTF-8\npath=${elsewhere}\npath.rel=avd/Phone.avd\ntarget=android-36\n`);
    fs.writeFileSync(
      path.join(elsewhere, 'config.ini'),
      `AvdId=Phone\navd.ini.displayname=Phone\nimage.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\nsdcard.path=${path.join(elsewhere, 'sdcard.img')}\nhw.lcd.density=420\n`,
    );
    // A folder left without its pointer still takes the name.
    fs.mkdirSync(path.join(avds, 'Phone_pitbox_2.avd'));
    expect(avdTaken('Phone_pitbox_2')).toBe(true);
    createAvdLike('Phone', 'Phone_pitbox_3');
    const config = fs.readFileSync(path.join(avds, 'Phone_pitbox_3.avd', 'config.ini'), 'utf8');
    expect(config).toContain('AvdId=Phone_pitbox_3');
    expect(config).toContain('image.sysdir.1=system-images/android-36/');
    expect(config).toContain('hw.lcd.density=420');
    expect(config).not.toContain(elsewhere);
    expect(fs.readFileSync(path.join(avds, 'Phone_pitbox_3.ini'), 'utf8')).toContain(`path=${path.join(avds, 'Phone_pitbox_3.avd')}`);
    expect(avdDir('Phone')).toBe(elsewhere);
    expect(avdStamp('Phone_pitbox_3')).toMatch(/^\d+:\d+$/);
    expect(() => createAvdLike('Phone', 'Phone_pitbox_3')).toThrow(/exists already/);
    deleteAvd('Phone_pitbox_3');
    expect(fs.readdirSync(avds).sort()).toEqual(['Phone.ini', 'Phone_pitbox_2.avd']);
    expect(fs.existsSync(path.join(elsewhere, 'config.ini'))).toBe(true);
  });
});

