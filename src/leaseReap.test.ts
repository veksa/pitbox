// Leases that ended without a release (lease/reap.ts): the device pitbox booted for a holder that died or ran out is
// shut down after a grace, a restarted session of the same name takes it back within it, a device pitbox did not boot
// is never shut down, and stale leases are cleared. The driver is a stand-in that records shutdowns; leases live in a
// temporary PITBOX_HOME (src/test-setup.ts): no real device or lease is touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {leaseCli, leaseCommand} from './lease/cli.ts';
import {DeviceLeases} from './lease/devices.ts';
import {acquire, DEAD_GRACE_MS, leaseDir, ORPHAN_GRACE_MS, readLease, type Holder, type Platform} from './lease/lease.ts';
import {describeReaped, leaseWarnings, reapLeases, REAPER_TTL_MS, type Running} from './lease/reap.ts';

/** A pid that runs nothing: far above any real one. */
const DEAD_PID = 2 ** 22 - 3;
const realReap = leaseCli.reap;

beforeEach(() => fs.rmSync(leaseDir(), {recursive: true, force: true}));
afterEach(() => (leaseCli.reap = realReap));

/** A daemon of `root` that died; its lease's last heartbeat `agoMs` ago. */
const deadDaemon = (platform: Platform, device: string, agoMs: number, extra: {booted?: boolean; created?: boolean; instance?: string; name?: string} = {}, root = '/work/shop', session = 'pass') =>
  acquire(platform, device, {owner: `daemon:${root}`, label: `${path.basename(root)} · ${session}`, pid: DEAD_PID, root, session}, {...extra, now: Date.now() - agoMs});

const LONG_AGO = DEAD_GRACE_MS + ORPHAN_GRACE_MS + 60_000;

const driver = () => {
  const down: string[] = [];
  return {down, shutdown: async (platform: Platform, id: string) => void down.push(`${platform}:${id}`)};
};

describe('reaping leases that ended', () => {
  it('shuts down a simulator pitbox booted once its holder has been gone past the grace, and clears the lease', async () => {
    deadDaemon('apple', 'U1', LONG_AGO, {booted: true, name: 'iPhone 17 (pitbox 2)'});
    const d = driver();
    const r = await reapLeases({running: [{platform: 'apple', id: 'U1'}], shutdown: d.shutdown});
    expect(d.down).toEqual(['apple:U1']);
    expect(readLease('apple', 'U1')).toBeUndefined();
    expect(describeReaped(r)).toEqual([expect.stringMatching(/^shut down iPhone 17 \(pitbox 2\) \(U1\): pitbox booted it for "shop · pass"/)]);
  });

  it('leaves it running within the grace, and says when it goes', async () => {
    deadDaemon('apple', 'U1', DEAD_GRACE_MS + 60_000, {booted: true});
    const d = driver();
    const r = await reapLeases({running: [{platform: 'apple', id: 'U1'}], shutdown: d.shutdown});
    expect(d.down).toEqual([]);
    expect(r.swept).toEqual([]);
    expect(readLease('apple', 'U1')?.booted).toBe(true);
    const {listLeases} = await import('./lease/lease.ts');
    expect(leaseWarnings(listLeases())).toEqual([expect.stringMatching(/^U1 \(U1\) was booted by pitbox for "shop · pass".*if it still runs, it is shut down in about (9|10) min unless that session takes it again/)]);
  });

  it('never shuts down a device pitbox did not boot, nor one of a project that keeps its devices up: only the lease goes', async () => {
    deadDaemon('apple', 'FOUND', LONG_AGO);
    const keeper = new DeviceLeases('/work/keep', process.pid, 'keep', undefined);
    keeper.keepBooted = () => true;
    keeper.claim('apple', 'KEPT', {booted: true});
    const kept = readLease('apple', 'KEPT')!;
    expect(kept.keep).toBe(true);
    fs.writeFileSync(path.join(leaseDir(), 'apple-KEPT.json'), JSON.stringify({...kept, pid: DEAD_PID, heartbeat: Date.now() - LONG_AGO}));
    const d = driver();
    const r = await reapLeases({running: [{platform: 'apple', id: 'FOUND'}, {platform: 'apple', id: 'KEPT'}], shutdown: d.shutdown});
    expect(d.down).toEqual([]);
    expect(r.swept.map(l => l.device).sort()).toEqual(['FOUND', 'KEPT']);
    expect(readLease('apple', 'FOUND')).toBeUndefined();
  });

  it('never shuts down an emulator by its serial alone: another instance on the port, or a lease with no instance', async () => {
    deadDaemon('android', 'emulator-5554', LONG_AGO, {booted: true, instance: 'pid:100'});
    deadDaemon('android', 'emulator-5556', LONG_AGO, {booted: true});
    deadDaemon('android', 'emulator-5558', LONG_AGO, {booted: true, instance: 'pid:300'});
    const running: Running[] = [
      {platform: 'android', id: 'emulator-5554', instance: 'pid:999'},
      {platform: 'android', id: 'emulator-5556', instance: 'pid:200'},
      {platform: 'android', id: 'emulator-5558', instance: 'pid:300'},
    ];
    const d = driver();
    const r = await reapLeases({running, shutdown: d.shutdown});
    expect(d.down).toEqual(['android:emulator-5558']);
    expect(r.swept.map(l => l.device).sort()).toEqual(['emulator-5554', 'emulator-5556']);
  });

  it('clears at once a lease whose serial another emulator took, even within the grace', async () => {
    deadDaemon('android', 'emulator-5554', DEAD_GRACE_MS + 1000, {booted: true, instance: 'pid:100'});
    const d = driver();
    const r = await reapLeases({running: [{platform: 'android', id: 'emulator-5554', instance: 'pid:999'}], shutdown: d.shutdown});
    expect(d.down).toEqual([]);
    expect(r.swept.map(l => l.device)).toEqual(['emulator-5554']);
  });

  it('clears a shell lease not renewed for days whose simulator no longer runs', async () => {
    acquire('apple', 'OLD', {owner: 'as:watch pass@/work/watch', label: 'watch pass', root: '/work/watch', session: 'watch pass'}, {ttlMs: 30 * 60_000, now: Date.now() - 2692 * 60_000});
    const d = driver();
    const r = await reapLeases({running: [], shutdown: d.shutdown});
    expect(d.down).toEqual([]);
    expect(r.swept.map(l => l.label)).toEqual(['watch pass']);
    expect(fs.readdirSync(leaseDir()).filter(f => f.endsWith('.json'))).toEqual([]);
  });

  it('leaves live leases, and the leases of a platform whose list could not be read', async () => {
    acquire('apple', 'LIVE', {owner: 'daemon:/work/a', label: 'a', pid: process.pid, root: '/work/a'}, {booted: true, now: Date.now() - LONG_AGO});
    deadDaemon('android', 'emulator-5554', LONG_AGO, {booted: true, instance: 'pid:1'});
    const d = driver();
    const r = await reapLeases({running: [{platform: 'apple', id: 'LIVE'}], unread: new Set(['android']), shutdown: d.shutdown});
    expect(d.down).toEqual([]);
    expect(r.swept).toEqual([]);
    expect(readLease('android', 'emulator-5554')).toBeDefined();
  });

  it('holds the device under its own lease while it shuts down: no session takes it half way', async () => {
    deadDaemon('apple', 'U1', LONG_AGO, {booted: true});
    const bob: Holder = {owner: 'daemon:/work/bob', label: 'bob', pid: process.pid, root: '/work/bob'};
    let during: boolean | undefined;
    await reapLeases({running: [{platform: 'apple', id: 'U1'}], shutdown: async () => void (during = acquire('apple', 'U1', bob).ok)});
    expect(during).toBe(false);
    expect(readLease('apple', 'U1')).toBeUndefined();
  });

  it('keeps its lease on a shutdown that fails, and tries again once that lease runs out', async () => {
    deadDaemon('apple', 'U1', LONG_AGO, {booted: true});
    const r = await reapLeases({running: [{platform: 'apple', id: 'U1'}], shutdown: async () => Promise.reject(new Error('simctl hung'))});
    expect(describeReaped(r)).toEqual([expect.stringMatching(/could not shut down U1 \(U1\): simctl hung; the next sweep tries again/)]);
    expect(readLease('apple', 'U1')?.owner).toMatch(/^reaper:/);
    const d = driver();
    await reapLeases({running: [{platform: 'apple', id: 'U1'}], shutdown: d.shutdown});
    expect(d.down).toEqual([]);
    await reapLeases({running: [{platform: 'apple', id: 'U1'}], shutdown: d.shutdown, now: Date.now() + REAPER_TTL_MS + ORPHAN_GRACE_MS + 1000});
    expect(d.down).toEqual(['apple:U1']);
    expect(readLease('apple', 'U1')).toBeUndefined();
  });

  it('takes two reapers racing for one device as one shutdown', async () => {
    deadDaemon('apple', 'U1', LONG_AGO, {booted: true});
    const d = driver();
    await Promise.all([reapLeases({running: [{platform: 'apple', id: 'U1'}], shutdown: d.shutdown}), reapLeases({running: [{platform: 'apple', id: 'U1'}], shutdown: d.shutdown})]);
    expect(d.down).toEqual(['apple:U1']);
  });
});

describe('a session that comes back', () => {
  const dirs: string[] = [];
  const project = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-reap-'));
    fs.writeFileSync(path.join(dir, 'pitbox.config.json'), '{}');
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
  });

  it('takes its device back by its session name, still booted by pitbox, so the reaper leaves it', async () => {
    const root = project();
    deadDaemon('apple', 'U1', DEAD_GRACE_MS + 60_000, {booted: true, created: true}, root, 'pass');
    const r = await leaseCommand(['acquire', 'apple:U1'], {as: 'pass'}, root);
    expect(r.text).toMatch(/took over a stale lease of ".* · pass".*the same session, so pitbox still shuts the device down when this lease ends/s);
    expect(readLease('apple', 'U1')).toMatchObject({owner: `as:pass@${root}`, booted: true, created: true});
    const d = driver();
    await reapLeases({running: [{platform: 'apple', id: 'U1'}], shutdown: d.shutdown, now: Date.now() + 60_000});
    expect(d.down).toEqual([]);
  });

  it('is the same session for its daemon: a restarted daemon of the project picks its devices up', () => {
    deadDaemon('apple', 'U1', LONG_AGO, {booted: true}, '/work/shop', 'pass');
    const d = new DeviceLeases('/work/shop', process.pid, 'shop · pass', 'pass');
    expect(d.adopt().map(h => [h.id, h.booted])).toEqual([['U1', true]]);
  });

  it('does not hand the booted mark to another session of the project, nor to another project', async () => {
    const root = project();
    const other = project();
    deadDaemon('apple', 'U1', DEAD_GRACE_MS + 60_000, {booted: true}, root, 'pass');
    deadDaemon('apple', 'U2', DEAD_GRACE_MS + 60_000, {booted: true}, root, 'pass');
    expect((await leaseCommand(['acquire', 'apple:U1'], {as: 'review'}, root)).text).not.toMatch(/same session/);
    expect(readLease('apple', 'U1')?.booted).toBeUndefined();
    await leaseCommand(['acquire', 'apple:U2'], {as: 'pass'}, other);
    expect(readLease('apple', 'U2')?.booted).toBeUndefined();
  });
});

describe('lease warnings', () => {
  it('names a holder with several devices of one platform, and not one with a phone and a simulator', () => {
    const now = Date.now();
    const base = {since: now, heartbeat: now, ttlMs: 600_000, pid: process.pid};
    const a = {...base, owner: 'daemon:/work/a', label: 'a · pass', root: '/work/a'};
    const b = {...base, owner: 'daemon:/work/b', label: 'b', root: '/work/b'};
    const w = leaseWarnings([
      {...a, platform: 'android', device: 'emulator-5554', name: 'Phone'},
      {...a, platform: 'android', device: 'emulator-5556', name: 'Phone_pitbox_2'},
      {...b, platform: 'android', device: 'emulator-5558'},
      {...b, platform: 'apple', device: 'U1'},
    ]);
    expect(w).toEqual(['"a · pass" holds 2 Android devices: Phone, Phone_pitbox_2 — give back the ones it does not use (`device release device=<id>`)']);
  });

  it('are printed by lease list after it reaps', async () => {
    deadDaemon('apple', 'U1', DEAD_GRACE_MS + 60_000, {booted: true});
    let reaped = false;
    leaseCli.reap = async () => ((reaped = true), {shutDown: [], swept: [], failed: []});
    const r = await leaseCommand(['list'], {});
    expect(reaped).toBe(true);
    expect(r.text).toMatch(/^✗ apple U1 {2}"shop · pass".*booted by it · stale: its holder \(pid \d+\) is gone\nwarning: U1 \(U1\) was booted by pitbox/);
  });
});
