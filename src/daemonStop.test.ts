// The daemon's own end: the whole stand down stops the project's daemon with every browser it started, an explicit
// stop does the same, a browser a dead daemon left is closed by the project's next daemon — and none of it
// ever reaches another project's daemon or browser. Real daemons and real Chromium, in child processes.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {connect, type DaemonClient} from './daemon/client.ts';
import {DAEMON_STOP, daemonFile} from './daemon/info.ts';
import {afterDown} from './daemon/server.ts';
import {stopProjectDaemon} from './daemon/stop.ts';
import {browserProcs, reapOrphanBrowsers, type ProcRow} from './drivers/web/orphans.ts';
import {leaseDir, processStart} from './lease/lease.ts';
import {isAlive} from './util/proc.ts';

const dirs: string[] = [];
const started: number[] = [];
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, {'content-type': 'text/html'}).end('<!doctype html><title>demo</title><p>hello</p>'));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as {port: number}).port;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

afterEach(async () => {
  // Whatever a failed test left running: only the processes this file started.
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true, maxRetries: 20, retryDelay: 250});
  fs.rmSync(leaseDir(), {recursive: true, force: true});
});

const project = (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pitbox-stop-${name}-`));
  dirs.push(dir);
  const config = path.join(dir, 'pitbox.config.json');
  fs.writeFileSync(config, JSON.stringify({web: {demo: {url: `http://127.0.0.1:${port}/`}}}));
  return config;
};

const gone = async (pid: number, ms = 15_000) => {
  const end = Date.now() + ms;
  while (isAlive(pid) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  return !isAlive(pid);
};

/** Starts the project's daemon and its web app's browser; returns the client and the browser's pid. */
const withBrowser = async (config: string): Promise<{c: DaemonClient; browser: number}> => {
  const c = await connect({config});
  started.push(c.info.pid);
  await c.call('open', {device: 'web:demo'});
  const recorded = JSON.parse(fs.readFileSync(path.join(path.dirname(config), '.pitbox', 'browsers.json'), 'utf8')) as {pid: number}[];
  expect(recorded).toHaveLength(1);
  const browser = recorded[0]!.pid;
  started.push(browser);
  expect(isAlive(browser)).toBe(true);
  return {c, browser};
};

describe('after a down', () => {
  it('stops the daemon when the whole stand goes down, keeps it for named services, when asked, or while another call runs', () => {
    expect(afterDown({}, 0)).toBe('stopping');
    expect(afterDown({services: []}, 0)).toBe('stopping');
    expect(afterDown({services: ['api']}, 0)).toBeUndefined();
    expect(afterDown({keepDaemon: true}, 0)).toBe('kept (asked to)');
    expect(afterDown({}, 2)).toMatch(/^kept: 2 calls of another session still running in it; `pitbox daemon stop`/);
  });
});

// Real Chromium through Playwright, as the web device tests use it; POSIX: the browser record reads `ps`.
describe.skipIf(process.platform === 'win32')('the daemon and its browsers', () => {
  it("goes with the whole stand down, browser and all, and leaves another project's daemon and browser running", {timeout: 120_000}, async () => {
    const a = await withBrowser(project('a'));
    const b = await withBrowser(project('b'));
    const r = (await a.c.call('down', {})) as {daemon?: string};
    expect(r.daemon).toBe('stopping');
    expect(await gone(a.c.info.pid)).toBe(true);
    expect(await gone(a.browser)).toBe(true);
    expect(fs.existsSync(daemonFile(path.join(path.dirname(a.c.info.config), '.pitbox')))).toBe(false);
    // The other project's stand is untouched.
    expect(isAlive(b.c.info.pid)).toBe(true);
    expect(isAlive(b.browser)).toBe(true);
    await b.c.call(DAEMON_STOP, {release: true, by: 'user'});
    expect(await gone(b.c.info.pid)).toBe(true);
    expect(await gone(b.browser)).toBe(true);
  });

  it('stays after a down that keeps it, and an explicit stop closes its browser with it', {timeout: 120_000}, async () => {
    const config = project('keep');
    const {c, browser} = await withBrowser(config);
    const r = (await c.call('down', {keepDaemon: true})) as {daemon?: string};
    expect(r.daemon).toBe('kept (asked to)');
    expect(isAlive(c.info.pid)).toBe(true);
    const s = await stopProjectDaemon({config}, 'stop');
    expect(s).toMatchObject({stopped: true, failed: false, lines: ['stopped']});
    expect(isAlive(c.info.pid)).toBe(false);
    expect(await gone(browser)).toBe(true);
  });

  it('has a browser an earlier daemon left running closed by the next daemon of the project', {timeout: 120_000}, async () => {
    // Playwright's headless shell ends itself when its daemon dies (its pipe closes); a browser that does not — a
    // headed channel, a hung one — stands in here as a process with the automation pipe on its command line.
    const config = project('killed');
    const stateDir = path.join(path.dirname(config), '.pitbox');
    const script = path.join(path.dirname(config), 'browser.cjs');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    const fake = spawn(process.execPath, [script, '--remote-debugging-pipe'], {detached: true, stdio: 'ignore'});
    fake.unref();
    started.push(fake.pid!);
    await new Promise(r => setTimeout(r, 1500));
    fs.mkdirSync(stateDir, {recursive: true});
    fs.writeFileSync(path.join(stateDir, 'browsers.json'), JSON.stringify([{pid: fake.pid, start: processStart(fake.pid!)}]));
    const c = await connect({config});
    started.push(c.info.pid);
    expect(await gone(fake.pid!)).toBe(true);
    expect(fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8')).toContain(`closed 1 browser an earlier daemon of this project left running: pid ${fake.pid}`);
    await c.call(DAEMON_STOP, {release: true, by: 'user'});
    expect(await gone(c.info.pid)).toBe(true);
  });
});

describe('closing orphaned browsers', () => {
  it('closes only the recorded browser that is still that browser and that no live daemon drives', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-orphans-'));
    dirs.push(dir);
    const pipe = '/x/chrome-headless-shell --headless --remote-debugging-pipe --no-startup-window';
    const rows: ProcRow[] = [
      {pid: 10, ppid: 1, command: pipe},
      // Same pid, started later: reused by another browser.
      {pid: 11, ppid: 1, command: pipe},
      // Reused by something that is not a browser at all.
      {pid: 12, ppid: 1, command: '/usr/bin/vim notes.txt'},
      // A live daemon's child: driven.
      {pid: 13, ppid: 50, command: pipe},
      {pid: 50, ppid: 1, command: 'node /p/node_modules/@veksa/pitbox/dist/daemon/main.js --config /p/pitbox.config.ts'},
    ];
    const starts: Record<number, number> = {10: 1000, 11: 2000, 12: 1000, 13: 1000};
    const killed: number[] = [];
    const saved = {...browserProcs};
    Object.assign(browserProcs, {rows: () => rows, start: (pid: number) => starts[pid], alive: () => true, kill: async (pid: number) => (killed.push(pid), true)});
    try {
      fs.mkdirSync(path.join(dir, '.pitbox'));
      const record = [10, 11, 12, 13, 14].map(pid => ({pid, start: 1000}));
      fs.writeFileSync(path.join(dir, '.pitbox', 'browsers.json'), JSON.stringify(record));
      expect(await reapOrphanBrowsers(path.join(dir, '.pitbox'))).toEqual([10]);
      expect(killed).toEqual([10]);
      expect(fs.existsSync(path.join(dir, '.pitbox', 'browsers.json'))).toBe(false);
    } finally {
      Object.assign(browserProcs, saved);
    }
  });
});
