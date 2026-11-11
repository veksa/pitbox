// Device leases: acquire, races between processes, holders that are gone or whose pid was reused, shell leases from
// two projects, a reused Android serial, release, the daemon's choice of a device, refusals, and the machine check
// before a boot. Everything runs in a temporary PITBOX_HOME (src/test-setup.ts): no real lease is touched.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DeviceLeases, sessionLabel, UNLEASED} from './lease/devices.ts';
import {leaseCommand} from './lease/cli.ts';
import {acquire, DEAD_GRACE_MS, heartbeat, leaseDir, listLeases, parseDuration, probe, readLease, refusal, release, staleReason, withLock, type Holder, type Lease} from './lease/lease.ts';
import {availableFromMeminfo, availableFromVmStat, bootWarning} from './lease/resources.ts';

const realProbe = {...probe};

beforeEach(() => fs.rmSync(leaseDir(), {recursive: true, force: true}));
afterEach(() => Object.assign(probe, realProbe));

const alice: Holder = {owner: 'daemon:/work/alice', label: 'alice', pid: process.pid, root: '/work/alice'};
const bob: Holder = {owner: 'daemon:/work/bob', label: 'bob', pid: process.pid, root: '/work/bob'};

/** A pid that runs nothing: far above any real one. */
const DEAD_PID = 2 ** 22 - 3;

describe('leases', () => {
  it('gives a free device to the first holder and refuses the second, naming the first', () => {
    expect(acquire('apple', 'UDID-1', alice, {name: 'iPhone 17'}).ok).toBe(true);
    const b = acquire('apple', 'UDID-1', bob, {name: 'iPhone 17'});
    expect(b.ok).toBe(false);
    expect(b.lease.label).toBe('alice');
    expect(refusal(b.lease)).toMatch(/iPhone 17 is held by "alice" \(pid \d+, \/work\/alice, for \d+ s\): pitbox does not touch another session's device/);
    expect(refusal(b.lease)).toMatch(/device boot/);
  });

  it("renews the holder's own lease and keeps when it started", () => {
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

  it('never expires the lease of a holder that runs, however old its heartbeat (a laptop asleep)', () => {
    const l: Lease = {...alice, pidStart: 'Mon Nov 11 10:00:00 2026', platform: 'apple', device: 'X', since: 0, heartbeat: 0, ttlMs: 600_000};
    probe.start = () => 'Mon Nov 11 10:00:00 2026';
    expect(staleReason(l, Date.now())).toBeUndefined();
  });

  it('counts a holder whose pid now runs another program as gone (pid reuse)', () => {
    const now = Date.now();
    const l: Lease = {...alice, pidStart: 'Mon Nov 11 10:00:00 2026', platform: 'apple', device: 'X', since: now, heartbeat: now, ttlMs: 600_000};
    probe.start = () => 'Tue Nov 12 09:00:00 2026';
    expect(staleReason(l, now + 1000)).toBeUndefined(); // the grace a restarted daemon has
    expect(staleReason(l, now + DEAD_GRACE_MS + 1000)).toMatch(/pid .* is gone/);
  });

  it('keeps a gone holder\'s devices for a grace, then lets them go', () => {
    const now = Date.now();
    const l: Lease = {...alice, pid: DEAD_PID, platform: 'apple', device: 'X', since: now, heartbeat: now, ttlMs: 600_000};
    expect(staleReason(l, now + 1000)).toBeUndefined();
    expect(staleReason(l, now + DEAD_GRACE_MS + 1000)).toMatch(/pid .* is gone/);
  });

  it('expires only a lease with no holder process by time', () => {
    const now = Date.now();
    const shell: Lease = {owner: 'as:x@/w', label: 'x', platform: 'apple', device: 'X', since: now, heartbeat: now, ttlMs: 60_000};
    expect(staleReason(shell, now + 30_000)).toBeUndefined();
    expect(staleReason(shell, now + 120_000)).toMatch(/not renewed for 2 min/);
  });

  it('does not count a lease taken on an earlier boot of a reused serial', () => {
    acquire('android', 'emulator-5556', alice, {instance: 'boot-a'});
    const b = acquire('android', 'emulator-5556', bob, {instance: 'boot-b'});
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.replaced?.why).toMatch(/earlier boot/);
    // The old holder, asking with the device's current boot, finds it someone else's.
    const again = acquire('android', 'emulator-5556', alice, {instance: 'boot-b'});
    expect(again.ok).toBe(false);
  });

  it('takes over a stale lease and says whose it was', () => {
    acquire('apple', 'UDID-1', {...alice, pid: DEAD_PID}, {now: Date.now() - 2 * DEAD_GRACE_MS});
    const b = acquire('apple', 'UDID-1', bob);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.replaced?.lease.label).toBe('alice');
    expect(b.replaced?.why).toMatch(/gone/);
    expect(readLease('apple', 'UDID-1')?.label).toBe('bob');
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

  it('clears a lock left by a process that is gone', () => {
    const file = path.join(leaseDir(), 'x.json');
    fs.mkdirSync(leaseDir(), {recursive: true});
    fs.writeFileSync(`${file}.lock`, JSON.stringify({pid: DEAD_PID, at: Date.now()}));
    expect(withLock(file, () => 'ran', 2000)).toBe('ran');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('gives a device to exactly one of many processes racing for it, also over a stale lease', async () => {
    acquire('apple', 'RACE', {...alice, pid: DEAD_PID}, {now: Date.now() - 2 * DEAD_GRACE_MS});
    const lease = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lease', 'lease.ts');
    const script = `import {acquire} from ${JSON.stringify(lease)};
      const r = acquire('apple', 'RACE', {owner: 'p:' + process.pid, label: 'p' + process.pid, pid: process.pid});
      process.stdout.write(r.ok ? 'won' : 'lost');`;
    const runs = Array.from({length: 8}, () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: process.env});
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

describe('shell leases', () => {
  const dirs: string[] = [];
  const project = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-shell-'));
    fs.writeFileSync(path.join(d, 'pitbox.config.json'), '{}');
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
  });

  it('keeps two projects using one label apart', async () => {
    const one = project();
    const two = project();
    expect((await leaseCommand(['acquire', 'apple:U1'], {as: 'device-pass'}, one)).failed).toBe(false);
    const r = await leaseCommand(['acquire', 'apple:U1'], {as: 'device-pass'}, two);
    expect(r.failed).toBe(true);
    expect(r.text).toMatch(/U1 is held by "device-pass" \(.*pitbox-shell-/);
    expect((await leaseCommand(['acquire', 'apple:U1'], {as: 'device-pass'}, one)).text).toMatch(/^renewed U1 as "device-pass"/);
    expect((await leaseCommand(['release', 'apple:U1'], {as: 'device-pass'}, two)).failed).toBe(true);
    expect((await leaseCommand(['release', 'apple:U1'], {as: 'device-pass'}, one)).text).toBe('released U1');
  });

  it("counts as its project's daemon's own", async () => {
    const one = project();
    await leaseCommand(['acquire', 'apple:U1'], {as: 'pass'}, one);
    const d = new DeviceLeases(one, process.pid, 'daemon');
    expect(d.holds('apple', 'U1')).toBe(true);
  });
});

describe("a daemon's leases", () => {
  it('labels a session by its folder and PITBOX_SESSION', () => {
    expect(sessionLabel('/work/shop', {})).toBe('shop');
    expect(sessionLabel('/work/shop', {PITBOX_SESSION: 'checkout pass'})).toBe('shop · checkout pass');
  });

  it("chooses the device it holds, never another session's, never a running one nobody leased", () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    const b = new DeviceLeases('/work/bob', process.pid, 'bob');
    const sims = [{platform: 'apple' as const, id: 'U1', name: 'iPhone 17'}];
    expect(() => a.choose(sims)).toThrow(/no device of this session is online:\niPhone 17 \(U1\) — running, unleased\nhint: .*device=U1/);
    a.claim('apple', 'U1', {name: 'iPhone 17'});
    expect(a.choose(sims).id).toBe('U1');
    expect(() => b.choose(sims)).toThrow(/no device of this session is online:\niPhone 17 — held by "alice"/);
    const two = [...sims, {platform: 'apple' as const, id: 'U2', name: 'iPhone 17 (pitbox 2)'}];
    b.claim('apple', 'U2');
    expect(b.choose(two).id).toBe('U2');
    expect(a.choose(two).id).toBe('U1');
  });

  it('observes the only device online whoever holds it, and does not take it', () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    const b = new DeviceLeases('/work/bob', process.pid, 'bob');
    a.claim('android', 'emulator-5554', {name: 'Pixel_8'});
    expect(b.choose([{platform: 'android', id: 'emulator-5554'}], {observe: true}).id).toBe('emulator-5554');
    expect(b.holds('android', 'emulator-5554')).toBe(false);
    expect(b.tag('android', 'emulator-5554')).toMatch(/^held by "alice"/);
    expect(a.tag('android', 'emulator-5554')).toBe('yours');
    expect(a.tag('android', 'emulator-5560')).toBe(UNLEASED);
    expect(a.tag('apple', 'IDLE', undefined, false)).toBeUndefined();
  });

  it("refuses a claim on another session's device", () => {
    new DeviceLeases('/work/alice', process.pid, 'alice').claim('apple', 'U1', {name: 'iPhone 17'});
    expect(() => new DeviceLeases('/work/bob', process.pid, 'bob').claim('apple', 'U1', {name: 'iPhone 17'})).toThrow(/^iPhone 17 is held by "alice"/);
  });

  it('lets a new emulator on a reused serial go to another session', () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    const b = new DeviceLeases('/work/bob', process.pid, 'bob');
    a.claim('android', 'emulator-5556', {instance: 'boot-a'});
    // alice's emulator is gone; bob's new one came up on the same serial
    expect(b.holderOf('android', 'emulator-5556', 'boot-b')).toBeUndefined();
    b.claim('android', 'emulator-5556', {instance: 'boot-b'});
    expect(a.holds('android', 'emulator-5556', 'boot-b')).toBe(false);
    const lost = a.beat([{platform: 'android', id: 'emulator-5556', instance: 'boot-b'}]);
    expect(lost.map(h => h.id)).toEqual(['emulator-5556']);
    expect(readLease('android', 'emulator-5556')?.label).toBe('bob');
  });

  it('drops and gives back a device that went away, but not one on its way up', () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    a.claim('apple', 'GONE');
    a.claim('apple', 'BOOTING', {booted: true});
    a.claim('apple', 'HERE');
    const lost = a.beat([{platform: 'apple', id: 'HERE'}], new Set(['BOOTING']));
    expect(lost.map(h => h.id)).toEqual(['GONE']);
    expect(readLease('apple', 'GONE')).toBeUndefined();
    expect(a.held().map(h => h.id).sort()).toEqual(['BOOTING', 'HERE']);
    // Lists that cannot be read drop nothing.
    expect(a.beat(undefined)).toEqual([]);
  });

  it('treats a shell lease taken in the same project as its own, and leaves it on release', async () => {
    acquire('apple', 'U1', {owner: 'as:pass@/work/shop', label: 'shop pass', root: '/work/shop'}, {ttlMs: 600_000});
    const d = new DeviceLeases('/work/shop', process.pid, 'shop');
    expect(d.choose([{platform: 'apple', id: 'U1'}]).id).toBe('U1');
    d.claim('apple', 'U1');
    await d.releaseAll(async () => undefined);
    expect(readLease('apple', 'U1')?.label).toBe('shop pass');
  });

  it('shuts down on release only what it booted, and releases everything', async () => {
    const d = new DeviceLeases('/work/alice', process.pid, 'alice');
    d.claim('apple', 'FOUND');
    d.claim('apple', 'BOOTED', {booted: true, created: true});
    const down: string[] = [];
    const r = await d.releaseAll(async h => down.push(`${h.id}${h.created ? ' (created)' : ''}`));
    expect(down).toEqual(['BOOTED (created)']);
    expect(r.released.map(h => h.id).sort()).toEqual(['BOOTED', 'FOUND']);
    expect(listLeases()).toEqual([]);
  });

  it('adopts the leases a previous daemon of the project left, booted flag and all', () => {
    acquire('apple', 'U1', {owner: 'daemon:/work/alice', label: 'alice', pid: DEAD_PID, root: '/work/alice'}, {booted: true});
    const d = new DeviceLeases('/work/alice', process.pid, 'alice');
    expect(d.adopt()).toEqual([{platform: 'apple', id: 'U1', name: undefined, instance: undefined, booted: true, created: false}]);
    expect(readLease('apple', 'U1')?.pid).toBe(process.pid);
  });

  it('drops a lease that was forced away on the next heartbeat', () => {
    const d = new DeviceLeases('/work/alice', process.pid, 'alice');
    d.claim('apple', 'U1');
    release('apple', 'U1', () => false, {force: true});
    acquire('apple', 'U1', bob);
    expect(d.beat([{platform: 'apple', id: 'U1'}]).map(h => h.id)).toEqual(['U1']);
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
