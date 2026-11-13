// Every daemon process of one project, found by the process list rather than by `.pitbox/daemon.json`.
//
// The file names one daemon. A second one for the same config (started by a client without the start lock, by hand, or
// by an older pitbox) overwrites it, and the first then runs on unreachable: `daemon status` and `stop` see only the
// newer one, while the older keeps its stand, its device runner and its timers alive for hours. So a daemon that
// starts stops the older daemons of its config that nobody can reach (or refuses to start when the one in the file
// answers), and `daemon status` / `stop` / `restart` look at every daemon process of the config.
//
// A daemon runs as `node <…>/daemon/main.(js|ts) --config <file>`: the config file is its last argument, so a path
// with spaces is read whole; a relative one is resolved against that process's own working folder (lsof, /proc), and
// never matches when that cannot be read. Windows: no process list with command lines without PowerShell; nothing is
// found there.
//
// Two daemons starting at once must not stop each other: each takes the config's start lock (server.ts) from this
// check until its daemon file is written, so the second finds the first answering and refuses; and a daemon still
// starting (younger than START_GRACE_MS, or of unknown age) is never stopped — it may be an older pitbox's that took
// no lock, and it is not the unreachable leftover this is about.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {processStart} from '../lease/lease.ts';
import {isAlive} from '../util/proc.ts';

export type DaemonProc = {pid: number; config: string};

const DAEMON_ARGS = /[\\/]daemon[\\/]main\.[cm]?[jt]s\s+--config\s+(.+?)\s*$/;

/** `ps -ax -o pid=,command=` → the pitbox daemons in it with their config files. */
export const parseDaemonProcs = (ps: string): DaemonProc[] =>
  ps.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    const args = m ? DAEMON_ARGS.exec(m[2]!) : undefined;
    return m && args ? [{pid: Number(m[1]), config: args[1]!}] : [];
  });

/** How processes are listed and stopped; tests stand in for it. */
export const daemonProcs = {
  list: (): DaemonProc[] => {
    if (process.platform === 'win32') return [];
    try {
      return parseDaemonProcs(execFileSync('ps', ['-ax', '-o', 'pid=,command='], {encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: {...process.env, LC_ALL: 'C'}}));
    } catch {
      return [];
    }
  },
  alive: isAlive,
  /** When the process started, epoch seconds; undefined when the system cannot tell. */
  start: (pid: number): number | undefined => processStart(pid),
  /** The process's working folder; undefined when the system cannot tell. */
  cwd: (pid: number): string | undefined => {
    try {
      if (process.platform === 'linux') return fs.readlinkSync(`/proc/${pid}/cwd`);
      if (process.platform !== 'darwin') return undefined;
      const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']});
      return out.split('\n').find(l => l.startsWith('n'))?.slice(1) || undefined;
    } catch {
      return undefined;
    }
  },
  kill: (pid: number) => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone already
    }
  },
};

/** Whether a daemon process runs for `file`: its relative `--config` taken from its own folder, never from this one's. */
const runsFor = (p: DaemonProc, file: string): boolean => {
  if (path.isAbsolute(p.config)) return path.resolve(p.config) === path.resolve(file);
  const cwd = daemonProcs.cwd(p.pid);
  return !!cwd && path.resolve(cwd, p.config) === path.resolve(file);
};

/** The live daemon processes of `file` other than this process. */
export const daemonsOf = (file: string): number[] => daemonProcs.list().filter(p => p.pid !== process.pid && runsFor(p, file) && daemonProcs.alive(p.pid)).map(p => p.pid);

/** A daemon younger than this may still be starting: it is never stopped as unreachable. */
export const START_GRACE_MS = 30_000;

/**
 * Stops daemon processes with SIGTERM — the daemon's own stop: services and device leases are kept for the next
 * daemon of the project, which adopts the leases — and waits up to `waitMs` for them to end. Returns those still alive.
 */
export const stopDaemons = async (pids: number[], waitMs = 15_000): Promise<number[]> => {
  for (const pid of pids) daemonProcs.kill(pid);
  const end = Date.now() + waitMs;
  let left = pids.filter(daemonProcs.alive);
  while (left.length && Date.now() < end) {
    await new Promise(r => setTimeout(r, 150));
    left = left.filter(daemonProcs.alive);
  }
  return left;
};

/**
 * What a daemon about to start does about the other daemons of its config: refuses when the one in the daemon file is
 * alive and answers (`reachable`: that pid, or undefined), else stops the others that have run past START_GRACE_MS —
 * nobody can reach them — and starts. One still starting (`starting`) is left alone.
 */
export const takeOver = async (file: string, reachable: number | undefined, waitMs?: number, now = Date.now()): Promise<{refuse?: string; stopped: number[]; left: number[]; starting: number[]}> => {
  if (reachable !== undefined && reachable !== process.pid) return {refuse: `pitbox daemon ${reachable} already runs for ${file}: use it (\`pitbox daemon status\`), or \`pitbox daemon restart\``, stopped: [], left: [], starting: []};
  const others = daemonsOf(file);
  const settled = (pid: number) => {
    const start = daemonProcs.start(pid);
    return start !== undefined && now - start * 1000 >= START_GRACE_MS;
  };
  const old = others.filter(settled);
  const starting = others.filter(p => !old.includes(p));
  if (!old.length) return {stopped: [], left: [], starting};
  const left = await stopDaemons(old, waitMs);
  return {stopped: old.filter(p => !left.includes(p)), left, starting};
};
