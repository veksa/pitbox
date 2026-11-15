// The browsers a project's daemon started for its web apps, recorded in `.pitbox/browsers.json`, so that the next
// daemon of the project closes those a previous one left behind.
//
// A daemon closes its browsers when it stops (Engine.stopAll). One that dies without stopping — SIGKILL, a crash —
// may leave them running with nobody to drive them: Playwright's headless shell ends itself when its pipe closes,
// but a browser that does not notice (a headed channel, a hung process) stays. Only what this project's daemon
// recorded is ever closed, and only while it is still that browser: the same pid started at the same second, with the
// automation pipe Playwright starts every browser with on its command line, and no live pitbox daemon as its parent
// (another project's daemon owns its own browsers, recorded in its own project's file). Windows: no command lines
// without PowerShell, so nothing is recorded or closed there.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {processStart} from '../../lease/lease.ts';
import {isAlive, killTreeAndWait} from '../../util/proc.ts';

export type RecordedBrowser = {pid: number; start: number};
export type ProcRow = {pid: number; ppid: number; command: string};

/** Playwright starts Chromium, Firefox and WebKit with an automation pipe; nothing else runs with one. */
export const BROWSER_ARGS = /\s(--remote-debugging-pipe|-juggler-pipe|--inspector-pipe)(\s|$)/;
const DAEMON_ARGS = /[\\/]daemon[\\/]main\.[cm]?[jt]s\s+--config\s/;

/** `ps -ax -o pid=,ppid=,command=` as rows. */
export const parseProcRows = (ps: string): ProcRow[] =>
  ps.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{pid: Number(m[1]), ppid: Number(m[2]), command: m[3]!}] : [];
  });

/** How processes are read and ended; tests stand in for it. */
export const browserProcs = {
  rows: (): ProcRow[] => {
    if (process.platform === 'win32') return [];
    try {
      return parseProcRows(execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], {encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: {...process.env, LC_ALL: 'C'}}));
    } catch {
      return [];
    }
  },
  start: (pid: number): number | undefined => processStart(pid),
  alive: isAlive,
  kill: (pid: number): Promise<boolean> => killTreeAndWait(pid, 5000),
};

const file = (stateDir: string) => path.join(stateDir, 'browsers.json');

const read = (stateDir: string): RecordedBrowser[] => {
  try {
    const list = JSON.parse(fs.readFileSync(file(stateDir), 'utf8')) as RecordedBrowser[];
    return Array.isArray(list) ? list.filter(b => b && typeof b.pid === 'number' && typeof b.start === 'number') : [];
  } catch {
    return [];
  }
};

const write = (stateDir: string, list: RecordedBrowser[]) => {
  if (!list.length) {
    fs.rmSync(file(stateDir), {force: true});
    return;
  }
  fs.mkdirSync(stateDir, {recursive: true});
  fs.writeFileSync(file(stateDir), JSON.stringify(list));
};

/** Records the browsers this process runs now (its children with an automation pipe), beside those still alive. */
export const recordBrowsers = (stateDir: string, parent = process.pid) => {
  const mine = browserProcs.rows().filter(r => r.ppid === parent && BROWSER_ARGS.test(r.command));
  const kept = read(stateDir).filter(b => browserProcs.alive(b.pid) && !mine.some(m => m.pid === b.pid));
  const added = mine.flatMap(m => {
    const start = browserProcs.start(m.pid);
    return start === undefined ? [] : [{pid: m.pid, start}];
  });
  write(stateDir, [...kept, ...added]);
};

/** Drops the browsers that are gone from the record (after a browser closed). */
export const forgetClosedBrowsers = (stateDir: string) => {
  const list = read(stateDir);
  const left = list.filter(b => browserProcs.alive(b.pid));
  if (left.length !== list.length) write(stateDir, left);
};

/**
 * Closes the browsers a previous daemon of this project recorded and left running, and empties the record. Run by a
 * daemon as it starts, once no other daemon of the config runs. Returns the pids it closed.
 */
export const reapOrphanBrowsers = async (stateDir: string): Promise<number[]> => {
  const list = read(stateDir);
  if (!list.length) return [];
  const rows = browserProcs.rows();
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const closed: number[] = [];
  for (const b of list) {
    const row = byPid.get(b.pid);
    if (!row || !BROWSER_ARGS.test(row.command)) continue;
    const start = browserProcs.start(b.pid);
    if (start === undefined || Math.abs(start - b.start) > 3) continue;
    // Still driven: its parent is a live pitbox daemon (this pid recorded by an older run, now another daemon's child).
    const parent = byPid.get(row.ppid);
    if (row.ppid > 1 && parent && DAEMON_ARGS.test(parent.command)) continue;
    if (await browserProcs.kill(b.pid)) closed.push(b.pid);
  }
  write(stateDir, []);
  return closed;
};
