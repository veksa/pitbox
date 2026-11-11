// Device leases: acquire, races between processes, stale holders, release, the daemon's choice of a device, refusals,
// and the machine check before a boot. Everything runs in a temporary PITBOX_HOME: no real lease of this machine is
// read or touched.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {DeviceLeases, sessionLabel} from './lease/devices.ts';
import {acquire, DEAD_GRACE_MS, heartbeat, leaseDir, listLeases, parseDuration, readLease, refusal, release, staleReason, type Holder, type Lease} from './lease/lease.ts';
import {availableFromMeminfo, availableFromVmStat, bootWarning} from './lease/resources.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-lease-'));
const previousHome = process.env.PITBOX_HOME;
process.env.PITBOX_HOME = home;

afterAll(() => {
  if (previousHome === undefined) delete process.env.PITBOX_HOME;
  else process.env.PITBOX_HOME = previousHome;
  fs.rmSync(home, {recursive: true, force: true});
});

beforeEach(() => fs.rmSync(leaseDir(), {recursive: true, force: true}));

const alice: Holder = {owner: 'daemon:/work/alice', label: 'alice', pid: process.pid, root: '/work/alice'};
const bob: Holder = {owner: 'daemon:/work/bob', label: 'bob', pid: process.pid, root: '/work/bob'};

/** A pid that runs nothing: far above any real one. */
const DEAD_PID = 2 ** 22 - 3;

describe('leases', () => {
  it('gives a free device to the first holder and refuses the second, naming the first', () => {
    const a = acquire('apple', 'UDID-1', alice, {name: 'iPhone 17'});
    expect(a.ok).toBe(true);
    const b = acquire('apple', 'UDID-1', bob, {name: 'iPhone 17'});
    expect(b.ok).toBe(false);
    expect(b.lease.label).toBe('alice');
    expect(refusal(b.lease)).toMatch(/iPhone 17 is held by "alice" \(pid \d+, \/work\/alice, for \d+ s\): pitbox does not touch another session's device/);
    expect(refusal(b.lease)).toMatch(/device boot/);
  });

  it('renews the holder\'s own lease and keeps when it started', () => {
    const first = acquire('android', 'emulator-5554', alice, {now: 1000});
    const again = acquire('android', 'emulator-5554', alice, {now: 5000, purpose: 'checkout pass'});
    expect(again.ok && again.renewed).toBe(true);
    expect(again.lease.since).toBe(first.lease.since);
    expect(again.lease.heartbeat).toBe(5000);
    expect(again.lease.purpose).toBe('checkout pass');
  });

  it('keeps leases of different devices apart', () => {
    expect(acquire('apple', 'UDID-1', alice).ok).toBe(true);
    expect(acquire('apple', 'UDID-2', bob).ok).toBe(true);
    expect(acquire('android', 'UDID-1', bob).ok).toBe(true);
    expect(listLeases().map(l => `${l.platform}:${l.device}:${l.label}`).sort()).toEqual(['android:UDID-1:bob', 'apple:UDID-1:alice', 'apple:UDID-2:bob']);
  });

  it('counts a holder whose process is gone as stale only after a grace, so a restarted daemon keeps its devices', () => {
    const now = Date.now();
    const l: Lease = {...alice, pid: DEAD_PID, platform: 'apple', device: 'X', since: now, heartbeat: now, ttlMs: 600_000};
    expect(staleReason(l, now + 1000)).toBeUndefined();
    expect(staleReason(l, now + DEAD_GRACE_MS + 1000)).toMatch(/pid .* is gone/);
    const live = {...l, pid: process.pid};
    expect(staleReason(live, now + DEAD_GRACE_MS + 1000)).toBeUndefined();
    expect(staleReason(live, now + 600_001)).toMatch(/no heartbeat for 10 min/);
  });

  it('takes over a stale lease and says whose it was', () => {
    const old = Date.now() - 2 * DEAD_GRACE_MS;
    acquire('apple', 'UDID-1', {...alice, pid: DEAD_PID}, {now: old});
    const b = acquire('apple', 'UDID-1', bob);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.replaced?.lease.label).toBe('alice');
    expect(b.replaced?.why).toMatch(/gone/);
    expect(readLease('apple', 'UDID-1')?.label).toBe('bob');
  });

  it('takes over an expired shell lease (no pid, ttl passed)', () => {
    const shell: Holder = {owner: 'as:widget pass', label: 'widget pass'};
    acquire('android', 'emulator-5556', shell, {ttlMs: 60_000, now: Date.now() - 120_000});
    expect(acquire('android', 'emulator-5556', bob).ok).toBe(true);
  });

  it('lets only the holder release, unless forced', () => {
    acquire('apple', 'UDID-1', alice, {name: 'iPhone 17'});
    expect(() => release('apple', 'UDID-1', l => l.owner === bob.owner)).toThrow(/iPhone 17 is held by "alice"/);
    expect(release('apple', 'UDID-1', l => l.owner === bob.owner, {force: true}).lease?.label).toBe('alice');
    expect(readLease('apple', 'UDID-1')).toBeUndefined();
    acquire('apple', 'UDID-1', alice);
    expect(release('apple', 'UDID-1', l => l.owner === alice.owner).released).toBe(true);
    expect(release('apple', 'UDID-1', l => l.owner === alice.owner).released).toBe(false);
  });

  it('renews a heartbeat only for its owner', () => {
    acquire('apple', 'UDID-1', alice, {now: 1000});
    expect(heartbeat('apple', 'UDID-1', bob.owner)).toBe(false);
    expect(heartbeat('apple', 'UDID-1', alice.owner, {}, 9000)).toBe(true);
    expect(readLease('apple', 'UDID-1')?.heartbeat).toBe(9000);
  });

  it('gives a device to exactly one of many processes racing for it', async () => {
    const lease = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lease', 'lease.ts');
    const script = `import {acquire} from ${JSON.stringify(lease)};
      const r = acquire('apple', 'RACE', {owner: 'p:' + process.pid, label: 'p' + process.pid, pid: process.pid});
      process.stdout.write(r.ok ? 'won' : 'lost');`;
    const runs = Array.from({length: 8}, () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, PITBOX_HOME: home}});
        let out = '';
        child.stdout.on('data', d => (out += d));
        child.stderr.on('data', d => (out += d));
        child.on('error', reject);
        child.on('exit', () => resolve(out.trim()));
      }),
    );
    const results = await Promise.all(runs);
    expect(results.filter(r => r === 'won')).toHaveLength(1);
    expect(results.filter(r => r === 'lost')).toHaveLength(7);
  });

  it('reads durations for shell leases', () => {
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('45')).toBe(2_700_000);
    expect(() => parseDuration('soon')).toThrow(/not a duration/);
  });
});

describe('a daemon\'s leases', () => {
  it('labels a session by its folder and PITBOX_SESSION', () => {
    expect(sessionLabel('/work/shop', {})).toBe('shop');
    expect(sessionLabel('/work/shop', {PITBOX_SESSION: 'checkout pass'})).toBe('shop · checkout pass');
  });

  it('chooses the device it holds, else the only free one, and never another session\'s', () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    const b = new DeviceLeases('/work/bob', process.pid, 'bob');
    const sims = [{platform: 'apple' as const, id: 'U1', name: 'iPhone 17'}];
    expect(a.choose(sims).id).toBe('U1');
    expect(a.holds('apple', 'U1')).toBe(true);
    expect(() => b.choose(sims)).toThrow(/every device online is held by another session:\niPhone 17 — held by "alice"/);
    const two = [...sims, {platform: 'apple' as const, id: 'U2', name: 'iPhone 17 (pitbox 2)'}];
    expect(b.choose(two).id).toBe('U2');
    expect(a.choose(two).id).toBe('U1');
    expect(b.choose(two).id).toBe('U2');
  });

  it('observes a device another session holds but does not take it', () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    const b = new DeviceLeases('/work/bob', process.pid, 'bob');
    a.claim('android', 'emulator-5554', {name: 'Pixel_8'});
    expect(b.choose([{platform: 'android', id: 'emulator-5554'}], {observe: true}).id).toBe('emulator-5554');
    expect(b.holds('android', 'emulator-5554')).toBe(false);
    expect(b.tag('android', 'emulator-5554')).toMatch(/^held by "alice"/);
    expect(a.tag('android', 'emulator-5554')).toBe('yours');
  });

  it('refuses a claim on another session\'s device', () => {
    new DeviceLeases('/work/alice', process.pid, 'alice').claim('apple', 'U1', {name: 'iPhone 17'});
    expect(() => new DeviceLeases('/work/bob', process.pid, 'bob').claim('apple', 'U1', {name: 'iPhone 17'})).toThrow(/^iPhone 17 is held by "alice"/);
  });

  it('treats a shell lease taken in the same project as its own, and leaves it on release', async () => {
    acquire('apple', 'U1', {owner: 'as:pass', label: 'shop pass', root: '/work/shop'}, {ttlMs: 600_000});
    const d = new DeviceLeases('/work/shop', process.pid, 'shop');
    expect(d.choose([{platform: 'apple', id: 'U1'}]).id).toBe('U1');
    await d.releaseAll(async () => undefined);
    expect(readLease('apple', 'U1')?.label).toBe('shop pass');
  });

  it('shuts down on release only what it booted, and releases everything', async () => {
    const d = new DeviceLeases('/work/alice', process.pid, 'alice');
    d.claim('apple', 'FOUND');
    d.claim('apple', 'BOOTED', {booted: true});
    const down: string[] = [];
    const r = await d.releaseAll(async h => down.push(h.id));
    expect(down).toEqual(['BOOTED']);
    expect(r.released.map(h => h.id).sort()).toEqual(['BOOTED', 'FOUND']);
    expect(listLeases()).toEqual([]);
  });

  it('adopts the leases a previous daemon of the project left, booted flag and all', () => {
    acquire('apple', 'U1', {owner: 'daemon:/work/alice', label: 'alice', pid: DEAD_PID, root: '/work/alice'}, {booted: true});
    const d = new DeviceLeases('/work/alice', process.pid, 'alice');
    expect(d.adopt()).toEqual([{platform: 'apple', id: 'U1', name: undefined, booted: true}]);
    expect(readLease('apple', 'U1')?.pid).toBe(process.pid);
  });

  it('drops a lease that was forced away on the next heartbeat', () => {
    const d = new DeviceLeases('/work/alice', process.pid, 'alice');
    d.claim('apple', 'U1');
    release('apple', 'U1', () => false, {force: true});
    acquire('apple', 'U1', bob);
    expect(d.beat().map(h => h.id)).toEqual(['U1']);
    expect(d.held()).toEqual([]);
  });
});

describe('machine resources', () => {
  it('reads available memory from vm_stat and /proc/meminfo', () => {
    const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:     1000.\nPages active:   5000.\nPages inactive: 2000.\nPages speculative: 100.\nPages purgeable: 100.\n';
    expect(availableFromVmStat(vm)).toBe(Math.round((3200 * 16384) / 1048576));
    expect(availableFromMeminfo('MemTotal: 1 kB\nMemAvailable:    8388608 kB\n')).toBe(8192);
  });

  it('warns before a device the machine likely cannot carry, and is quiet otherwise', () => {
    expect(bootWarning('android', 1, {availableMb: 32_000, cpus: 10, load1: 3})).toBeUndefined();
    expect(bootWarning('android', 2, {availableMb: 3000, cpus: 10, load1: 3})).toMatch(/^2\.9 GB of memory available, an emulator takes ~3\.0 GB with 2 devices already running/);
    expect(bootWarning('apple', 1, {availableMb: 32_000, cpus: 4, load1: 9})).toMatch(/load 9\.0 on 4 cores.*1 device already/);
  });
});
