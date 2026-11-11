// Two pitbox versions on one project: a daemon in use is never stopped for a version swap, so one session's
// restart cannot take another session's run (and its devices) away, and two versions cannot replace each other in
// a loop.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {Activity, busyReason, compareVersions, IDLE_MS, UNVERSIONED} from './daemon/activity.ts';
import {connect} from './daemon/client.ts';
import {DAEMON_ACTIVITY, DAEMON_STOP} from './daemon/info.ts';
import {isAlive} from './util/proc.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
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
