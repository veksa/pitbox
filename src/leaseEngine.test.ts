// Device leases through the daemon's methods, against fake drivers: which calls take a device and which only look,
// what `force` may do, the boot paths (a free simulator, a twin, a new simulator, a second emulator instance), a
// reused emulator serial, and the push gateway's routing. Leases live in a temporary PITBOX_HOME (src/test-setup.ts).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Engine} from './daemon/engine.ts';
import type {AndroidDevice} from './drivers/android/driver.ts';
import type {Simulator} from './drivers/apple/driver.ts';
import {leaseDir, readLease} from './lease/lease.ts';
import {PushCenter} from './push/push.ts';

type Sim = Simulator;

class FakeApple {
  sims: Sim[];
  deleted: string[] = [];
  stopped: string[] = [];

  constructor(sims: Partial<Sim>[]) {
    this.sims = sims.map((s, i) => ({udid: `U${i + 1}`, name: 'iPhone 17', state: 'Shutdown', runtime: 'iOS-27-2', os: 'iOS 27.2', kind: 'phone', available: true, deviceType: 'iPhone-17', ...s}));
  }

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
    return {udid: s.udid, name: s.name, ms: 1, already};
  };
  shutdown = async (udid: string) => {
    this.sims.find(x => x.udid === udid)!.state = 'Shutdown';
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
  #boots = 0;

  devices = async () => this.devs.map(d => ({...d}));
  avds = () => [{name: 'Test_Phone_Lease', kind: 'phone'}];
  resolve = async (sel?: string) => {
    const hit = this.devs.filter(d => !sel || d.serial === sel || d.avd === sel);
    if (hit.length !== 1) throw new Error(`no online device matches "${sel ?? ''}"`);
    return hit[0]!.serial;
  };
  /** A new emulator takes the lowest free port, as the emulator does: a serial comes back after a shutdown. */
  boot = async (avd: string, opts: Record<string, unknown>) => {
    this.bootOpts.push(opts);
    let port = 5554;
    while (this.devs.some(d => d.serial === `emulator-${port}`)) port += 2;
    const serial = `emulator-${port}`;
    this.devs.push({serial, state: 'device', avd, emulator: true, bootId: `boot-${++this.#boots}`});
    return {serial, ms: 1, already: false, ...(opts.newInstance ? {readOnly: true} : {})};
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
const session = async (name: string, drivers: {android?: FakeAndroid | null; apple?: FakeApple | null}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pitbox-${name}-`));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({app: {android: 'com.example.app', apple: 'com.example.app'}}));
  return Engine.create(path.join(dir, 'pitbox.config.json'), undefined, {android: (drivers.android ?? null) as never, apple: (drivers.apple ?? null) as never});
};

beforeEach(() => fs.rmSync(leaseDir(), {recursive: true, force: true}));
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
  it('starts a second instance beside one another session holds, and never drives it', async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    expect(await a.methods.boot({avd: 'Test_Phone_Lease'})).toMatchObject({serial: 'emulator-5554', already: false});
    const r = (await b.methods.boot({avd: 'Test_Phone_Lease'})) as {serial: string; instead: string; note: string};
    expect(android.bootOpts.map(o => o.newInstance)).toEqual([false, true]);
    expect(r.serial).toBe('emulator-5556');
    expect(r.instead).toMatch(/^Test_Phone_Lease runs for "pitbox-alice-.*\); started another instance/);
    expect(r.note).toMatch(/-read-only/);
    expect(await b.methods.stopApp({})).toEqual({serial: 'emulator-5556'});
    await expect(b.methods.stopApp({device: 'emulator-5554'})).rejects.toThrow(/held by "pitbox-alice-/);
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

  it('lists who holds each device', async () => {
    const android = new FakeAndroid();
    const a = await session('alice', {android});
    const b = await session('bob', {android});
    await a.methods.boot({avd: 'Test_Phone_Lease'});
    android.devs.push({serial: 'emulator-5580', state: 'device', avd: 'Other', emulator: true, bootId: 'x'});
    const r = (await b.methods.devices({})) as {devices: {serial: string; holder?: string}[]};
    expect(r.devices.map(d => `${d.serial} ${d.holder}`)).toEqual([expect.stringMatching(/^emulator-5554 held by "pitbox-alice-/), 'emulator-5580 running, unleased']);
  });
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
