// Process helpers: one shell per platform, commands with timeouts, and killing whole process trees.

import {spawn, type ChildProcess, type SpawnOptions} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type ShellKind = 'bash' | 'sh' | 'cmd';
export type Shell = {kind: ShellKind; file: string; args: (command: string) => string[]};

const gitBashCandidates = () => [
  process.env.PITBOX_BASH,
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : undefined,
];

let cachedShell: Shell | undefined;

/**
 * The shell project commands run in. Stand commands are usually written for a POSIX shell, so on Windows
 * Git Bash is preferred when it is installed and `cmd.exe` is the fallback.
 */
export const resolveShell = (preferred?: string): Shell => {
  if (preferred === 'cmd') return {kind: 'cmd', file: process.env.ComSpec ?? 'cmd.exe', args: c => ['/d', '/s', '/c', c]};
  if (preferred && preferred !== 'bash' && preferred !== 'sh') {
    return {kind: 'bash', file: preferred, args: c => ['-c', c]};
  }
  if (cachedShell && !preferred) return cachedShell;
  let shell: Shell;
  if (process.platform === 'win32') {
    const bash = gitBashCandidates().find(p => p && fs.existsSync(p));
    shell = bash
      ? {kind: 'bash', file: bash, args: c => ['-c', c]}
      : {kind: 'cmd', file: process.env.ComSpec ?? 'cmd.exe', args: c => ['/d', '/s', '/c', c]};
  } else {
    shell = fs.existsSync('/bin/bash') ? {kind: 'bash', file: '/bin/bash', args: c => ['-c', c]} : {kind: 'sh', file: '/bin/sh', args: c => ['-c', c]};
  }
  if (!preferred) cachedShell = shell;
  return shell;
};

/** Quotes one argument for the given shell. */
export const quoteArg = (value: string, kind: ShellKind): string => {
  if (kind === 'cmd') {
    return /[\s"&|<>^%]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
};

export type RunResult = {code: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number};

/** Runs an executable directly (no shell) and collects its output. */
export const run = (file: string, args: string[], opts: {cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; encoding?: BufferEncoding | 'buffer'} = {}): Promise<RunResult & {buffer?: Buffer}> =>
  new Promise(resolve => {
    const t0 = performance.now();
    const child = spawn(file, args, {cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : undefined;
    child.stdout?.on('data', d => out.push(d));
    child.stderr?.on('data', d => err.push(d));
    child.on('error', e => err.push(Buffer.from(String(e))));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      const buffer = Buffer.concat(out);
      resolve({
        code,
        stdout: opts.encoding === 'buffer' ? '' : buffer.toString(opts.encoding ?? 'utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        ms: Math.round(performance.now() - t0),
        ...(opts.encoding === 'buffer' ? {buffer} : {}),
      });
    });
  });

/** Runs a command line through the project shell and collects its output. */
export const runShell = (command: string, opts: {cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: string} = {}) => {
  const shell = resolveShell(opts.shell);
  return run(shell.file, shell.args(command), opts);
};

/**
 * Starts a long-lived command through the project shell, detached: its own process group on POSIX, its own
 * hidden console on Windows. Without that a Windows child shares the daemon's console, and when the daemon
 * exits the console's close event kills console processes deep in the child's tree — an API server under a
 * file watcher dies while the watcher lives on, which looks like the server crashing on its own.
 */
export const spawnShell = (command: string, opts: SpawnOptions & {shell?: string} = {}): ChildProcess => {
  const shell = resolveShell(typeof opts.shell === 'string' ? opts.shell : undefined);
  const {shell: _ignored, ...rest} = opts;
  return spawn(shell.file, shell.args(command), {windowsHide: true, detached: true, ...rest});
};

/** Kills a process and everything it started. */
export const killTree = (child: ChildProcess | number) => {
  const pid = typeof child === 'number' ? child : child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // already gone
  }
};

export type ProcInfo = {pid: number; ppid: number; name: string; created: number};

let tableCache: {at: number; procs: ProcInfo[]} | undefined;

/**
 * The Windows process table. Needed because a command started through Git Bash runs as a chain of processes
 * (bash → bash → node → cmd → node) in which the root can exit while its descendants live on: they keep the
 * dead root as their ParentProcessId, so the tree is still found from the root's pid.
 */
export const processTable = async (maxAgeMs = 1500): Promise<ProcInfo[]> => {
  if (process.platform !== 'win32') return [];
  if (tableCache && Date.now() - tableCache.at < maxAgeMs) return tableCache.procs;
  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$([long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds),$($_.Name)" }`],
    {timeoutMs: 20_000},
  );
  const procs = r.stdout
    .split(/\r?\n/)
    .map(l => l.split(','))
    .filter(p => p.length >= 4)
    .map(([pid, ppid, created, ...name]) => ({pid: Number(pid), ppid: Number(ppid), created: Number(created), name: name.join(',')}));
  tableCache = {at: Date.now(), procs};
  return procs;
};

/** Descendants of `root` (alive or not) created at or after `since`, which guards against reused pids. */
export const descendants = (procs: ProcInfo[], root: number, since = 0): number[] => {
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }
  const out: number[] = [];
  const queue = [root];
  const seen = new Set(queue);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of children.get(cur) ?? []) {
      if (seen.has(c.pid) || c.created < since - 2000) continue;
      seen.add(c.pid);
      out.push(c.pid);
      queue.push(c.pid);
    }
  }
  return out;
};

/** Pids of a tree that are still alive: the root and, on Windows, every descendant found from it. */
export const liveTree = async (root: number, since = 0): Promise<number[]> => {
  if (process.platform !== 'win32') return isAlive(root) ? [root] : [];
  const procs = await processTable();
  const alive = new Set(procs.map(p => p.pid));
  return [root, ...descendants(procs, root, since)].filter(p => alive.has(p));
};

/** Kills a process tree — including descendants that outlived their root — and waits until it is gone. */
export const killTreeAndWait = async (pid: number, timeoutMs = 5000, since = 0): Promise<boolean> => {
  if (process.platform === 'win32') {
    const pids = await liveTree(pid, since);
    if (pids.length) await run('taskkill', ['/T', '/F', ...pids.flatMap(p => ['/PID', String(p)])], {timeoutMs});
    tableCache = undefined;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!pids.some(isAlive)) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return !pids.some(isAlive);
  }
  killTree(pid);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return !isAlive(pid);
};

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Finds an executable on PATH. */
export const which = (name: string): string | undefined => {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (fs.existsSync(candidate)) return candidate;
      const upper = path.join(dir, name + ext);
      if (fs.existsSync(upper)) return upper;
    }
  }
  return undefined;
};
