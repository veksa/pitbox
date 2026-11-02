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

/** Connects to the project's daemon, starting it in the background when none is running. */
export const connect = async (opts: {config?: string; cwd?: string} = {}): Promise<DaemonClient> => {
  const {file, stateDir} = resolveProject(opts);
  const existing = readInfo(stateDir);
  if (existing && (await ping(existing))) return new DaemonClient(existing);

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
