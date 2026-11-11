// Host side of the Android runner: installs the runner APK when its version differs, starts it through
// `am instrument` (detached on the device, shared by every pitbox daemon there), forwards its port, and keeps one
// connection with a request queue. A dead runner (the device rebooted) is restarted on the next call.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {leaseKey, machineLock} from '../../lease/lease.ts';
import type {AndroidDriver} from './driver.ts';
import {AndroidError} from './driver.ts';

export const RUNNER_PACKAGE = 'dev.pitbox.runner';
/** Must match `versionCode` in runners/android/build.gradle.kts. */
export const RUNNER_VERSION = 20;
const DEVICE_PORT = 7912;
/** The instrumentation's output on the device: its ready line or why it failed. */
const RUNNER_OUT = '/data/local/tmp/pitbox-runner.out';

export const runnerApk = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'runners', 'android', 'pitbox-runner.apk');
};

/** A runner of this version or a newer one: newer runners serve older hosts. */
const usable = (v?: number) => v !== undefined && v >= RUNNER_VERSION;

type Pending = {resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout};

/**
 * The shell command that starts the runner on the device, detached. `--no-hidden-api-checks` lets the
 * instrumentation reach the platform's hidden APIs; `am` has the option from Android 9 (API 28) on and
 * refuses to start at all with it before, so older devices start without it.
 */
export function instrumentCommand(sdk: number): string {
  const hidden = !Number.isFinite(sdk) || sdk >= 28 ? ' --no-hidden-api-checks' : '';
  return `rm -f ${RUNNER_OUT}; nohup am instrument -w -r${hidden} -e port ${DEVICE_PORT} ${RUNNER_PACKAGE}/.RunnerInstrumentation > ${RUNNER_OUT} 2>&1 &`;
}

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

  /** The runner's version on the device and when it was last installed; both undefined when it is not there. */
  async #installed(): Promise<{version?: number; updated?: string}> {
    const out = await this.#driver.shell(this.serial, `dumpsys package ${RUNNER_PACKAGE} | grep -E 'versionCode|lastUpdateTime'`).catch(() => '');
    const v = /versionCode=(\d+)/.exec(out)?.[1];
    return {version: v ? Number(v) : undefined, updated: /lastUpdateTime=([^\n]+)/.exec(out)?.[1]?.trim()};
  }

  /**
   * Installs the runner unless this version or a newer one is there; called with the device's runner lock held.
   * A newer runner stays (it serves older hosts: protocol changes only add), so two versions of pitbox do not
   * replace each other in turn. `force` (the package manager lists a runner whose APK is gone) installs anyway,
   * unless another process installed it after `seen` was read.
   */
  async #ensureInstalled(force: boolean, seen: {version?: number; updated?: string}) {
    const now = await this.#installed();
    if (usable(now.version) && (!force || now.updated !== seen.updated)) return false;
    await this.#install(force);
    return true;
  }

  async #install(force: boolean) {
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

  /**
   * Connects to the device's runner, installing and starting it when needed. Installing replaces the package and
   * starting force-stops it: either kills a runner another daemon is connected to, mid-call. Two daemons reaching a
   * fresh device at once (two projects, a second daemon of one project, two versions of pitbox) would each install
   * and start in turn and cut the other off, so both happen under one lock per device across processes, and what is
   * on the device is read again under it: the second finds the first's runner and connects to it.
   */
  async #attempt(reinstall: boolean) {
    this.#teardown();
    const seen = await this.#installed();
    // A runner another pitbox daemon started (one per project) is used as it is: restarting it would cut that
    // daemon off mid-call.
    if (!reinstall && usable(seen.version) && (await this.#connect())) return;
    await machineLock(`runner-${leaseKey('android', this.serial)}`, async () => {
      const installed = await this.#ensureInstalled(reinstall, seen);
      if ((!reinstall || !installed) && (await this.#connect())) return;
      await this.#launch();
    });
  }

  async #launch() {
    await this.#driver.shell(this.serial, `am force-stop ${RUNNER_PACKAGE}`);
    // Started on the device under nohup: the UiAutomation connection lives in the `am` process, so a runner tied
    // to this daemon's adb session would die with it and take every other daemon's connection along.
    // Unread (an empty answer), the level is unknown and the option stays, as before.
    const sdk = Number((await this.#driver.shell(this.serial, 'getprop ro.build.version.sdk').catch(() => '')).trim()) || Number.NaN;
    await this.#driver.shell(this.serial, instrumentCommand(sdk));
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
      // Only the current connection's end fails the calls: a probe socket given up on closes later.
      s.on('error', e => {
        resolve(false);
        if (this.#socket === s) this.#fail(e);
      });
      s.on('close', () => {
        if (this.#socket === s) this.#fail(new Error('runner connection closed'));
      });
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
