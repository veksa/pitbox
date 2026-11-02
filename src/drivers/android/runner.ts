// Host side of the Android runner: installs the runner APK when its version differs, starts it through
// `am instrument`, forwards its port, and keeps one connection with a request queue. A dead runner (the app
// under test crashed the instrumentation, the device rebooted) is restarted on the next call.

import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AndroidDriver} from './driver.ts';
import {AndroidError} from './driver.ts';

export const RUNNER_PACKAGE = 'dev.pitbox.runner';
/** Must match `versionCode` in runners/android/build.gradle.kts. */
export const RUNNER_VERSION = 4;
const DEVICE_PORT = 7912;

export const runnerApk = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'runners', 'android', 'pitbox-runner.apk');
};

type Pending = {resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout};

export class AndroidRunner {
  readonly serial: string;
  readonly #driver: AndroidDriver;
  #child?: ChildProcess;
  #socket?: net.Socket;
  #hostPort?: number;
  #buffer = '';
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #starting?: Promise<void>;

  constructor(driver: AndroidDriver, serial: string) {
    this.#driver = driver;
    this.serial = serial;
  }

  get alive() {
    return !!this.#socket && !this.#socket.destroyed;
  }

  async #installedVersion(): Promise<number | undefined> {
    const out = await this.#driver.shell(this.serial, `dumpsys package ${RUNNER_PACKAGE} | grep versionCode`).catch(() => '');
    const v = /versionCode=(\d+)/.exec(out)?.[1];
    return v ? Number(v) : undefined;
  }

  async #ensureInstalled() {
    if ((await this.#installedVersion()) === RUNNER_VERSION) return;
    const apk = runnerApk();
    if (!fs.existsSync(apk)) throw new AndroidError(`runner APK missing: ${apk}`, 'build it with `yarn build-runner`');
    const r = await this.#driver.adb(['install', '-r', '-t', '-d', apk], this.serial, {timeoutMs: 120_000});
    if (!/Success/.test(r.stdout + r.stderr)) throw new AndroidError(`runner install failed: ${(r.stdout + r.stderr).trim().split('\n').pop()}`);
  }

  start(): Promise<void> {
    if (this.alive) return Promise.resolve();
    this.#starting ??= this.#start().finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  async #start() {
    this.#teardown();
    await this.#ensureInstalled();
    await this.#driver.shell(this.serial, `am force-stop ${RUNNER_PACKAGE}`);
    const child = spawn(this.#driver.adbPath, ['-s', this.serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'port', String(DEVICE_PORT), `${RUNNER_PACKAGE}/.RunnerInstrumentation`], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    this.#child = child;
    let output = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AndroidError('runner did not start in 60s', output.trim().split('\n').slice(-3).join(' ') || 'check `app-logs --all --grep pitbox`')), 60_000);
      const onData = (d: Buffer) => {
        output += d.toString();
        if (output.includes('pitbox=ready')) {
          clearTimeout(timer);
          resolve();
        } else if (/INSTRUMENTATION_FAILED|INSTRUMENTATION_RESULT: shortMsg=|already registered|Error type/.test(output)) {
          clearTimeout(timer);
          const busy = /already registered|UiAutomation/.test(output);
          reject(new AndroidError(`runner failed to start: ${output.trim().split('\n').slice(-2).join(' ')}`, busy ? 'another UI automation tool holds UiAutomation on this device — stop it first' : undefined));
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new AndroidError(`runner exited: ${output.trim().split('\n').slice(-2).join(' ')}`));
      });
    });
    child.on('exit', () => this.#teardown());
    const fwd = await this.#driver.adb(['forward', 'tcp:0', `tcp:${DEVICE_PORT}`], this.serial);
    this.#hostPort = Number(fwd.stdout.trim());
    if (!this.#hostPort) throw new AndroidError(`adb forward failed: ${fwd.stderr.trim()}`);
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(this.#hostPort!, '127.0.0.1', () => resolve());
      s.setNoDelay(true);
      s.on('error', e => {
        reject(e);
        this.#fail(e);
      });
      s.on('close', () => this.#fail(new Error('runner connection closed')));
      s.on('data', (d: Buffer) => this.#onData(d));
      this.#socket = s;
    });
  }

  #onData(d: Buffer) {
    this.#buffer += d.toString('utf8');
    let k: number;
    while ((k = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, k);
      this.#buffer = this.#buffer.slice(k + 1);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.#pending.get(Number(msg.id));
      if (!p) continue;
      this.#pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new AndroidError(`runner: ${msg.error}`));
    }
  }

  #fail(e: Error) {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.#pending.clear();
    this.#socket = undefined;
  }

  #teardown() {
    this.#socket?.destroy();
    this.#socket = undefined;
    if (this.#child && this.#child.exitCode === null) this.#child.kill();
    this.#child = undefined;
    if (this.#hostPort) void this.#driver.adb(['forward', '--remove', `tcp:${this.#hostPort}`], this.serial).catch(() => undefined);
    this.#hostPort = undefined;
  }

  async call<T extends Record<string, unknown> = Record<string, unknown>>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    await this.start();
    const id = this.#nextId++;
    const socket = this.#socket;
    if (!socket) throw new AndroidError('runner not connected');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AndroidError(`runner: ${cmd} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {resolve: v => resolve(v as T), reject, timer});
      socket.write(`${JSON.stringify({id, cmd, ...args})}\n`);
    });
  }

  async stop() {
    if (this.alive) await this.call('shutdown', {}, 3000).catch(() => undefined);
    this.#teardown();
  }
}
