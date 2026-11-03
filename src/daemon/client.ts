// Client side of the daemon: finds the running daemon for a project or starts one, then calls it.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {findConfig} from '../config/load.ts';
import {isAlive} from '../util/proc.ts';
import {daemonFile, type DaemonInfo} from './info.ts';

export class DaemonClient {
  readonly info: DaemonInfo;

  constructor(info: DaemonInfo) {
    this.info = info;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15 * 60_000): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.info.port}/`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-pitbox-token': this.info.token},
      body: JSON.stringify({method, params}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as {ok: boolean; result?: T; error?: string};
    if (!body.ok) throw new Error(body.error ?? `daemon error (${res.status})`);
    return body.result as T;
  }
}

const readInfo = (stateDir: string): DaemonInfo | undefined => {
  try {
    return JSON.parse(fs.readFileSync(daemonFile(stateDir), 'utf8')) as DaemonInfo;
  } catch {
    return undefined;
  }
};

const ping = async (info: DaemonInfo) => {
  if (!isAlive(info.pid)) return false;
  try {
    await new DaemonClient(info).call('ping', {}, 3000);
    return true;
  } catch {
    return false;
  }
};

/** The daemon entry next to this module, in whatever form pitbox runs (sources or build). */
const daemonEntry = () => {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), `main${path.extname(here)}`);
};

export const resolveProject = (opts: {config?: string; cwd?: string}) => {
  const file = opts.config ? path.resolve(opts.config) : findConfig(opts.cwd ?? process.cwd());
  if (!file) throw new Error(`no pitbox.config.ts found from ${opts.cwd ?? process.cwd()} upwards — create one or pass --config`);
  return {file, stateDir: path.join(path.dirname(file), '.pitbox')};
};

export const runningDaemon = async (opts: {config?: string; cwd?: string}) => {
  const {stateDir} = resolveProject(opts);
  const info = readInfo(stateDir);
  return info && (await ping(info)) ? new DaemonClient(info) : undefined;
};

/** Refused, not slow: nothing listens on the daemon's port, so the pid in its file is someone else's now. */
const refused = (e: unknown) => /ECONNREFUSED/.test(String((e as {cause?: {code?: string}})?.cause?.code ?? (e as Error)?.message));

/**
 * Waits for a daemon that is alive but slow to answer (a busy moment), up to `waitMs`. A second daemon for the
 * same project would fight the first for its ports and devices, so one that never answers is an error.
 */
const waitForBusy = async (info: DaemonInfo, waitMs: number): Promise<boolean> => {
  const end = Date.now() + waitMs;
  let first = true;
  while (isAlive(info.pid)) {
    try {
      // A quick answer is the usual case; after that one ping waits for the rest of the time.
      await new DaemonClient(info).call('ping', {}, first ? 3000 : Math.max(500, end - Date.now()));
      return true;
    } catch (e) {
      if (refused(e)) return false;
      first = false;
      if (Date.now() > end) throw new Error(`pitbox daemon ${info.pid} is running but has not answered for ${Math.round(waitMs / 1000)}s; stop it (pitbox daemon stop, or end the process) and try again`);
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return false;
};

/** Connects to the project's daemon, starting it in the background when none is running. */
export const connect = async (opts: {config?: string; cwd?: string; busyWaitMs?: number} = {}): Promise<DaemonClient> => {
  const {file, stateDir} = resolveProject(opts);
  const existing = readInfo(stateDir);
  if (existing && (await waitForBusy(existing, opts.busyWaitMs ?? 20_000))) return new DaemonClient(existing);

  fs.mkdirSync(stateDir, {recursive: true});
  const log = fs.openSync(path.join(stateDir, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [daemonEntry(), '--config', file], {
    cwd: path.dirname(file),
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150));
    const info = readInfo(stateDir);
    if (info && info.pid === child.pid && (await ping(info))) return new DaemonClient(info);
    if (child.exitCode !== null) break;
  }
  const tail = fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8').split('\n').slice(-12).join('\n');
  throw new Error(`pitbox daemon did not start:\n${tail}`);
};
