// Device leases: acquire, races between processes, holders that are gone or whose pid was reused, shell leases from
// two projects, a reused Android serial, release, the daemon's choice of a device, refusals, and the machine check
// before a boot. Everything runs in a temporary PITBOX_HOME (src/test-setup.ts): no real lease is touched.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DeviceLeases, sessionLabel, UNLEASED} from './lease/devices.ts';
import {leaseCommand} from './lease/cli.ts';
import {forgetCreated, isCreated, recordCreated} from './lease/created.ts';
import {acquire, DEAD_GRACE_MS, heartbeat, leaseDir, listLeases, lockInternals, parseDuration, parseElapsed, probe, readLease, refusal, release, staleReason, withLock, type Holder, type Lease} from './lease/lease.ts';
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
    const l: Lease = {...alice, pidStart: 1_800_000_000, platform: 'apple', device: 'X', since: 0, heartbeat: 0, ttlMs: 600_000};
    probe.start = () => 1_800_000_001;
    expect(staleReason(l, Date.now())).toBeUndefined();
  });

  it('counts a holder whose pid now runs another program as gone (pid reuse)', () => {
    const now = Date.now();
    const l: Lease = {...alice, pidStart: 1_800_000_000, platform: 'apple', device: 'X', since: now, heartbeat: now, ttlMs: 600_000};
    probe.start = () => 1_800_003_600;
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

  it('reads elapsed times as ps prints them', () => {
    expect(parseElapsed('   01:02\n')).toBe(62);
    expect(parseElapsed('03:01:02')).toBe(10_862);
    expect(parseElapsed('2-03:01:02')).toBe(183_662);
    expect(parseElapsed('')).toBeUndefined();
  });

  it('reads the same start for a process whatever the reader\'s time zone and language', async () => {
    const lease = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lease', 'lease.ts');
    // A file URL: on Windows an absolute path (`D:\\…`) is not an import specifier.
    const script = `import {processStart} from ${JSON.stringify(pathToFileURL(lease).href)}; process.stdout.write(String(processStart(${process.pid})));`;
    const read = (env: NodeJS.ProcessEnv) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, ...env}});
        let out = '';
        child.stdout.on('data', d => (out += d));
        child.on('error', reject);
        child.on('exit', () => resolve(out.trim()));
      });
    const [utc, almaty, ru] = await Promise.all([read({TZ: 'UTC'}), read({TZ: 'Asia/Almaty'}), read({LC_ALL: 'ru_RU.UTF-8', LANG: 'ru_RU.UTF-8', TZ: 'America/New_York'})]);
    if (process.platform === 'win32') return;
    for (const x of [almaty, ru]) expect(Math.abs(Number(x) - Number(utc))).toBeLessThanOrEqual(3);
    // A holder whose start was read under another zone and language is still the same running holder.
    const l: Lease = {...alice, pidStart: Number(ru), platform: 'apple', device: 'X', since: 0, heartbeat: 0, ttlMs: 1};
    expect(staleReason(l, Date.now())).toBeUndefined();
  });

  it('does not count a lease taken on an earlier boot of a reused serial', () => {
    acquire('android', 'emulator-5556', alice, {instance: 'pid:100'});
    const b = acquire('android', 'emulator-5556', bob, {instance: 'pid:200'});
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.replaced?.why).toMatch(/earlier boot/);
    // The old holder, asking with the device's current boot, finds it someone else's.
    const again = acquire('android', 'emulator-5556', alice, {instance: 'pid:200'});
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

  it('says where to point PITBOX_HOME when the lease folder cannot be written', () => {
    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-ro-'));
    const previous = process.env.PITBOX_HOME;
    // A file where the folder should be: every write under it fails.
    fs.writeFileSync(path.join(blocked, 'home'), '');
    process.env.PITBOX_HOME = path.join(blocked, 'home');
    try {
      expect(() => acquire('apple', 'U1', alice)).toThrow(/cannot write its device leases in .*home.leases \(ENOTDIR\)\nhint: set PITBOX_HOME to a writable folder/);
    } finally {
      process.env.PITBOX_HOME = previous;
      fs.rmSync(blocked, {recursive: true, force: true});
    }
  });

  it('never removes a live lock, and clears a lock left by a process that is gone', () => {
    const live = path.join(leaseDir(), 'live.json');
    fs.mkdirSync(leaseDir(), {recursive: true});
    fs.writeFileSync(`${live}.lock`, JSON.stringify({pid: process.pid, start: probe.start(process.pid), at: Date.now()}));
    expect(() => withLock(live, () => 'ran', 200)).toThrow(/stays locked by pid/);
    expect(fs.existsSync(`${live}.lock`)).toBe(true);
    fs.rmSync(`${live}.lock`);
  });

  it('leaves a lock alone while another process is stealing it, and clears a steal file left behind', () => {
    const lock = path.join(leaseDir(), 's.json.lock');
    fs.mkdirSync(leaseDir(), {recursive: true});
    fs.writeFileSync(lock, JSON.stringify({pid: DEAD_PID, at: Date.now()}));
    fs.writeFileSync(`${lock}.steal`, '1');
    expect(lockInternals.tryLock(lock)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(`${lock}.steal`)).toBe(true);
    // The stealer died mid-steal: its file goes once it is old, and the next try takes the lock over.
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(`${lock}.steal`, old, old);
    expect(lockInternals.tryLock(lock)).toBe(false);
    expect(fs.existsSync(`${lock}.steal`)).toBe(false);
    expect(lockInternals.tryLock(lock)).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
    expect(lockInternals.tryLock(lock)).toBe(true);
    fs.rmSync(lock);
  });

  it('does not remove a lock that changed hands between being judged left behind and being stolen', () => {
    const lock = path.join(leaseDir(), 'r.json.lock');
    fs.mkdirSync(leaseDir(), {recursive: true});
    fs.writeFileSync(lock, JSON.stringify({pid: DEAD_PID, at: Date.now()}));
    const taken = JSON.stringify({pid: process.pid, start: probe.start(process.pid), at: Date.now() + 1});
    const alive = probe.alive;
    let first = true;
    probe.alive = pid => {
      if (first) {
        first = false;
        // Another process clears the dead lock and takes it, right after this one read it.
        fs.writeFileSync(lock, taken);
        return false;
      }
      return alive(pid);
    };
    try {
      expect(lockInternals.tryLock(lock)).toBe(false);
    } finally {
      probe.alive = alive;
    }
    expect(fs.readFileSync(lock, 'utf8')).toBe(taken);
    fs.rmSync(lock);
  });

  it('takes an EPERM on a lock name as busy (Windows: the file is being deleted), not as a file system without links', () => {
    const lock = path.join(leaseDir(), 'p.json.lock');
    fs.mkdirSync(leaseDir(), {recursive: true});
    const link = fs.linkSync;
    let pending = 2;
    const spy = vi.spyOn(fs, 'linkSync').mockImplementation((a, b) => {
      if (String(b) === lock && pending-- > 0) throw Object.assign(new Error('operation not permitted'), {code: 'EPERM'});
      link(a, b);
    });
    try {
      expect(lockInternals.tryLock(lock)).toBe(false);
      expect(lockInternals.usesLinks()).toBe(true);
      expect(withLock(lock.slice(0, -'.lock'.length), () => 'ran', 2000)).toBe('ran');
    } finally {
      spy.mockRestore();
      lockInternals.resetLinks();
    }
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('retries replacing a lease while Windows holds it open', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {value: 'win32'});
    const rename = fs.renameSync;
    let refusals = 3;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (String(b).endsWith('apple-U-WIN.json') && refusals-- > 0) throw Object.assign(new Error('operation not permitted'), {code: 'EPERM'});
      rename(a, b);
    });
    try {
      expect(acquire('apple', 'U-WIN', alice).ok).toBe(true);
    } finally {
      spy.mockRestore();
      Object.defineProperty(process, 'platform', platform);
    }
    expect(readLease('apple', 'U-WIN')?.owner).toBe(alice.owner);
  });

  it('locks with exclusive creation on a file system without hard links', () => {
    const lock = path.join(leaseDir(), 'w.json.lock');
    fs.mkdirSync(leaseDir(), {recursive: true});
    const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), {code: 'EPERM'});
    });
    try {
      expect(lockInternals.tryLock(lock)).toBe(true);
      expect(lockInternals.usesLinks()).toBe(false);
      expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);
      expect(lockInternals.tryLock(lock)).toBe(false);
      expect(fs.readdirSync(leaseDir()).filter(f => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      link.mockRestore();
      lockInternals.resetLinks();
      fs.rmSync(lock, {force: true});
    }
  });

  it('retries writing the created-devices list while Windows holds the file', () => {
    const rename = fs.renameSync;
    let refusals = 2;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (refusals-- > 0) throw Object.assign(new Error('resource busy'), {code: 'EBUSY'});
      rename(a, b);
    });
    try {
      recordCreated('U-RETRY', 'iPhone 17 (pitbox 2)');
    } finally {
      spy.mockRestore();
    }
    expect(isCreated('U-RETRY')).toBe(true);
    forgetCreated('U-RETRY');
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
    const script = `import {acquire} from ${JSON.stringify(pathToFileURL(lease).href)};
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
    // Whole outputs compared: a process that failed shows what it said.
    expect([...results].sort()).toEqual(['lost', 'lost', 'lost', 'lost', 'lost', 'lost', 'lost', 'won']);
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

  it("shares a device its own project's daemon holds, and leaves it with the daemon on release", async () => {
    const one = project();
    const d = new DeviceLeases(one, process.pid, 'one');
    d.claim('apple', 'U1', {name: 'iPhone 17', purpose: 'pass'});
    const before = readLease('apple', 'U1')!;
    const r = await leaseCommand(['acquire', 'apple:U1'], {as: 'script', purpose: 'other'}, one);
    expect(r.failed).toBe(false);
    expect(r.text).toMatch(/^U1 is held by this project's pitbox daemon "one" .*shared with it/);
    const shared = readLease('apple', 'U1')!;
    expect(shared.owner).toBe(`daemon:${one}`);
    expect(shared.pid).toBe(process.pid);
    expect(shared.heartbeat).toBe(before.heartbeat);
    const rel = await leaseCommand(['release', 'apple:U1'], {as: 'script'}, one);
    expect(rel).toEqual({text: expect.stringMatching(/^U1 stays with this project's pitbox daemon "one"/), failed: false});
    expect(readLease('apple', 'U1')?.owner).toBe(`daemon:${one}`);
    expect(d.holds('apple', 'U1')).toBe(true);
  });

  it("still refuses a device another project's daemon or another shell holder of its project holds", async () => {
    const one = project();
    const two = project();
    new DeviceLeases(two, process.pid, 'two').claim('apple', 'U1');
    const r = await leaseCommand(['acquire', 'apple:U1'], {as: 'script'}, one);
    expect(r.failed).toBe(true);
    expect(r.text).toMatch(/^U1 is held by "two"/);
    expect((await leaseCommand(['release', 'apple:U1'], {as: 'script'}, one)).failed).toBe(true);
    expect(readLease('apple', 'U1')?.owner).toBe(`daemon:${two}`);
    await leaseCommand(['acquire', 'apple:U2'], {as: 'first'}, one);
    expect((await leaseCommand(['acquire', 'apple:U2'], {as: 'second'}, one)).failed).toBe(true);
  });

  it("does not keep a gone daemon's lease alive: shared within its grace untouched, taken over after", async () => {
    const one = project();
    acquire('apple', 'U1', {owner: `daemon:${one}`, label: 'one', pid: DEAD_PID, root: one}, {now: Date.now() - DEAD_GRACE_MS / 2});
    const before = readLease('apple', 'U1')!;
    expect((await leaseCommand(['acquire', 'apple:U1'], {as: 'script'}, one)).text).toMatch(/shared with it/);
    expect(readLease('apple', 'U1')!.heartbeat).toBe(before.heartbeat);
    acquire('apple', 'U2', {owner: `daemon:${one}`, label: 'one', pid: DEAD_PID, root: one}, {now: Date.now() - 2 * DEAD_GRACE_MS});
    const r = await leaseCommand(['acquire', 'apple:U2'], {as: 'script'}, one);
    expect(r.text).toMatch(/^acquired U2 as "script".*took over a stale lease of "one"/s);
    expect(readLease('apple', 'U2')?.owner).toBe(`as:script@${one}`);
  });

  it("shares with its project's daemon from many shell processes at once, and never takes the device", async () => {
    const one = project();
    new DeviceLeases(one, process.pid, 'one').claim('apple', 'RACE');
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lease', 'cli.ts');
    const script = `import {leaseCommand} from ${JSON.stringify(pathToFileURL(cli).href)};
      const r = await leaseCommand(['acquire', 'apple:RACE'], {as: 's' + process.pid}, ${JSON.stringify(one)});
      process.stdout.write(r.failed ? 'refused: ' + r.text : 'shared');`;
    const runs = Array.from({length: 6}, () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: process.env});
        let out = '';
        child.stdout.on('data', d => (out += d));
        child.stderr.on('data', d => (out += d));
        child.on('error', reject);
        child.on('exit', () => resolve(out.trim()));
      }),
    );
    expect(await Promise.all(runs)).toEqual(Array(6).fill('shared'));
    expect(readLease('apple', 'RACE')?.owner).toBe(`daemon:${one}`);
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
    a.claim('android', 'emulator-5556', {instance: 'pid:100'});
    // alice's emulator is gone; bob's new one came up on the same serial
    expect(b.holderOf('android', 'emulator-5556', 'pid:200')).toBeUndefined();
    b.claim('android', 'emulator-5556', {instance: 'pid:200'});
    expect(a.holds('android', 'emulator-5556', 'pid:200')).toBe(false);
    const lost = a.beat([{platform: 'android', id: 'emulator-5556', instance: 'pid:200'}]);
    expect(lost.map(h => h.id)).toEqual(['emulator-5556']);
    expect(readLease('android', 'emulator-5556')?.label).toBe('bob');
  });

  it('gives back a device only once it has been gone for several beats and a while, never one on its way up', () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    a.claim('apple', 'GONE');
    a.claim('apple', 'BOOTING', {booted: true});
    a.claim('apple', 'HERE');
    const t0 = Date.now();
    const list = [{platform: 'apple' as const, id: 'HERE'}];
    const busy = new Set(['BOOTING']);
    expect(a.beat(list, busy, t0)).toEqual([]);
    expect(a.beat(list, busy, t0 + 30_000)).toEqual([]);
    // Lists that cannot be read judge nothing.
    expect(a.beat(undefined, busy, t0 + 60_000)).toEqual([]);
    expect(a.beat(list, busy, t0 + 60_000)).toEqual([]);
    expect(a.beat(list, busy, t0 + 95_000).map(h => h.id)).toEqual(['GONE']);
    expect(readLease('apple', 'GONE')).toBeUndefined();
    expect(a.held().map(h => h.id).sort()).toEqual(['BOOTING', 'HERE']);
  });

  it('keeps a device that blinks out: back in the list, the count starts again', () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    a.claim('android', 'emulator-5554', {instance: 'pid:1'});
    a.claim('apple', 'SIM');
    const t0 = Date.now();
    const sim = {platform: 'apple' as const, id: 'SIM'};
    const emu = {platform: 'android' as const, id: 'emulator-5554'};
    for (let i = 0; i < 3; i++) expect(a.beat([sim], new Set(), t0 + i * 40_000)).toEqual([]);
    // offline: present, with no instance to compare
    expect(a.beat([sim, emu], new Set(), t0 + 130_000)).toEqual([]);
    expect(a.beat([sim], new Set(), t0 + 160_000)).toEqual([]);
    expect(a.held().map(h => h.id).sort()).toEqual(['SIM', 'emulator-5554']);
  });

  it('judges a platform whose list was read while another platform\'s list failed', () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    a.claim('apple', 'SIM');
    a.claim('android', 'emulator-5554', {instance: 'pid:1'});
    const t0 = Date.now();
    const emu = {platform: 'android' as const, id: 'emulator-5554', instance: 'pid:2'};
    // simctl failed: the simulator is not judged; the emulator on the serial is another one, dropped at once.
    expect(a.beat([emu], new Set(), t0, new Set(['apple'])).map(h => h.id)).toEqual(['emulator-5554']);
    for (let i = 1; i <= 4; i++) expect(a.beat([], new Set(), t0 + i * 60_000, new Set(['apple']))).toEqual([]);
    expect(a.held().map(h => h.id)).toEqual(['SIM']);
  });

  it('gives back an emulator stuck offline for ten minutes', () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    a.claim('android', 'emulator-5554', {instance: 'pid:1'});
    const t0 = Date.now();
    const off = [{platform: 'android' as const, id: 'emulator-5554', offline: true}];
    for (let t = 0; t < 10 * 60_000; t += 60_000) expect(a.beat(off, new Set(), t0 + t)).toEqual([]);
    for (let t = 10 * 60_000; t < 12 * 60_000; t += 30_000) a.beat(off, new Set(), t0 + t);
    expect(a.held()).toEqual([]);
  });

  it('fills in the instance of a lease taken without one, and never changes one it has', () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    a.claim('android', 'emulator-5554', {name: 'Phone'});
    // Another AVD on the port now: not taken for this lease's emulator.
    a.beat([{platform: 'android', id: 'emulator-5554', name: 'Other', instance: 'pid:4'}]);
    expect(readLease('android', 'emulator-5554')?.instance).toBeUndefined();
    a.beat([{platform: 'android', id: 'emulator-5554', name: 'Phone', instance: 'pid:5'}]);
    expect(readLease('android', 'emulator-5554')?.instance).toBe('pid:5');
    expect(heartbeat('android', 'emulator-5554', readLease('android', 'emulator-5554')!.owner, {instance: 'pid:6'})).toBe(true);
    expect(readLease('android', 'emulator-5554')?.instance).toBe('pid:5');
  });

  it('waits much longer when a whole device list comes back empty (adb restarted)', () => {
    const a = new DeviceLeases('/work/alice', process.pid, 'alice');
    a.claim('android', 'emulator-5554', {instance: 'pid:1'});
    const t0 = Date.now();
    for (let i = 0; i <= 4; i++) expect(a.beat([], new Set(), t0 + i * 60_000)).toEqual([]);
    expect(a.beat([], new Set(), t0 + 5 * 60_000 + 1).map(h => h.id)).toEqual(['emulator-5554']);
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
