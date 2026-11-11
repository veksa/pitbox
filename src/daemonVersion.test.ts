// Two pitbox versions on one project: a daemon in use is never stopped for a version swap, so one session's
// restart cannot take another session's run (and its devices) away, and two versions cannot replace each other in
// a loop.

import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {Activity, busyReason, compareVersions, IDLE_MS, UNVERSIONED} from './daemon/activity.ts';
import {connect, keepReason} from './daemon/client.ts';
import {DAEMON_ACTIVITY, DAEMON_STOP, daemonFile, VERSION} from './daemon/info.ts';
import {leaseDir, processStart} from './lease/lease.ts';
import {isAlive} from './util/proc.ts';

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
  fs.rmSync(leaseDir(), {recursive: true, force: true});
});

const project = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-version-'));
  dirs.push(dir);
  const config = path.join(dir, 'pitbox.config.json');
  fs.writeFileSync(config, '{}');
  return config;
};

const gone = async (pid: number, ms = 15_000) => {
  const end = Date.now() + ms;
  while (isAlive(pid) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  return !isAlive(pid);
};

describe('activity', () => {
  it('counts calls in flight and the last call, but not pings', () => {
    const a = new Activity('1.0.0');
    a.begin('ping', '1.0.0', 0);
    expect(a.busy(0)).toBeUndefined();
    const done = a.begin('run', '1.0.0', 1000);
    expect(a.busy(IDLE_MS * 10)).toBe('1 call running');
    done(2000);
    expect(a.busy(2000 + IDLE_MS - 1)).toMatch(/^last call \d+ s ago$/);
    expect(a.busy(2000 + IDLE_MS)).toBeUndefined();
  });

  it('remembers the version of each recent client; one that sends none is an older pitbox', () => {
    const a = new Activity('1.0.0');
    a.begin('status', '1.0.0', 0)(0);
    a.begin('status', '0.9.0', 0)(0);
    a.begin('status', undefined, 0)(0);
    expect(a.strangers(1000).map(c => c.version)).toEqual(['0.9.0', UNVERSIONED]);
    expect(a.strangers(IDLE_MS + 1)).toEqual([]);
  });

  it('a daemon that reports nothing is not busy by its report', () => {
    expect(busyReason({inFlight: 0})).toBeUndefined();
  });

  it('orders versions', () => {
    expect(compareVersions('0.1.6', '0.1.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('a daemon in use', () => {
  it('refuses a stop from a client of another version, and stops on an explicit one', async () => {
    const c = await connect({config: project()});
    try {
      await c.call('no-such-method').catch(() => undefined);
      expect(await c.call(DAEMON_ACTIVITY)).toMatchObject({inFlight: 0, clients: [{version: c.info.version}]});
      // What an older pitbox sends when it finds a daemon of another version: a stop with no params.
      await expect(c.call(DAEMON_STOP, {})).rejects.toThrow(/is in use \(last call \d+ s ago\): it is not replaced by another version/);
      await expect(c.call(DAEMON_STOP, {keepLeases: true})).rejects.toThrow(/is in use/);
      expect(isAlive(c.info.pid)).toBe(true);
    } finally {
      await c.call(DAEMON_STOP, {by: 'user'}).catch(() => undefined);
    }
    expect(await gone(c.info.pid)).toBe(true);
  }, 60_000);

  it('lets an idle one go', async () => {
    const c = await connect({config: project()});
    await c.call(DAEMON_STOP, {});
    expect(await gone(c.info.pid)).toBe(true);
  }, 60_000);
});

/**
 * A daemon of another version, as a real process: it answers ping, reports `activity` (or, like a daemon from
 * before that report, does not know the method), and on a stop either refuses or exits. Every request it gets is
 * appended to `requests.log`.
 */
const fakeDaemon = async (opts: {version: string; activity?: object; refuseStop?: boolean}) => {
  const config = project();
  const dir = path.dirname(config);
  const stateDir = path.join(dir, '.pitbox');
  fs.mkdirSync(stateDir);
  const script = path.join(dir, 'daemon.cjs');
  const log = path.join(dir, 'requests.log');
  fs.writeFileSync(
    script,
    `const fs = require('fs');
const s = require('http').createServer((q, r) => { let b = ''; q.on('data', c => (b += c)); q.on('end', () => {
  const m = JSON.parse(b || '{}').method; fs.appendFileSync(${JSON.stringify(log)}, m + '\\n');
  if (m === ${JSON.stringify(DAEMON_ACTIVITY)}) return r.end(JSON.stringify(${JSON.stringify(opts.activity)} ? {ok: true, result: ${JSON.stringify(opts.activity ?? null)}} : {ok: false, error: 'unknown method: ' + m}));
  if (m === ${JSON.stringify(DAEMON_STOP)} && ${!!opts.refuseStop}) return r.end(JSON.stringify({ok: false, error: 'in use'}));
  r.end(JSON.stringify({ok: true, result: 'pong'}));
  if (m === ${JSON.stringify(DAEMON_STOP)}) setTimeout(() => process.exit(0), 50); }); });
s.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(daemonFile(stateDir))}, JSON.stringify({pid: process.pid, port: s.address().port, token: 't', config: '', root: ${JSON.stringify(dir)}, startedAt: Date.now(), version: ${JSON.stringify(opts.version)}})));`,
  );
  const child = spawn(process.execPath, [script], {stdio: 'ignore'});
  children.push(child);
  while (!fs.existsSync(daemonFile(stateDir))) await new Promise(r => setTimeout(r, 50));
  const requests = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return {config, dir, pid: child.pid!, requests};
};

describe('a daemon of another version', () => {
  const older = '0.0.1';

  it('is kept, and never sent a stop, when it is newer than this client', async () => {
    const d = await fakeDaemon({version: '999.0.0', activity: {version: '999.0.0', inFlight: 0, clients: []}});
    const c = await connect({config: d.config});
    expect(c.info.pid).toBe(d.pid);
    expect(c.note).toMatch(/runs version 999\.0\.0, this is .*, and it is not older than this one: using it as it is/);
    expect(d.requests()).not.toContain(DAEMON_STOP);
  }, 30_000);

  it('is kept while another session uses it, and the agent hears why', async () => {
    const d = await fakeDaemon({version: older, activity: {version: older, inFlight: 1, idleMs: 2000, clients: []}});
    const c = await connect({config: d.config});
    expect(c.info.pid).toBe(d.pid);
    expect(c.note).toMatch(/another session uses it \(1 call running\)/);
    expect(c.note).toMatch(/pitbox daemon restart/);
    expect(d.requests()).not.toContain(DAEMON_STOP);
    expect(isAlive(d.pid)).toBe(true);
  }, 30_000);

  it('is kept when it says nothing of its clients but holds a device', async () => {
    const d = await fakeDaemon({version: older});
    fs.mkdirSync(leaseDir(), {recursive: true});
    const now = Date.now();
    fs.writeFileSync(
      path.join(leaseDir(), 'apple-SIM1.json'),
      JSON.stringify({owner: `daemon:${d.dir}`, label: 'MyApp', pid: d.pid, pidStart: processStart(d.pid), root: d.dir, platform: 'apple', device: 'SIM1', since: now, heartbeat: now, ttlMs: 600_000, booted: true}),
    );
    const c = await connect({config: d.config});
    expect(c.info.pid).toBe(d.pid);
    expect(c.note).toMatch(/it holds 1 device and does not say whether a session is at work/);
    expect(d.requests()).not.toContain(DAEMON_STOP);
  }, 30_000);

  it('is kept when it refuses the stop (a session started meanwhile)', async () => {
    const d = await fakeDaemon({version: older, activity: {version: older, inFlight: 0, idleMs: IDLE_MS + 1, clients: []}, refuseStop: true});
    const c = await connect({config: d.config});
    expect(c.info.pid).toBe(d.pid);
    expect(c.note).toMatch(/another session started using it/);
    expect(d.requests()).toContain(DAEMON_STOP);
    expect(isAlive(d.pid)).toBe(true);
  }, 30_000);

  it('is replaced when it is older and idle', async () => {
    const d = await fakeDaemon({version: older, activity: {version: older, inFlight: 0, idleMs: IDLE_MS + 1, clients: []}});
    const c = await connect({config: d.config});
    try {
      expect(await gone(d.pid)).toBe(true);
      expect(c.info.version).toBe(VERSION);
      expect(c.note).toBeUndefined();
    } finally {
      await c.call(DAEMON_STOP, {by: 'user'}).catch(() => undefined);
      await gone(c.info.pid);
    }
  }, 60_000);
});

describe('two versions on one project', () => {
  it('never replace each other in turn: only the newer replaces the older, and only when it is idle', () => {
    const idle = {version: '', inFlight: 0, idleMs: IDLE_MS, clients: []};
    const busy = {version: '', inFlight: 0, idleMs: 1000, clients: []};
    // The newer client takes over an idle older daemon; the older client then keeps the newer daemon.
    expect(keepReason('1.0.0', '1.1.0', idle, 0)).toBeUndefined();
    expect(keepReason('1.1.0', '1.0.0', idle, 0)).toBeDefined();
    // Neither touches a daemon in use.
    expect(keepReason('1.0.0', '1.1.0', busy, 0)).toBeDefined();
    expect(keepReason('1.1.0', '1.0.0', busy, 0)).toBeDefined();
    // A daemon that cannot report its clients is replaced only while it holds no device.
    expect(keepReason('1.0.0', '1.1.0', undefined, 0)).toBeUndefined();
    expect(keepReason('1.0.0', '1.1.0', undefined, 2)).toMatch(/holds 2 devices/);
  });
});
