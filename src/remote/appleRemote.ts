// The Apple side of a remote Mac (`pitbox serve-devices` there): the same calls as the local Apple driver, the
// runner and the crash reports, over the device host's HTTP. Everything above them — settling, flows, visual
// baselines, recordings — runs on this machine; only raw device operations cross the network.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {run} from '../util/proc.ts';
import type {AppEvent} from '../drivers/android/events.ts';
import type {AppleDriver, Simulator} from '../drivers/apple/driver.ts';
import type {CrashSource, UiRunner} from '../ui/device.ts';

/** What the engine uses of an Apple driver; the local driver and the remote one both provide it. */
export type AppleDevices = Pick<
  AppleDriver,
  'simulators' | 'booted' | 'resolve' | 'boot' | 'shutdown' | 'install' | 'open' | 'stop' | 'clear' | 'uninstall' | 'packages' | 'logs' | 'settings' | 'screenshot' | 'info' | 'perf' | 'setDefaults'
>;

export class RemoteApple implements AppleDevices {
  readonly url: string;
  readonly #token: string;
  #local?: Promise<string | undefined>;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/+$/, '');
    this.#token = token;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10 * 60_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/`, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'x-pitbox-token': this.#token},
        body: JSON.stringify({method, params}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`the Mac at ${this.url} does not answer (${(e as Error).message})\nhint: is \`pitbox serve-devices\` running there and the VPN up?`);
    }
    if (res.status === 403) throw new Error(`the Mac at ${this.url} refused the token\nhint: set PITBOX_REMOTE_TOKEN to the token \`pitbox serve-devices\` printed`);
    const body = (await res.json()) as {ok: boolean; result?: T; error?: string};
    if (!body.ok) throw new Error(body.error ?? 'device host error');
    return body.result as T;
  }

  /** This machine's address as the Mac sees it — what a simulator app uses to reach a server here. */
  localAddress(): Promise<string | undefined> {
    this.#local ??= new Promise(resolve => {
      const u = new URL(this.url);
      const sock = net.connect(Number(u.port || 80), u.hostname, () => {
        resolve(sock.localAddress?.replace(/^::ffff:/, ''));
        sock.destroy();
      });
      sock.setTimeout(5000, () => {
        sock.destroy();
        resolve(undefined);
      });
      sock.on('error', () => resolve(undefined));
    });
    return this.#local;
  }

  simulators = () => this.call<Simulator[]>('simulators');
  booted = () => this.call<Simulator[]>('booted');
  resolve = (selector?: string) => this.call<string>('resolve', {selector});
  boot = (selector: string, opts: {headless?: boolean; wipe?: boolean; timeoutMs?: number} = {}) => this.call<Awaited<ReturnType<AppleDriver['boot']>>>('boot', {selector, opts});
  shutdown = (udid: string) => this.call<{ms: number; gone: boolean}>('shutdown', {udid});
  open = (udid: string, target: string, opts: {relaunch?: boolean; bundleId?: string; args?: string[]} = {}) => this.call<{totalMs?: number; pid?: number}>('open', {udid, target, opts});
  stop = async (udid: string, bundleId: string) => void (await this.call('stop', {udid, bundleId}));
  clear = async (udid: string, bundleId: string) => void (await this.call('clear', {udid, bundleId}));
  uninstall = async (udid: string, bundleId: string) => void (await this.call('uninstall', {udid, bundleId}));
  packages = (udid: string, filter?: string) => this.call<string[]>('packages', {udid, filter});
  logs = (udid: string, opts: Parameters<AppleDriver['logs']>[1] = {}) => this.call<string[]>('logs', {udid, opts});
  settings = (udid: string, settings: Parameters<AppleDriver['settings']>[1]) => this.call<string[]>('settings', {udid, settings});
  info = (udid: string) => this.call<Record<string, string>>('info', {udid});
  perf = (udid: string, bundleId: string, reset = false) => this.call<Awaited<ReturnType<AppleDriver['perf']>>>('perf', {udid, bundleId, reset});
  setDefaults = async (udid: string, bundleId: string, values: Record<string, string>) => void (await this.call('setDefaults', {udid, bundleId, values}));

  async screenshot(udid: string, file: string): Promise<{file: string; bytes: number}> {
    const r = await this.call<{png: string}>('screenshot', {udid});
    const buf = Buffer.from(r.png, 'base64');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, buf);
    return {file, bytes: buf.length};
  }

  /** Packs the .app with tar (on Windows too: tar ships with it), uploads it and installs it on the Mac. */
  async install(udid: string, bundle: string): Promise<{ms: number; replaced: boolean; bundleId?: string}> {
    if (!fs.existsSync(bundle)) throw new Error(`no such file: ${bundle}`);
    const t0 = Date.now();
    const tarFile = path.join(path.dirname(bundle), `.${path.basename(bundle)}.pitbox.tar`);
    const r = await run('tar', ['-cf', tarFile, '-C', path.dirname(bundle), path.basename(bundle)], {timeoutMs: 300_000});
    if (r.code !== 0) throw new Error(`could not pack ${bundle}: ${r.stderr.trim()}`);
    try {
      const res = await fetch(`${this.url}/upload`, {
        method: 'POST',
        headers: {'x-pitbox-token': this.#token, 'content-type': 'application/x-tar'},
        body: fs.readFileSync(tarFile),
        signal: AbortSignal.timeout(15 * 60_000),
      });
      const body = (await res.json()) as {ok: boolean; result?: {upload: string}; error?: string};
      if (!body.ok || !body.result) throw new Error(body.error ?? 'upload failed');
      const installed = await this.call<{ms: number; replaced: boolean; bundleId?: string}>('install', {udid, upload: body.result.upload});
      return {...installed, ms: Date.now() - t0};
    } finally {
      fs.rmSync(tarFile, {force: true});
    }
  }
}

/** The Mac's runner for one simulator, called through the device host. */
export class RemoteAppleRunner implements UiRunner {
  readonly #remote: RemoteApple;
  readonly #udid: string;
  bundleId?: string;

  constructor(remote: RemoteApple, udid: string, bundleId?: string) {
    this.#remote = remote;
    this.#udid = udid;
    this.bundleId = bundleId;
  }

  call<T extends Record<string, unknown> = Record<string, unknown>>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    // The first call builds and starts the runner on the Mac: minutes, not seconds.
    return this.#remote.call<T>('runner', {udid: this.#udid, bundleId: this.bundleId, cmd, args, timeoutMs}, Math.max(timeoutMs, 30_000) + 15 * 60_000);
  }

  async stop() {
    await this.#remote.call('runnerStop', {udid: this.#udid}, 15_000).catch(() => undefined);
  }
}

export class RemoteAppleCrashes implements CrashSource {
  readonly #remote: RemoteApple;
  readonly #udid: string;
  readonly #bundleId?: string;
  #begun?: Promise<unknown>;

  constructor(remote: RemoteApple, udid: string, bundleId?: string) {
    this.#remote = remote;
    this.#udid = udid;
    this.#bundleId = bundleId;
  }

  start() {}

  stop() {}

  begin(front?: string[]) {
    this.#begun = this.#remote.call('crashBegin', {udid: this.#udid, bundleId: this.#bundleId, front}, 15_000).catch(() => undefined);
  }

  async since(t: number): Promise<AppEvent[]> {
    await this.#begun;
    const r = await this.#remote.call<{events: AppEvent[]; now: number}>('crashes', {udid: this.#udid, bundleId: this.#bundleId, ageMs: Date.now() - t}, 30_000);
    // The Mac's times onto this machine's clock.
    const shift = Date.now() - r.now;
    return r.events.map(e => ({...e, at: e.at + shift}));
  }
}
