// Every daemon process of one project, found by the process list rather than by `.pitbox/daemon.json`.
//
// The file names one daemon. A second one for the same config (started by a client without the start lock, by hand, or
// by an older pitbox) overwrites it, and the first then runs on unreachable: `daemon status` and `stop` see only the
// newer one, while the older keeps its stand, its device runner and its timers alive for hours. So a daemon that
// starts stops the older daemons of its config that nobody can reach (or refuses to start when the one in the file
// answers), and `daemon status` / `stop` / `restart` look at every daemon process of the config.
//
// A daemon runs as `node <…>/daemon/main.(js|ts) --config <file>`: the config file is its last argument, so a path
// with spaces is read whole. Windows: no process list with command lines without PowerShell; nothing is found there.

import {execFileSync} from 'node:child_process';
import path from 'node:path';
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
  kill: (pid: number) => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone already
    }
  },
};

const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);

/** The live daemon processes of `file` other than this process. */
export const daemonsOf = (file: string): number[] => daemonProcs.list().filter(p => p.pid !== process.pid && same(p.config, file) && daemonProcs.alive(p.pid)).map(p => p.pid);

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
 * alive and answers (`reachable`: that pid, or undefined), else stops the others — nobody can reach them — and starts.
 */
export const takeOver = async (file: string, reachable: number | undefined, waitMs?: number): Promise<{refuse?: string; stopped: number[]; left: number[]}> => {
  if (reachable !== undefined && reachable !== process.pid) return {refuse: `pitbox daemon ${reachable} already runs for ${file}: use it (\`pitbox daemon status\`), or \`pitbox daemon restart\``, stopped: [], left: []};
  const others = daemonsOf(file);
  if (!others.length) return {stopped: [], left: []};
  const left = await stopDaemons(others, waitMs);
  return {stopped: others.filter(p => !left.includes(p)), left};
};
