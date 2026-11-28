// Named stand states: a device snapshot (the app and its data included) plus the project's own backend dump,
// saved together and restored together — "signed in, three items in the cart" in seconds instead of steps.
// The device side is an emulator snapshot on Android, and a copy of the app's data on an Android phone and on an
// Apple simulator or device.

import fs from 'node:fs';
import path from 'node:path';
import type {AndroidDriver} from '../drivers/android/driver.ts';
import {quoteArg, resolveShell, runShell} from '../util/proc.ts';
import {renderTemplate} from '../util/text.ts';
import type {StandContext} from './services.ts';

export type StatesConfig = {save?: string; restore?: string; migrate?: string};
export type StateInfo = {name: string; savedAt: number; device?: string; avd?: string; backend: boolean; kind?: 'emulator' | 'app-data'};

/**
 * A device's side of a state, kept by its driver under the state's name. `reset`, where a device has one, is what a
 * state saved without a device side does to it (a browser's storage goes; a phone is left as it is).
 */
export type DeviceSnapshot = {
  id: string;
  label?: string;
  kind: 'emulator' | 'app-data';
  save(name: string): Promise<void>;
  load(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  reset?(): Promise<void>;
};

const snapshotName = (name: string) => `pitbox-${name}`;

/**
 * Why `adb emu avd snapshot` gave no OK. An emulator that went away mid-snapshot leaves adb with nothing to say, and
 * an empty reason sends one hunting in the wrong place.
 */
export const snapshotFailure = async (android: Pick<AndroidDriver, 'devices'>, serial: string, r: {stdout: string; stderr: string; code?: number | null; timedOut?: boolean}) => {
  const said = (r.stdout + r.stderr).trim();
  const online = (await android.devices().catch(() => [])).some(d => d.serial === serial && d.state === 'device');
  if (!online) return `${said ? `${said} — ` : ''}the emulator ${serial} is gone (it exited during the snapshot, which writes the whole RAM to disk: short of memory or disk space); boot it again`;
  if (r.timedOut) return 'the emulator did not answer in time';
  return said || `adb exited with ${r.code ?? 'no code'} and said nothing`;
};

/**
 * A loaded snapshot is a restore only once adb reaches the device again. The emulator says OK as soon as the RAM is
 * back, and adb can hold the device offline for good after it (its adb port stops answering); that is reported here,
 * not left for the next command to trip over.
 */
const backOnline = async (android: Pick<AndroidDriver, 'devices' | 'adb'>, serial: string, timeoutMs: number) => {
  const end = Date.now() + timeoutMs;
  let reconnected = false;
  for (;;) {
    const d = (await android.devices().catch(() => [])).find(x => x.serial === serial);
    if (d?.state === 'device') return;
    if (Date.now() > end) throw new Error(`the snapshot loaded, but ${serial} stayed ${d?.state ?? 'missing'} in adb for ${Math.round(timeoutMs / 1000)}s — boot it again (a cold boot) and save the state anew`);
    if (!reconnected && d?.state === 'offline' && Date.now() > end - timeoutMs / 2) {
      reconnected = true;
      await android.adb(['reconnect', 'offline'], undefined, {timeoutMs: 10_000}).catch(() => undefined);
    }
    await new Promise(r => setTimeout(r, Math.min(1000, timeoutMs / 10)));
  }
};

/** An emulator's side of a state: its own snapshot, by `adb emu avd snapshot`. */
export const emulatorSnapshot = (android: Pick<AndroidDriver, 'devices' | 'adb'>, serial: string, label?: string, onlineTimeoutMs = 60_000): DeviceSnapshot => {
  const emu = async (op: 'save' | 'load', n: string) => {
    const r = await android.adb(['emu', 'avd', 'snapshot', op, n], serial, {timeoutMs: 180_000});
    if (!/OK/.test(r.stdout)) throw new Error(`emulator snapshot ${op === 'save' ? 'failed' : 'load failed'}: ${await snapshotFailure(android, serial, r)}`);
  };
  return {
    id: serial,
    label,
    kind: 'emulator',
    save: n => emu('save', n),
    load: async n => {
      await emu('load', n);
      await backOnline(android, serial, onlineTimeoutMs);
    },
    remove: async n => void (await android.adb(['emu', 'avd', 'snapshot', 'delete', n], serial, {timeoutMs: 60_000})),
  };
};

/** What of an app's data folder a state leaves out: the caches, and the link to its native libraries. */
const SKIPPED = 'cache|code_cache|lib';

/**
 * An Android phone's side of a state, which has no snapshot of its own: a tar of the app's data folder, read and
 * written as the app through `run-as` (a debuggable build only), kept under `dir`. The app is stopped first, so
 * nothing is half written; a load leaves it stopped, its next launch starts from the data.
 */
export const androidAppData = (android: Pick<AndroidDriver, 'adb' | 'shell'>, serial: string, pkg: string, dir: string, label?: string, relaunch?: () => Promise<unknown>): DeviceSnapshot => {
  const file = (n: string) => path.join(dir, `${n}.tar`);
  const asApp = async (cmd: string) => {
    const r = await android.adb(['shell', `run-as ${pkg} sh -c '${cmd}'`], serial, {timeoutMs: 60_000});
    const said = (r.stdout + r.stderr).trim();
    if (/not debuggable|unknown package|Package '.*' is unknown/i.test(said)) {
      throw new Error(`${pkg} on ${serial}: ${said.split('\n')[0]}\nhint: a phone has no snapshots; a state copies the app's data through run-as, which takes a debug build`);
    }
    return r;
  };
  const running = async () => !!(await android.shell(serial, `pidof ${pkg}`).catch(() => '')).trim();
  return {
    id: serial,
    label,
    kind: 'app-data',
    save: async n => {
      const was = await running();
      await android.shell(serial, `am force-stop ${pkg}`);
      const entries = (await asApp(`ls -A | grep -vxE "${SKIPPED}"`)).stdout.replace(/\r/g, '').split('\n').filter(Boolean);
      fs.mkdirSync(dir, {recursive: true});
      if (!entries.length) fs.writeFileSync(file(n), '');
      else {
        const r = await android.adb(['exec-out', `run-as ${pkg} tar -cf - ${entries.map(e => `'${e}'`).join(' ')}`], serial, {timeoutMs: 180_000, encoding: 'buffer'});
        if (r.code !== 0 || !r.buffer?.length) throw new Error(`could not read ${pkg}'s data on ${serial}: ${r.stderr.trim() || 'nothing came back'}`);
        fs.writeFileSync(file(n), r.buffer);
      }
      if (was) await relaunch?.();
    },
    load: async n => {
      if (!fs.existsSync(file(n))) throw new Error(`no saved app data "${n}" for ${pkg} on ${serial}`);
      await android.shell(serial, `am force-stop ${pkg}`);
      await asApp(`ls -A | grep -vxE "${SKIPPED}" | while read f; do rm -rf "$f"; done`);
      if (!fs.statSync(file(n)).size) return;
      // The app's user reads no file of the shell's: the shell reads it and pipes it in.
      const tmp = `/data/local/tmp/pitbox-state-${pkg}.tar`;
      const push = await android.adb(['push', file(n), tmp], serial, {timeoutMs: 180_000});
      if (push.code !== 0) throw new Error(`could not copy the state to ${serial}: ${push.stderr.trim()}`);
      try {
        const r = await android.adb(['shell', `cat ${tmp} | run-as ${pkg} tar -xf -`], serial, {timeoutMs: 180_000});
        if (r.code !== 0) throw new Error(`could not write ${pkg}'s data on ${serial}: ${(r.stderr || r.stdout).trim()}`);
      } finally {
        await android.adb(['shell', `rm -f ${tmp}`], serial).catch(() => undefined);
      }
    },
    remove: async n => fs.rmSync(file(n), {force: true}),
  };
};

export const validStateName = (name: string) => {
  if (!/^[\w.-]{1,40}$/.test(name)) throw new Error(`state name must be letters, digits, . _ - (got "${name}")`);
  return name;
};

/**
 * A web app's side of a state: the browser's cookies and storage, a file per state. Restoring a state saved without
 * it (only the backend) empties them, as the backend's ids start over and storage keyed by them would mislead.
 */
export const browserStorage = (browser: {saveStorage(file: string): Promise<void>; restoreStorage(file?: string): Promise<void>}, id: string, dir: string): DeviceSnapshot => {
  const file = (n: string) => path.join(dir, `${n}.json`);
  return {
    id,
    label: id,
    kind: 'app-data',
    save: n => browser.saveStorage(file(n)),
    load: n => browser.restoreStorage(file(n)),
    remove: async n => fs.rmSync(file(n), {force: true}),
    reset: () => browser.restoreStorage(),
  };
};

export class StateStore {
  readonly #ctx: StandContext;
  readonly #cfg: StatesConfig;
  readonly #dir: string;

  constructor(ctx: StandContext, cfg: StatesConfig = {}) {
    this.#ctx = ctx;
    this.#cfg = cfg;
    this.#dir = path.join(ctx.stateDir, 'states');
  }

  #file(name: string) {
    return path.join(this.#dir, `${name}.dump`);
  }

  #meta(name: string) {
    return path.join(this.#dir, `${name}.json`);
  }

  list(): StateInfo[] {
    if (!fs.existsSync(this.#dir)) return [];
    return fs
      .readdirSync(this.#dir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(this.#dir, f), 'utf8')) as StateInfo)
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  async #hook(kind: 'save' | 'restore' | 'migrate', name: string): Promise<boolean> {
    const template = this.#cfg[kind];
    if (!template) return false;
    const shell = resolveShell(this.#ctx.shell);
    const cmd = renderTemplate(template, {name, file: this.#file(name)}, v => quoteArg(v, shell.kind));
    const r = await runShell(cmd, {cwd: this.#ctx.root, shell: this.#ctx.shell, timeoutMs: 600_000});
    if (r.code !== 0) throw new Error(`state ${kind} command failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
    return true;
  }

  async save(name: string, device: DeviceSnapshot | undefined): Promise<StateInfo> {
    validStateName(name);
    fs.mkdirSync(this.#dir, {recursive: true});
    await device?.save(snapshotName(name));
    const backend = await this.#hook('save', name);
    const info: StateInfo = {name, savedAt: Date.now(), device: device?.id, avd: device?.label, backend, ...(device ? {kind: device.kind} : {})};
    fs.writeFileSync(this.#meta(name), JSON.stringify(info, null, 2));
    return info;
  }

  async restore(name: string, device: DeviceSnapshot | undefined): Promise<StateInfo & {ms: number}> {
    validStateName(name);
    const t0 = Date.now();
    if (!fs.existsSync(this.#meta(name))) throw new Error(`no state "${name}" (saved: ${this.list().map(s => s.name).join(', ') || 'none'})`);
    const info = JSON.parse(fs.readFileSync(this.#meta(name), 'utf8')) as StateInfo;
    // Backend first: the app restored from the snapshot reconnects to data that already matches it.
    if (info.backend) {
      await this.#hook('restore', name);
      // A dump carries the schema of the day it was taken: migrations added since would be rolled back with it.
      await this.#hook('migrate', name);
    }
    if (info.device) {
      if (!device || (info.kind === 'app-data' && device.id !== info.device)) throw new Error(`state "${name}" has a device side (${info.avd ?? info.device}); ${info.kind === 'app-data' ? 'boot or connect that device' : 'boot that emulator'} first`);
      await device.load(snapshotName(name));
    } else {
      await device?.reset?.();
    }
    return {...info, ms: Date.now() - t0};
  }

  async remove(name: string, device: DeviceSnapshot | undefined) {
    validStateName(name);
    await device?.remove(snapshotName(name)).catch(() => undefined);
    fs.rmSync(this.#meta(name), {force: true});
    fs.rmSync(this.#file(name), {force: true});
  }
}
