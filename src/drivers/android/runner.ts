// Host side of the Android runner: installs the runner APK when its version differs, starts it through
// `am instrument` (detached on the device, shared by every pitbox daemon there), forwards its port, and keeps one
// connection with a request queue. A dead runner (the device rebooted) is restarted on the next call.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AndroidDriver} from './driver.ts';
import {AndroidError} from './driver.ts';

export const RUNNER_PACKAGE = 'dev.pitbox.runner';
/** Must match `versionCode` in runners/android/build.gradle.kts. */
export const RUNNER_VERSION = 17;
const DEVICE_PORT = 7912;
/** The instrumentation's output on the device: its ready line or why it failed. */
const RUNNER_OUT = '/data/local/tmp/pitbox-runner.out';

export const runnerApk = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'runners', 'android', 'pitbox-runner.apk');
};

type Pending = {resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout};

export class AndroidRunner {
  readonly serial: string;
  readonly #driver: AndroidDriver;
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

  async #ensureInstalled(force = false) {
    if (!force && (await this.#installedVersion()) === RUNNER_VERSION) return;
    if (force) await this.#driver.adb(['uninstall', RUNNER_PACKAGE], this.serial, {timeoutMs: 60_000}).catch(() => undefined);
    const apk = runnerApk();
    if (!fs.existsSync(apk)) throw new AndroidError(`runner APK missing: ${apk}`, 'build it with `yarn build-runner`');
    let r = await this.#driver.adb(['install', '-r', '-t', '-d', apk], this.serial, {timeoutMs: 120_000});
    // A runner built on another machine is signed with another debug key and cannot update this one. It keeps no
    // data: it goes and the new one is installed.
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(r.stdout + r.stderr)) {
      await this.#driver.adb(['uninstall', RUNNER_PACKAGE], this.serial, {timeoutMs: 60_000}).catch(() => undefined);
      r = await this.#driver.adb(['install', '-t', '-d', apk], this.serial, {timeoutMs: 120_000});
    }
    if (!/Success/.test(r.stdout + r.stderr)) throw new AndroidError(`runner install failed: ${(r.stdout + r.stderr).trim().split('\n').pop()}`);
  }

  start(): Promise<void> {
    if (this.alive) return Promise.resolve();
    this.#starting ??= this.#start().finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  async #start() {
    try {
      await this.#attempt(false);
    } catch (e) {
      // The package manager can list the runner while its APK is gone (an emulator killed right after the
      // install): the instrumentation is then "not found" until it is installed again.
      if (!/INSTRUMENTATION_FAILED/.test((e as Error).message)) throw e;
      await this.#attempt(true);
    }
  }

  async #attempt(reinstall: boolean) {
    this.#teardown();
    await this.#ensureInstalled(reinstall);
    // A runner another pitbox daemon started (one per project) is used as it is: restarting it would cut that
    // daemon off mid-call.
    if (!reinstall && (await this.#connect())) return;
    await this.#driver.shell(this.serial, `am force-stop ${RUNNER_PACKAGE}`);
    // Started on the device under nohup: the UiAutomation connection lives in the `am` process, so a runner tied
    // to this daemon's adb session would die with it and take every other daemon's connection along.
    await this.#driver.shell(this.serial, `rm -f ${RUNNER_OUT}; nohup am instrument -w -r --no-hidden-api-checks -e port ${DEVICE_PORT} ${RUNNER_PACKAGE}/.RunnerInstrumentation > ${RUNNER_OUT} 2>&1 &`);
    const deadline = Date.now() + 60_000;
    let output = '';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300));
      output = await this.#driver.shell(this.serial, `cat ${RUNNER_OUT} 2>/dev/null`).catch(() => '');
      if (/INSTRUMENTATION_FAILED|INSTRUMENTATION_RESULT: shortMsg=|already registered|Error type/.test(output)) {
        const busy = /already registered|UiAutomation/.test(output);
        throw new AndroidError(`runner failed to start: ${output.trim().split('\n').slice(-2).join(' ')}`, busy ? 'another UI automation tool holds UiAutomation on this device — stop it first' : undefined);
      }
      if (output.includes('pitbox=ready') && (await this.#connect())) return;
    }
    throw new AndroidError('runner did not start in 60s', output.trim().split('\n').slice(-3).join(' ') || 'check `app-logs --all --grep pitbox`');
  }

  /** Connects to a runner listening on the device; true once it answers. */
  async #connect(): Promise<boolean> {
    if (!this.#hostPort) {
      const fwd = await this.#driver.adb(['forward', 'tcp:0', `tcp:${DEVICE_PORT}`], this.serial);
      this.#hostPort = Number(fwd.stdout.trim());
      if (!this.#hostPort) throw new AndroidError(`adb forward failed: ${fwd.stderr.trim()}`);
    }
    const connected = await new Promise<boolean>(resolve => {
      const s = net.connect(this.#hostPort!, '127.0.0.1', () => resolve(true));
      s.setNoDelay(true);
      s.on('error', e => {
        resolve(false);
        this.#fail(e);
      });
      s.on('close', () => this.#fail(new Error('runner connection closed')));
      s.on('data', (d: Buffer) => this.#onData(d));
      this.#socket = s;
    });
    if (!connected) return false;
    // adb accepts the forward even when nothing listens on the device; only an answer proves a runner.
    try {
      await this.#send('info', {}, 3000);
      return true;
    } catch {
      this.#socket?.destroy();
      this.#socket = undefined;
      return false;
    }
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
    if (this.#hostPort) void this.#driver.adb(['forward', '--remove', `tcp:${this.#hostPort}`], this.serial).catch(() => undefined);
    this.#hostPort = undefined;
  }

  async call<T extends Record<string, unknown> = Record<string, unknown>>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    await this.start();
    return this.#send<T>(cmd, args, timeoutMs);
  }

  #send<T extends Record<string, unknown> = Record<string, unknown>>(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const id = this.#nextId++;
    const socket = this.#socket;
    if (!socket) throw new AndroidError('runner not connected');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AndroidError(`runner: ${cmd} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {resolve: v => resolve(v as T), reject, timer});
      // The request's own id and command last: an argument named `id` must not take over the reply's address.
      socket.write(`${JSON.stringify({...args, id, cmd})}\n`);
    });
  }

  /** Leaves the runner running: other daemons may be using it, and the next start reuses it. */
  async stop() {
    this.#teardown();
  }
}
