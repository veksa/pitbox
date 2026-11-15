// Apple Watch pairing through the daemon's methods, against a fake simctl: which watch a session takes (never one
// paired to another phone or held by another session), the clone when none is free, the pair kept idempotent, and
// what goes back on unpair, release and `devices clean` — only the pairs and watches pitbox made.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Engine} from './daemon/engine.ts';
import {parsePairs, type Simulator, type WatchPair} from './drivers/apple/driver.ts';
import {isCreated, listCreated} from './lease/created.ts';
import {acquire, leaseDir, readLease} from './lease/lease.ts';
import {leaseWarnings} from './lease/reap.ts';

class FakeSimctl {
  sims: Simulator[];
  pairList: WatchPair[] = [];
  deleted: string[] = [];
  unpaired: string[] = [];
  /** pair_activate hangs (CoreSimulator could not switch the phone). */
  hang = false;
  #n = 0;

  constructor(sims: Partial<Simulator>[]) {
    this.sims = sims.map((s, i) => ({udid: `U${i + 1}`, name: 'iPhone 17', state: 'Shutdown', runtime: 'iOS-27-2', os: 'iOS 27.2', kind: 'phone', available: true, deviceType: 'iPhone-17', ...s}));
  }

  #sim = (udid: string) => this.sims.find(x => x.udid === udid)!;
  #side = (udid: string) => ({udid, name: this.#sim(udid).name, state: this.#sim(udid).state});
  #refresh() {
    for (const p of this.pairList) {
      p.watch = this.#side(p.watch.udid);
      p.phone = this.#side(p.phone.udid);
      p.connected = p.active && p.watch.state === 'Booted' && p.phone.state === 'Booted';
    }
  }

  bootMarks = async () => new Map(this.sims.filter(s => s.state === 'Booted').map(s => [s.udid, `launchd_sim:${s.udid.length}@1700000000`]));
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
    this.#sim(udid).state = 'Shutdown';
    return {ms: 1, gone: true};
  };
  createLike = async (like: Simulator, name: string) => {
    const s = {...like, udid: `NEW${this.sims.length + 1}`, name, state: 'Shutdown'};
    this.sims.push(s);
    return {...s};
  };
  delete = async (udid: string) => {
    this.sims = this.sims.filter(x => x.udid !== udid);
    this.pairList = this.pairList.filter(p => p.watch.udid !== udid && p.phone.udid !== udid);
    this.deleted.push(udid);
  };
  stop = async () => undefined;
  packages = async () => ['com.example.app'];
  pairs = async () => {
    this.#refresh();
    return this.pairList.map(p => ({...p, watch: {...p.watch}, phone: {...p.phone}}));
  };
  pair = async (watch: string, phone: string) => {
    if (this.pairList.some(p => p.watch.udid === watch)) throw new Error('watch already paired');
    const id = `0000000${++this.#n}-0000-0000-0000-000000000000`;
    // A phone's first pair is active at once.
    this.pairList.push({id, watch: this.#side(watch), phone: this.#side(phone), active: !this.pairList.some(p => p.phone.udid === phone), connected: false});
    return id;
  };
  activatePair = async (id: string) => {
    if (this.hang) throw new Error('simctl pair_activate did not answer in 45s');
    const p = this.pairList.find(x => x.id === id)!;
    for (const q of this.pairList) if (q.phone.udid === p.phone.udid) q.active = q.id === id;
  };
  unpair = async (id: string) => {
    this.pairList = this.pairList.filter(p => p.id !== id);
    this.unpaired.push(id);
  };
  /** A pair made by someone else (another session, by hand). */
  pairedElsewhere(watch: string, phone: string) {
    this.pairList.push({id: `ffffffff-0000-0000-0000-00000000000${this.pairList.length}`, watch: this.#side(watch), phone: this.#side(phone), active: true, connected: false});
  }
}

const watch = (udid: string, name = 'Apple Watch Series 11 (46mm)', extra: Partial<Simulator> = {}): Partial<Simulator> => ({udid, name, kind: 'watch', runtime: 'watchOS-27-2', os: 'watchOS 27.2', deviceType: 'Watch-11-46', ...extra});

const dirs: string[] = [];
const session = async (name: string, s: FakeSimctl, config: Record<string, unknown> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pitbox-${name}-`));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({app: {apple: 'com.example.app', watch: {apple: 'com.example.app.watchkitapp'}}, apple: {watch: 'Apple Watch Series 11 (46mm)'}, ...config}));
  return Engine.create(path.join(dir, 'pitbox.config.json'), undefined, {android: null, apple: s as never});
};

beforeEach(() => {
  Engine.PAIR_CONNECT_MS = 50;
  fs.rmSync(leaseDir(), {recursive: true, force: true});
  fs.rmSync(path.join(path.dirname(leaseDir()), 'created-simulators.json'), {force: true});
});
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

describe('watch pairs', () => {
  it('reads simctl list pairs', () => {
    const json = JSON.stringify({pairs: {P1: {watch: {name: 'W', udid: 'W1', state: 'Booted'}, phone: {name: 'P', udid: 'U1', state: 'Booted'}, state: '(active, connected)'}, P2: {watch: {name: 'W2', udid: 'W2', state: 'Shutdown'}, phone: {name: 'P', udid: 'U1', state: 'Booted'}, state: '(inactive, disconnected)'}}});
    expect(parsePairs(json)).toEqual([
      {id: 'P1', watch: {udid: 'W1', name: 'W', state: 'Booted'}, phone: {udid: 'U1', name: 'P', state: 'Booted'}, active: true, connected: true},
      {id: 'P2', watch: {udid: 'W2', name: 'W2', state: 'Shutdown'}, phone: {udid: 'U1', name: 'P', state: 'Booted'}, active: false, connected: false},
    ]);
  });

  it("pairs the configured watch with the session's phone, leases both, answers the same pair again, and undoes it", async () => {
    const s = new FakeSimctl([{}, watch('W1')]);
    const a = await session('alice', s);
    await a.methods.boot({avd: 'iPhone 17'});
    const r = await a.methods.pair({value: 'watch'});
    expect(r).toMatchObject({watch: 'Apple Watch Series 11 (46mm)', udid: 'W1', phone: 'iPhone 17', state: 'active, connected'});
    expect(readLease('apple', 'W1')).toMatchObject({booted: true, pairedWith: 'U1'});
    expect(await a.methods.pair({value: 'watch'})).toMatchObject({udid: 'W1', already: true});
    expect(s.pairList).toHaveLength(1);
    // A call with no device means the phone; `watch` names the watch.
    expect(await a.methods.apps({})).toBeTruthy();
    expect(leaseWarnings([readLease('apple', 'U1')!, readLease('apple', 'W1')!])).toEqual([]);
    const u = await a.methods.unpair({value: 'watch'});
    expect(u).toMatchObject({unpaired: 'W1', released: 'Apple Watch Series 11 (46mm)'});
    expect(s.pairList).toEqual([]);
    expect(readLease('apple', 'W1')).toBeUndefined();
    expect(s.sims.find(x => x.udid === 'W1')?.state).toBe('Shutdown');
    expect(readLease('apple', 'U1')).toBeDefined();
    expect(listCreated()).toEqual([]);
  });

  it('never takes a watch paired to another phone or held by another session: it clones one, and the release deletes it', async () => {
    // W1 is in someone's pair (shut down, as others' pairs often are); W2 is held by another session.
    const s = new FakeSimctl([{}, {udid: 'U2', name: 'iPhone Air'}, watch('W1'), watch('W2')]);
    s.pairedElsewhere('W1', 'U2');
    acquire('apple', 'W2', {owner: 'daemon:/elsewhere', label: 'bob', pid: process.pid}, {});
    const a = await session('alice', s);
    await a.methods.boot({avd: 'iPhone 17'});
    const r = await a.methods.pair({value: 'watch'});
    expect(r).toMatchObject({watch: 'Apple Watch Series 11 (46mm) (pitbox 2)', created: true});
    const clone = (r as {udid: string}).udid;
    expect(isCreated(clone)).toBe(true);
    // Releasing the phone takes the watch paired for it along: the pair goes, the clone is deleted.
    await a.methods.release({});
    expect(s.deleted).toEqual([clone]);
    expect(s.pairList.map(p => p.watch.udid)).toEqual(['W1']);
    expect(readLease('apple', 'W2')?.label).toBe('bob');
    expect(listCreated()).toEqual([]);
  });

  it("keeps a pair the phone already had with a free watch: only the watch goes back", async () => {
    const s = new FakeSimctl([{}, watch('W1')]);
    s.pairedElsewhere('W1', 'U1');
    const a = await session('alice', s);
    await a.methods.boot({avd: 'iPhone 17'});
    expect(await a.methods.pair({value: 'watch'})).toMatchObject({udid: 'W1'});
    await a.methods.unpair({value: 'watch'});
    expect(s.pairList).toHaveLength(1);
    expect(s.unpaired).toEqual([]);
  });

  it("unpairs only a watch this session paired", async () => {
    const s = new FakeSimctl([{}, watch('W1'), {udid: 'U3', name: 'iPhone Air'}, watch('W3')]);
    const b = await session('bob', s);
    await b.methods.boot({avd: 'iPhone Air'});
    await b.methods.pair({value: 'watch', watch: 'W3'});
    const a = await session('alice', s);
    await a.methods.boot({avd: 'iPhone 17'});
    await a.methods.pair({value: 'watch', watch: 'W1'});
    // Bob's pair, made by pitbox, is not Alice's to undo.
    await expect(a.methods.unpair({value: 'watch', device: 'W3'})).rejects.toThrow(/not a watch this session paired/);
    expect(s.pairList.map(p => p.watch.udid).sort()).toEqual(['W1', 'W3']);
    expect(readLease('apple', 'W3')?.pairedWith).toBe('U3');
  });

  it('rolls back a pair that would not activate', async () => {
    const s = new FakeSimctl([{}, watch('W1'), watch('W2')]);
    s.pairedElsewhere('W2', 'U1');
    s.pairList[0]!.active = true;
    s.hang = true;
    const a = await session('alice', s);
    await a.methods.boot({avd: 'iPhone 17'});
    await expect(a.methods.pair({value: 'watch', watch: 'W1'})).rejects.toThrow(/did not answer/);
    expect(s.pairList.map(p => p.watch.udid)).toEqual(['W2']);
    expect(readLease('apple', 'W1')).toBeUndefined();
    expect(listCreated()).toEqual([]);
  });

  it('refuses a phone that is not an iPhone and names the watches when the named one does not exist', async () => {
    const s = new FakeSimctl([{name: 'Apple TV', kind: 'tv', deviceType: 'tv'}, watch('W1')]);
    const a = await session('alice', s, {apple: {watch: 'Apple Watch Ultra'}});
    await a.methods.boot({avd: 'Apple TV'});
    await expect(a.methods.pair({value: 'watch'})).rejects.toThrow(/not an iPhone/);
    const p = new FakeSimctl([{}, watch('W1')]);
    const b = await session('bob', p, {apple: {watch: 'Apple Watch Ultra'}});
    await b.methods.boot({avd: 'iPhone 17'});
    await expect(b.methods.pair({value: 'watch'})).rejects.toThrow(/no watch simulator "Apple Watch Ultra"[\s\S]*Series 11/);
  });

  it('unpairs, on devices clean, a pair pitbox made whose session is gone, and leaves the others', async () => {
    const s = new FakeSimctl([{}, watch('W1'), watch('W2'), {udid: 'U3', name: 'iPhone Air'}]);
    s.pairedElsewhere('W2', 'U3');
    const a = await session('alice', s);
    await a.methods.boot({avd: 'iPhone 17'});
    await a.methods.pair({value: 'watch'});
    // The session dies without giving anything back: its leases go, the pair stays.
    fs.rmSync(leaseDir(), {recursive: true, force: true});
    const b = await session('bob', s);
    expect(await b.methods.cleanDevices({})).toMatchObject({unpaired: 1});
    expect(s.pairList.map(p => p.watch.udid)).toEqual(['W2']);
    expect(listCreated()).toEqual([]);
  });

  it("takes the watch app on the watch", async () => {
    const s = new FakeSimctl([{}, watch('W1')]);
    const stopped: string[] = [];
    s.stop = async (_u: string, b: string) => void stopped.push(b);
    const a = await session('alice', s);
    await a.methods.boot({avd: 'iPhone 17'});
    await a.methods.pair({value: 'watch'});
    await a.methods.stopApp({device: 'watch'});
    await a.methods.stopApp({});
    expect(stopped).toEqual(['com.example.app.watchkitapp', 'com.example.app']);
  });
});
