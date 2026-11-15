// The Wear OS Data Layer stand-in (drivers/android/wearRelay.ts) against a fake adb: what pairing sends each app,
// the requests apps make over the daemon's socket (nodes, sends routed to the paired node only, the size limit),
// and through the daemon's methods: which watch a session pairs, that a watch of another session or another app is
// refused, and what unpair and a release undo.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Engine} from './daemon/engine.ts';
import type {AndroidDevice} from './drivers/android/driver.ts';
import {DATA_TOO_LARGE, isBase64, nodeId, parseProbe, TARGET_NODE_NOT_CONNECTED, WEAR_RECEIVER, WearRelay} from './drivers/android/wearRelay.ts';
import {leaseDir, readLease} from './lease/lease.ts';

/** adb as the relay sees it: one app with pitbox's wear receiver per device, unless taken away. */
class FakeAdb {
  calls: {serial: string; command: string}[] = [];
  /** serial → the probe the receiver answers; absent: no receiver. */
  probes = new Map<string, string>();
  installed = new Set<string>();
  /** serial → answer to `op message`. */
  delivered = new Map<string, string>();
  /** Devices whose app refuses `op pair`. */
  failPair = new Set<string>();

  shell = async (serial: string, command: string) => {
    this.calls.push({serial, command});
    if (command.startsWith('pm path')) return this.installed.has(serial) ? 'package:/data/app/base.apk\n' : '';
    const op = /--es op (\w+)/.exec(command)?.[1];
    if (!command.includes(WEAR_RECEIVER)) return '';
    const probe = this.probes.get(serial);
    if (probe === undefined) return 'Broadcasting: Intent\nBroadcast completed: result=0\n';
    if (op === 'pair' && this.failPair.has(serial)) return 'Broadcast completed: result=2, data="error bad-pair"\n';
    const data = op === 'probe' ? probe : op === 'pair' ? 'ok paired node=x' : op === 'unpair' ? 'ok unpaired' : (this.delivered.get(serial) ?? 'ok accepted');
    return `Broadcasting: Intent\nBroadcast completed: result=${data.startsWith('ok') ? 1 : 2}, data="${data}"\n`;
  };

  ops = (serial: string) => this.calls.filter(c => c.serial === serial && c.command.includes(WEAR_RECEIVER)).map(c => /--es op (\w+)/.exec(c.command)?.[1]);
}

const PROBE = 'ok paired=false internet=true services=PingService capabilities=example_cap cert=0123456789abcdef sdk=36';

const ask = (port: number, req: object): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`${JSON.stringify(req)}\n`));
    let buf = '';
    s.on('data', d => (buf += d.toString()));
    s.on('end', () => resolve(JSON.parse(buf) as Record<string, unknown>));
    s.on('error', reject);
  });

describe('wear relay', () => {
  it('reads the receiver probe', () => {
    expect(parseProbe(PROBE)).toEqual({paired: false, internet: true, services: ['PingService'], capabilities: ['example_cap'], cert: '0123456789abcdef', sdk: 36});
    expect(parseProbe('ok paired=true internet=false services=- capabilities=- cert=- sdk=30')).toEqual({paired: true, internet: false, services: [], capabilities: [], sdk: 30});
  });

  it('pairs both apps with a token, a node and the port, and answers nodes with the peer and its capabilities', async () => {
    const adb = new FakeAdb();
    adb.probes.set('emulator-5554', PROBE).set('emulator-5556', PROBE.replace('example_cap', '-'));
    const relay = new WearRelay(adb.shell);
    try {
      const {pair, warnings} = await relay.pair('com.example.app', {serial: 'emulator-5554', name: 'Phone'}, {serial: 'emulator-5556', name: 'Watch'});
      expect(warnings).toEqual([]);
      expect(pair.phone.node).toBe(nodeId('Phone', 'com.example.app'));
      expect(pair.phone.token).not.toBe(pair.watch.token);
      const pairCall = adb.calls.find(c => c.serial === 'emulator-5556' && c.command.includes('--es op pair'))!.command;
      expect(pairCall).toContain(`--es token ${pair.watch.token}`);
      expect(pairCall).toContain('--es host 10.0.2.2');
      const port = Number(/--es port (\d+)/.exec(pairCall)![1]);
      // The watch asks who is connected: the phone, with the capability its app declares.
      expect(await ask(port, {token: pair.watch.token, op: 'nodes'})).toEqual({ok: true, nodes: [{id: pair.phone.node, name: 'Phone', capabilities: ['example_cap']}]});
      expect(await ask(port, {token: 'nope', op: 'nodes'})).toMatchObject({ok: false, code: TARGET_NODE_NOT_CONNECTED});
    } finally {
      await relay.close();
    }
  });

  it('routes a send to the paired node only: the device gets the id alone and fetches the message, then reports', async () => {
    const adb = new FakeAdb();
    adb.probes.set('emulator-5554', PROBE).set('emulator-5556', PROBE);
    const relay = new WearRelay(adb.shell, {listen: false});
    const {pair} = await relay.pair('com.example.app', {serial: 'emulator-5554', name: 'Phone'}, {serial: 'emulator-5556', name: 'Watch'});
    const data = Buffer.from('hi').toString('base64');
    expect(await relay.handle({token: pair.watch.token, op: 'send', node: pair.phone.node, path: "/it's; reboot", data})).toEqual({ok: true, id: 1});
    const sent = adb.calls.at(-1)!;
    expect(sent.serial).toBe('emulator-5554');
    // Nothing the app sent is on the command line: only the op and a number. Stopped packages included, no foreground.
    expect(sent.command).toBe(`am broadcast -f 0x20 -n com.example.app/${WEAR_RECEIVER} --es op message --es id 1`);
    // Only the device it is for may fetch it.
    expect(await relay.handle({token: pair.watch.token, op: 'take', id: 1})).toMatchObject({ok: false});
    expect(await relay.handle({token: pair.phone.token, op: 'take', id: 1})).toEqual({ok: true, source: pair.watch.node, path: "/it's; reboot", data});
    expect(await relay.handle({token: pair.phone.token, op: 'delivered', id: 1, result: 'listeners=1 services=PingService'})).toEqual({ok: true});
    expect(pair.log).toEqual(["watch→phone /it's; reboot 2B: listeners=1 services=PingService"]);
    expect(await relay.handle({token: pair.watch.token, op: 'send', node: 'deadbeef', path: '/x', data})).toMatchObject({ok: false, code: TARGET_NODE_NOT_CONNECTED});
    expect(await relay.handle({token: pair.watch.token, op: 'send', node: pair.phone.node, path: '/x', data: Buffer.alloc(100 * 1024 + 1).toString('base64')})).toMatchObject({ok: false, code: DATA_TOO_LARGE});
    // A message at the limit fits: it never travels on a command line.
    expect(await relay.handle({token: pair.watch.token, op: 'send', node: pair.phone.node, path: '/x', data: Buffer.alloc(100 * 1024).toString('base64')})).toMatchObject({ok: true});
  });

  it('refuses data that is not base64 before anything reaches the device shell', async () => {
    const adb = new FakeAdb();
    adb.probes.set('emulator-5554', PROBE).set('emulator-5556', PROBE);
    const relay = new WearRelay(adb.shell, {listen: false});
    const {pair} = await relay.pair('com.example.app', {serial: 'emulator-5554', name: 'Phone'}, {serial: 'emulator-5556', name: 'Watch'});
    const before = adb.calls.length;
    for (const data of ['AA;pm uninstall com.example.app', 'AA==$(reboot)', "AA'", 'A B=', 'AAA']) {
      expect(await relay.handle({token: pair.watch.token, op: 'send', node: pair.phone.node, path: '/x', data})).toMatchObject({ok: false, code: 13});
    }
    expect(adb.calls.length).toBe(before);
    expect(isBase64('')).toBe(true);
    expect(isBase64('aGk=')).toBe(true);
  });

  it('fails a send the other device did not take with 4000, whatever the cause', async () => {
    const adb = new FakeAdb();
    adb.probes.set('emulator-5554', PROBE).set('emulator-5556', PROBE);
    const relay = new WearRelay(adb.shell, {listen: false});
    const {pair} = await relay.pair('com.example.app', {serial: 'emulator-5554', name: 'Phone'}, {serial: 'emulator-5556', name: 'Watch'});
    const send = () => relay.handle({token: pair.watch.token, op: 'send', node: pair.phone.node, path: '/x', data: ''});
    adb.delivered.set('emulator-5554', 'error not-paired');
    expect(await send()).toMatchObject({ok: false, code: TARGET_NODE_NOT_CONNECTED, error: expect.stringMatching(/not paired/)});
    expect(pair.log.at(-1)).toContain('not delivered (not-paired)');
    // The device went away: adb fails.
    const shell = adb.shell;
    adb.shell = async (serial, command) => {
      if (command.includes('op message')) throw new Error("adb: device 'emulator-5554' not found");
      return shell(serial, command);
    };
    const gone = new WearRelay(adb.shell, {listen: false});
    const p2 = (await gone.pair('com.example.app', {serial: 'emulator-5554', name: 'Phone'}, {serial: 'emulator-5556', name: 'Watch'})).pair;
    expect(await gone.handle({token: p2.watch.token, op: 'send', node: p2.phone.node, path: '/x', data: ''})).toMatchObject({ok: false, code: TARGET_NODE_NOT_CONNECTED, error: expect.stringMatching(/not found/)});
  });

  it('pairs a side again with its own token, and forgets both on unpair', async () => {
    const adb = new FakeAdb();
    adb.probes.set('emulator-5554', PROBE).set('emulator-5556', PROBE);
    const relay = new WearRelay(adb.shell, {listen: false});
    const {pair} = await relay.pair('com.example.app', {serial: 'emulator-5554', name: 'Phone'}, {serial: 'emulator-5556', name: 'Watch'});
    expect(await relay.repair('emulator-5556')).toBe(true);
    expect(adb.calls.at(-1)!.command).toContain(`--es token ${pair.watch.token}`);
    await relay.unpair(pair.id);
    expect(adb.ops('emulator-5554').at(-1)).toBe('unpair');
    expect(adb.ops('emulator-5556').at(-1)).toBe('unpair');
    expect(relay.pairOf('emulator-5554')).toBeUndefined();
    expect(await relay.handle({token: pair.phone.token, op: 'nodes'})).toMatchObject({ok: false});
    expect(await relay.repair('emulator-5556')).toBe(false);
  });

  it('says why an app cannot be paired, and what would make a real Data Layer refuse', async () => {
    const adb = new FakeAdb();
    const relay = new WearRelay(adb.shell, {listen: false});
    await expect(relay.pair('com.example.app', {serial: 'emulator-5554', name: 'P'}, {serial: 'emulator-5556', name: 'W'})).rejects.toThrow(/not installed on emulator-5554/);
    adb.installed.add('emulator-5554');
    await expect(relay.probe('emulator-5554', 'com.example.app')).rejects.toThrow(/no pitbox wear receiver/);
    await expect(relay.probe('emulator-5554', 'com.example.app; reboot')).rejects.toThrow(/not an Android package/);
    adb.probes.set('emulator-5554', PROBE).set('emulator-5556', 'ok paired=false internet=false services=- capabilities=- cert=fedcba9876543210 sdk=36');
    const {warnings} = await relay.pair('com.example.app', {serial: 'emulator-5554', name: 'P'}, {serial: 'emulator-5556', name: 'W'});
    expect(warnings.join('\n')).toMatch(/watch lacks the INTERNET permission/);
    expect(warnings.join('\n')).toMatch(/watch declares no WearableListenerService/);
    expect(warnings.join('\n')).toMatch(/signed with different keys/);
  });
});

/** The Android driver the daemon's methods use, with the relay's adb underneath. */
class FakeAndroid {
  adbPath = 'adb';
  adb = new FakeAdb();
  devs: AndroidDevice[] = [
    {serial: 'emulator-5554', state: 'device', avd: 'Phone_A', kind: 'phone', emulator: true, instance: 'pid:1'},
    {serial: 'emulator-5556', state: 'device', avd: 'Watch_A', kind: 'wear', emulator: true, instance: 'pid:2'},
  ];

  devices = async () => this.devs.map(d => ({...d}));
  avds = () => this.devs.map(d => ({name: d.avd!, kind: d.kind!}));
  running = () => [];
  resolve = async (sel?: string) => {
    const hit = this.devs.filter(d => !sel || d.serial === sel || d.avd === sel);
    if (hit.length !== 1) throw new Error(`no online device matches "${sel ?? ''}"`);
    return hit[0]!.serial;
  };
  shell = (serial: string, command: string) => this.adb.shell(serial, command);
  shutdown = async (serial: string) => {
    this.devs = this.devs.filter(d => d.serial !== serial);
    return {ms: 1, gone: true};
  };
  stopped: string[] = [];
  stop = async (serial: string, pkg: string) => void this.stopped.push(`${serial} ${pkg}`);
  reverseList = async () => [];
  reverse = async (_s: string, ports: number[]) => ports;
}

const dirs: string[] = [];
const engines: Engine[] = [];
const session = async (name: string, android: FakeAndroid, app: Record<string, unknown> = {android: 'com.example.app'}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pitbox-${name}-`));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({app}));
  const e = await Engine.create(path.join(dir, 'pitbox.config.json'), undefined, {android: android as never, apple: null});
  engines.push(e);
  return e;
};

beforeEach(() => fs.rmSync(leaseDir(), {recursive: true, force: true}));
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stopAll();
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

describe('wear pairs through the daemon', () => {
  it("pairs the session's wear emulator with its phone, answers the pair again, and unpair gives the watch back", async () => {
    const android = new FakeAndroid();
    android.adb.probes.set('emulator-5554', PROBE).set('emulator-5556', PROBE);
    const a = await session('alice', android);
    await a.methods.lease({device: 'emulator-5554'});
    await a.methods.lease({device: 'emulator-5556'});
    const r = await a.methods.pair({value: 'watch'});
    expect(r).toMatchObject({watch: 'Watch_A', serial: 'emulator-5556', phone: 'Phone_A', app: 'com.example.app'});
    expect(readLease('android', 'emulator-5556')).toMatchObject({pairedWith: 'emulator-5554'});
    expect(await a.methods.pair({value: 'watch'})).toMatchObject({already: true, messages: 0});
    expect(await a.methods.unpair({value: 'watch'})).toMatchObject({unpaired: 'Watch_A', done: ['unpaired Watch_A'], released: 'Watch_A'});
    expect(android.adb.ops('emulator-5554').at(-1)).toBe('unpair');
    expect(readLease('android', 'emulator-5556')).toBeUndefined();
    expect(readLease('android', 'emulator-5554')).toBeDefined();
  });

  it('a release of the phone unpairs and gives back the watch paired for it', async () => {
    const android = new FakeAndroid();
    android.adb.probes.set('emulator-5554', PROBE).set('emulator-5556', PROBE);
    const a = await session('alice', android);
    await a.methods.lease({device: 'emulator-5554'});
    await a.methods.lease({device: 'emulator-5556'});
    await a.methods.pair({value: 'watch', device: 'emulator-5554'});
    expect(await a.methods.release({device: 'emulator-5554'})).toMatchObject({paired: ['unpaired Watch_A', 'released Watch_A']});
    expect(android.adb.ops('emulator-5556').at(-1)).toBe('unpair');
    expect(readLease('android', 'emulator-5556')).toBeUndefined();
  });

  it("never pairs another session's watch, nor a watch app of another package", async () => {
    const android = new FakeAndroid();
    android.adb.probes.set('emulator-5554', PROBE).set('emulator-5556', PROBE);
    const bob = await session('bob', android);
    await bob.methods.lease({device: 'emulator-5556'});
    const a = await session('alice', android);
    await a.methods.lease({device: 'emulator-5554'});
    await expect(a.methods.pair({value: 'watch', watch: 'emulator-5556'})).rejects.toThrow(/no AVD or emulator of this session/);
    expect(android.adb.calls).toEqual([]);
  });

  it('refuses a watch app of another package: the Data Layer joins an app only with itself', async () => {
    const android = new FakeAndroid();
    android.adb.probes.set('emulator-5554', PROBE).set('emulator-5556', PROBE);
    const c = await session('carol', android, {android: 'com.example.app', watch: {android: 'com.example.app.watch'}});
    await c.methods.lease({device: 'emulator-5554'});
    await c.methods.lease({device: 'emulator-5556'});
    await expect(c.methods.pair({value: 'watch', device: 'emulator-5554'})).rejects.toThrow(/differ/);
    expect(android.adb.calls).toEqual([]);
    // On a Wear OS device a call without a package means the watch app (app.watch.android), on the phone app.android.
    await c.methods.stopApp({device: 'emulator-5556'});
    await c.methods.stopApp({device: 'emulator-5554'});
    expect(android.stopped).toEqual(['emulator-5556 com.example.app.watch', 'emulator-5554 com.example.app']);
  });
});
