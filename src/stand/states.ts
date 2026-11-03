// Named stand states: a device snapshot (the app and its data included) plus the project's own backend dump,
// saved together and restored together — "signed in, three items in the cart" in seconds instead of steps.
// The device side is an emulator snapshot on Android and a copy of the app's data on an Apple simulator.

import fs from 'node:fs';
import path from 'node:path';
import type {AndroidDriver} from '../drivers/android/driver.ts';
import {quoteArg, resolveShell, runShell} from '../util/proc.ts';
import {renderTemplate} from '../util/text.ts';
import type {StandContext} from './services.ts';

export type StatesConfig = {save?: string; restore?: string};
export type StateInfo = {name: string; savedAt: number; device?: string; avd?: string; backend: boolean; kind?: 'emulator' | 'app-data'};

/** A device's side of a state, kept by its driver under the state's name. */
export type DeviceSnapshot = {id: string; label?: string; kind: 'emulator' | 'app-data'; save(name: string): Promise<void>; load(name: string): Promise<void>; remove(name: string): Promise<void>};

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

export const validStateName = (name: string) => {
  if (!/^[\w.-]{1,40}$/.test(name)) throw new Error(`state name must be letters, digits, . _ - (got "${name}")`);
  return name;
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

  async #hook(kind: 'save' | 'restore', name: string): Promise<boolean> {
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
    if (info.backend) await this.#hook('restore', name);
    if (info.device) {
      if (!device || (info.kind === 'app-data' && device.id !== info.device)) throw new Error(`state "${name}" has a device side (${info.avd ?? info.device}); boot that ${info.kind === 'app-data' ? 'simulator' : 'emulator'} first`);
      await device.load(snapshotName(name));
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
