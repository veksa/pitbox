// Apple driver: iPhone, iPad, Apple TV, Apple Vision Pro and Apple Watch simulators through simctl, and physical
// iPhones and iPads paired with this Mac through devicectl (physical.ts): one list, one set of operations.
// The agent never calls xcrun itself; every operation it needs is here. Gaps of the simulator tooling are
// reported as unsupported, never emulated silently.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseStartDate} from '../../lease/lease.ts';
import {run, which, type RunResult} from '../../util/proc.ts';
import {tailLines} from '../../util/text.ts';

import {deviceError, isPhysical, PhysicalDevices, physicalUdid} from './physical.ts';
import {keepsOverrides, notDisabled, simSlimList, slimSimulator, storeDir, unslimSimulator, type SimSlimOptions} from './slim.ts';

export type SimKind = 'phone' | 'foldable' | 'tablet' | 'tv' | 'xr' | 'watch';

export type Simulator = {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  os: string;
  kind: SimKind;
  available: boolean;
  deviceType?: string;
  /** What keeps a physical device from running tests (`Developer Mode is off`). */
  note?: string;
};

/** One screen of a simulator; a foldable has two, and only one is lit at a time. */
export type Display = {id: number; name: string; active: boolean; primary: boolean; width: number; height: number};

/** `devicectl device info displays -j` → its screens. */
export const parseDisplays = (json: unknown): Display[] => {
  const list = (json as {result?: {displays?: Record<string, unknown>[]}})?.result?.displays ?? [];
  return list.map(d => {
    const size = (d.nativeSize as number[] | undefined) ?? [];
    return {
      id: Number(d.displayId),
      name: String(d.name ?? ''),
      active: d.active === true && d.backlightState !== 'off',
      primary: d.primary === true,
      width: Number(size[0] ?? 0),
      height: Number(size[1] ?? 0),
    };
  });
};

export class AppleError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(hint ? `${message}\nhint: ${hint}` : message);
    this.hint = hint;
  }
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-27-1` → `iOS 27.1`. */
export const runtimeName = (id: string): string => {
  // A runtime made for one device carries its model after the version: `iOS-27-2-iPhone19-4`.
  const m = /SimRuntime\.([a-zA-Z]+)-(\d+(?:-\d+)*)(?:-[A-Za-z][\w-]*)?$/.exec(id);
  return m ? `${m[1]} ${m[2]!.replace(/-/g, '.')}` : id;
};

/** The app that shows simulator windows: Simulator.app in Xcode 26 and before, DeviceHub.app from Xcode 27. */
export const simulatorWindowApp = (developerDir: string): string | undefined =>
  [path.join(developerDir, 'Applications', 'Simulator.app'), path.join(path.dirname(developerDir), 'Applications', 'DeviceHub.app')].find(p => fs.existsSync(p));

export const simKind = (runtime: string, deviceType: string): SimKind => {
  if (/tvOS/i.test(runtime)) return 'tv';
  if (/xrOS|visionOS/i.test(runtime)) return 'xr';
  if (/watchOS/i.test(runtime)) return 'watch';
  if (/iPad/i.test(deviceType)) return 'tablet';
  // A phone with a hinge: an outer (cover) screen and an inner one.
  return /Duo|Fold/i.test(deviceType) ? 'foldable' : 'phone';
};

/** Android-style font scale → the nearest iOS Dynamic Type category. */
export const contentSize = (scale: number): string => {
  const steps: [number, string][] = [
    [0.82, 'extra-small'],
    [0.9, 'small'],
    [0.97, 'medium'],
    [1.07, 'large'],
    [1.2, 'extra-large'],
    [1.35, 'extra-extra-large'],
    [1.5, 'extra-extra-extra-large'],
    [1.8, 'accessibility-medium'],
    [2.1, 'accessibility-large'],
    [2.5, 'accessibility-extra-large'],
    [3, 'accessibility-extra-extra-large'],
  ];
  return steps.find(([max]) => scale <= max)?.[1] ?? 'accessibility-extra-extra-extra-large';
};

/** Parses `simctl list devices -j`. */
export const parseSimulators = (json: string): Simulator[] => {
  const data = JSON.parse(json) as {devices: Record<string, {udid: string; name: string; state: string; isAvailable?: boolean; deviceTypeIdentifier?: string}[]>};
  return Object.entries(data.devices).flatMap(([runtime, list]) =>
    list.map(d => ({
      udid: d.udid,
      name: d.name,
      state: d.state,
      runtime,
      os: runtimeName(runtime),
      kind: simKind(runtime, d.deviceTypeIdentifier ?? d.name),
      available: d.isAvailable !== false,
      ...(d.deviceTypeIdentifier ? {deviceType: d.deviceTypeIdentifier} : {}),
    })),
  );
};

/**
 * `ps -ax -o pid=,lstart=,command=` (under `LC_ALL=C`) → the boot each running simulator is in, by udid: its
 * launchd_sim process (`launchd_sim:<pid>@<start, epoch s>`). A simulator runs one launchd_sim from boot to shutdown,
 * with its device folder (`…/Devices/<udid>/…`) on the command line; booted again — by pitbox, by hand, by Xcode — it
 * runs another. The start is the one the system recorded, not now minus the elapsed time: a mark read on a loaded
 * machine (ps slow to answer, the reader slow to look at the clock) is then the same as one read later on an idle one.
 */
export const parseSimulatorBoots = (ps: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!m || !/(^|\/)launchd_sim(\s|$)/.test(m[3]!)) continue;
    const udid = /\/Devices\/([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\//.exec(m[3]!)?.[1];
    const start = parseStartDate(m[2]!);
    if (udid && start !== undefined) out.set(udid.toUpperCase(), `launchd_sim:${m[1]}@${start}`);
  }
  return out;
};

/** Compares `iOS 27.1` and `iOS 27.0` numerically, newest first. */
const newerFirst = (a: Simulator, b: Simulator) => {
  const v = (s: Simulator) => (s.os.split(' ')[1] ?? '0').split('.').map(Number);
  const [x, y] = [v(a), v(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

/** The simulator a selector names: a udid, or a name (the newest runtime wins when names repeat). */
export const pickSimulator = (sims: Simulator[], selector: string): Simulator | undefined => {
  const byUdid = sims.find(s => s.udid.toLowerCase() === selector.toLowerCase());
  if (byUdid) return byUdid;
  const named = sims.filter(s => s.name === selector || `${s.name} (${s.os})` === selector);
  // A booted one first: that is the one the agent means when two share a name.
  return named.sort((a, b) => Number(b.state === 'Booted') - Number(a.state === 'Booted') || newerFirst(a, b))[0];
};

/** A watch paired with a phone (`simctl list pairs`). A phone may have several watches; one pair is active. */
export type WatchPair = {id: string; watch: {udid: string; name: string; state: string}; phone: {udid: string; name: string; state: string}; active: boolean; connected: boolean};

/** `simctl list pairs -j` → its pairs. */
export const parsePairs = (json: string): WatchPair[] => {
  const pairs = (JSON.parse(json) as {pairs?: Record<string, {watch?: Record<string, string>; phone?: Record<string, string>; state?: string}>}).pairs ?? {};
  return Object.entries(pairs)
    .filter(([, p]) => p.watch?.udid && p.phone?.udid)
    .map(([id, p]) => {
      const state = p.state ?? '';
      const side = (d: Record<string, string>) => ({udid: d.udid!, name: d.name ?? '', state: d.state ?? ''});
      return {id, watch: side(p.watch!), phone: side(p.phone!), active: /\(active\b/.test(state), connected: /\bconnected\)/.test(state) && !/disconnected/.test(state)};
    });
};

export const isAppleBundle = (file: string) => /\.(app|ipa)\/?$/i.test(file);

/** How long `simctl list` may take before it is asked again. */
const LIST_TIMEOUT_MS = 60_000;

/** Why `simctl list` gave no list, and what to do; undefined when it did. */
export const listFailure = (r: {code: number | null; stderr: string; timedOut: boolean}): {message: string; hint: string} | undefined => {
  if (r.code === 0 && !r.timedOut) return undefined;
  if (r.timedOut)
    return {
      message: `simctl list did not answer in ${LIST_TIMEOUT_MS / 1000}s, twice`,
      hint: 'CoreSimulator is busy (a simulator booting, a runtime being installed): try again once it settles',
    };
  return {message: `simctl list failed: ${r.stderr.trim()}`, hint: 'is Xcode installed and its license accepted (`sudo xcodebuild -license accept`)?'};
};

/** How long the simulator list is kept at most while no simulator's state file changes (AppleDriver.simulators). */
const KEPT_MAX_MS = 30_000;

/**
 * The state of a device set as cheaply as it can be read: every simulator's folder with its device.plist's change
 * time. CoreSimulator rewrites the file when the simulator boots, shuts down, is renamed or erased; a simulator
 * created or deleted changes the folder list. Undefined when the set cannot be read (another machine's layout).
 */
export const deviceSetStamp = (dir: string): string | undefined => {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const parts: string[] = [];
  for (const name of names.sort()) {
    try {
      parts.push(`${name}:${fs.statSync(path.join(dir, name, 'device.plist')).mtimeMs}`);
    } catch {
      parts.push(`${name}:-`);
    }
  }
  return parts.join('|');
};

/**
 * Whether a process list (`ps -o command=`) has the app started from the .app at `bundle`: its main executable, not an
 * extension of it (PlugIns/…appex, a widget's process).
 */
export const appProcess = (ps: string, bundle: string): boolean =>
  ps.split('\n').some(l => l.startsWith(`${bundle}/`) && !l.slice(bundle.length + 1).split(' ')[0]!.includes('/'));

export class AppleDriver {
  readonly xcrun: string;
  /** Physical devices paired with this Mac (devicectl). */
  readonly physical: PhysicalDevices;
  /** The Apple Development team that signs the runner for physical devices (`apple.team`); found from the keychain when unset. */
  signingTeam?: string;

  constructor() {
    if (process.platform !== 'darwin') throw new AppleError('Apple simulators run on macOS only');
    const xcrun = which('xcrun');
    if (!xcrun) throw new AppleError('xcrun not found', 'install Xcode and run `xcode-select -s /Applications/Xcode.app`');
    this.xcrun = xcrun;
    this.physical = new PhysicalDevices(xcrun);
  }

  simctl(args: string[], opts: {timeoutMs?: number; encoding?: 'buffer'; input?: string} = {}): Promise<RunResult & {buffer?: Buffer}> {
    return run(this.xcrun, ['simctl', ...args], {timeoutMs: opts.timeoutMs ?? 30_000, ...(opts.encoding ? {encoding: opts.encoding} : {}), ...(opts.input !== undefined ? {input: opts.input} : {})});
  }

  async #ok(args: string[], what: string, timeoutMs = 30_000): Promise<string> {
    const r = await this.simctl(args, {timeoutMs});
    if (r.code !== 0) throw new AppleError(`${what} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
    return r.stdout;
  }

  /**
   * The list `simctl list` gives, kept: it costs ~100 ms, and one command resolves its device two or three times
   * (the target, its UI session, the web check). For a moment it is used as it is; after that only while no
   * simulator's state file changed (`deviceSetStamp`: CoreSimulator rewrites a simulator's device.plist on every boot
   * and shutdown, from any process), and never longer than KEPT_MAX_MS. Booting and shutting down here drop it.
   */
  private kept?: {at: number; stamp?: string; sims: Promise<Simulator[]>};

  /** Where CoreSimulator keeps the default device set; a test points it elsewhere. */
  deviceSet = path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices');

  /** The simulators and, after them, the physical devices paired with this Mac (runtime `device`). */
  async simulators(): Promise<Simulator[]> {
    const [sims, devices] = await Promise.all([this.simulatorsOnly(), this.physical?.list() ?? []]);
    return devices.length ? [...sims, ...devices] : sims;
  }

  /** The simulators alone. */
  async simulatorsOnly(): Promise<Simulator[]> {
    const kept = this.kept;
    if (kept && (Date.now() - kept.at < 1500 || (Date.now() - kept.at < KEPT_MAX_MS && kept.stamp !== undefined && kept.stamp === deviceSetStamp(this.deviceSet)))) return kept.sims;
    // Read before the list: a change while simctl answers makes the next call read it again.
    const stamp = deviceSetStamp(this.deviceSet);
    const sims = (async () => {
      // Right after a boot or a runtime's install CoreSimulator can take tens of seconds to list its devices (a CI
      // machine most of all): waited for, and asked once more when it ran out of time.
      let r = await this.simctl(['list', 'devices', '-j'], {timeoutMs: LIST_TIMEOUT_MS});
      if (r.timedOut) r = await this.simctl(['list', 'devices', '-j'], {timeoutMs: LIST_TIMEOUT_MS});
      const failed = listFailure(r);
      if (failed) throw new AppleError(failed.message, failed.hint);
      return parseSimulators(r.stdout).filter(s => s.available);
    })();
    const entry = {at: Date.now(), stamp, sims};
    this.kept = entry;
    sims.catch(() => {
      if (this.kept === entry) this.kept = undefined;
    });
    return sims;
  }

  /**
   * The boot each running simulator is in (parseSimulatorBoots), by udid; empty when the process list cannot be read.
   * What a lease records when pitbox boots a simulator, and what a shutdown for that lease checks it still runs.
   */
  async bootMarks(): Promise<Map<string, string>> {
    if (process.platform !== 'darwin') return new Map();
    const r = await run('ps', ['-ax', '-o', 'pid=,lstart=,command='], {timeoutMs: 10_000, env: {...process.env, LC_ALL: 'C'}});
    return r.code === 0 ? parseSimulatorBoots(r.stdout) : new Map();
  }

  /** Forgets the kept list: the set of booted simulators is about to change. */
  forgetList() {
    this.kept = undefined;
    this.physical?.forget();
  }

  async booted(): Promise<Simulator[]> {
    return (await this.simulators()).filter(s => s.state === 'Booted');
  }

  /** Picks a booted simulator: by udid or name; the only booted one when no selector is given. */
  async resolve(selector?: string): Promise<string> {
    const booted = await this.booted();
    if (selector) {
      const hit = pickSimulator(booted, selector);
      if (hit) return hit.udid;
      throw new AppleError(`no booted simulator matches "${selector}"`, booted.length ? `booted: ${booted.map(s => s.name).join(', ')}` : 'boot one with `boot <name>`');
    }
    // A physical device is used only when named.
    const sims = booted.filter(s => !isPhysical(s));
    if (sims.length === 1) return sims[0]!.udid;
    if (!sims.length) throw new AppleError('no booted simulator', booted.length ? `connected devices are used when named: ${booted.map(s => s.name).join(', ')}` : 'boot one with `boot <name>`');
    throw new AppleError('several simulators booted', `pass a device: ${sims.map(s => s.udid).join(', ')}`);
  }

  /**
   * Boots a simulator. `slim` (iPhone and iPad on iOS 18.5+, booted from shut down): `true` or the list's options
   * slim it, `false` puts back what pitbox disabled; the answer's `slim` says what was done.
   */
  async boot(selector: string, opts: {headless?: boolean; wipe?: boolean; timeoutMs?: number; slim?: boolean | SimSlimOptions} = {}): Promise<{udid: string; name: string; ms: number; already: boolean; note?: string; slim?: string}> {
    this.forgetList();
    const t0 = Date.now();
    const sims = await this.simulators();
    const sim = pickSimulator(sims, selector);
    if (!sim) throw new AppleError(`unknown simulator "${selector}"`, `available: ${[...new Set(sims.map(s => s.name))].join(', ') || 'none — create one in Xcode › Devices'}`);
    // A physical device is on or not: nothing boots it, wipes it or slims it.
    if (isPhysical(sim)) {
      if (opts.wipe) throw new AppleError(`${sim.name} is a physical device: pitbox does not erase it`, 'erase it yourself in Settings › General › Transfer or Reset, or use a simulator');
      if (sim.state !== 'Booted') throw new AppleError(`${sim.name} is not connected`, 'plug it in (or bring it onto the same network) and unlock it');
      return {udid: sim.udid, name: sim.name, ms: 0, already: true};
    }
    if (sim.state === 'Booted' && !opts.wipe) {
      const note = opts.headless ? undefined : await this.#showWindow(sim.udid);
      return {udid: sim.udid, name: sim.name, ms: 0, already: true, ...(note ? {note} : {})};
    }
    if (opts.wipe) {
      if (sim.state === 'Booted') await this.simctl(['shutdown', sim.udid], {timeoutMs: 60_000});
      await this.#ok(['erase', sim.udid], 'erase', 120_000);
    }
    // Overrides are read when the simulator starts: written now, while it is shut down, they cost no extra boot.
    const slimmable = opts.slim !== undefined && ['phone', 'tablet', 'foldable'].includes(sim.kind) && keepsOverrides(sim.runtime);
    let slim: string | undefined;
    let labels: string[] = [];
    if (slimmable && opts.slim === false) {
      const back = unslimSimulator(sim.udid);
      if (back) slim = `stock: ${back} background services on again`;
    } else if (slimmable) {
      const o = opts.slim === true ? {} : (opts.slim as SimSlimOptions);
      const s = slimSimulator(sim.udid, o);
      if (s.error) slim = `failed: ${s.error}`;
      else labels = simSlimList(o);
    }
    const r = await this.simctl(['boot', sim.udid], {timeoutMs: 120_000});
    if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) throw new AppleError(`boot failed: ${r.stderr.trim().split('\n').pop()}`);
    const timeoutMs = opts.timeoutMs ?? 240_000;
    const status = await this.simctl(['bootstatus', sim.udid, '-b'], {timeoutMs});
    if (status.timedOut) throw new AppleError(`${sim.name} did not finish booting in ${Math.round(timeoutMs / 1000)}s`, 'try `boot --wipe`');
    this.forgetList();
    if (labels.length) {
      // Read back from launchd: a runtime that ignored the overrides is said, not taken for slim.
      const printed = await this.simctl(['spawn', sim.udid, 'launchctl', 'print-disabled', 'system'], {timeoutMs: 30_000});
      const missed = notDisabled(printed.stdout, labels);
      slim = missed.length === labels.length ? `failed: launchd ignored the overrides (${sim.os})` : `${labels.length - missed.length} background services off${missed.length ? `; still on: ${missed.slice(0, 3).join(', ')}${missed.length > 3 ? ', …' : ''}` : ''}`;
    }
    const note = opts.headless ? undefined : await this.#showWindow(sim.udid);
    return {udid: sim.udid, name: sim.name, ms: Date.now() - t0, already: false, ...(note ? {note} : {}), ...(slim ? {slim} : {})};
  }

  /** Brings up Simulator.app on the device; the simulator itself runs without it. */
  #windowApp?: Promise<string | undefined>;

  /** Shows the simulator's window; a note when there is nothing to show it with. */
  async #showWindow(udid: string): Promise<string | undefined> {
    this.#windowApp ??= run('xcode-select', ['-p'], {timeoutMs: 10_000}).then(r => simulatorWindowApp(r.stdout.trim()));
    const app = await this.#windowApp;
    if (!app) return 'no Simulator or DeviceHub app in this Xcode: the simulator runs without a window';
    const r = await run('open', ['-g', '-a', app, '--args', '-CurrentDeviceUDID', udid], {timeoutMs: 10_000});
    return r.code === 0 ? undefined : `could not open ${path.basename(app)}: ${r.stderr.trim().split('\n').pop()}`;
  }

  /**
   * A new simulator of the same model and runtime as `like`, for a session that needs its own while another holds
   * that one. Named `<name> (pitbox N)` so it is recognisable and found again by the next session.
   */
  async createLike(like: Simulator, name: string): Promise<Simulator> {
    if (isPhysical(like)) throw new AppleError(`${like.name} is a physical device: it cannot be copied`, 'wait for the session that holds it, or use a simulator');
    if (!like.deviceType) throw new AppleError(`cannot tell the model of ${like.name}`, 'create a simulator in Xcode › Devices and boot it by name');
    this.forgetList();
    const udid = (await this.#ok(['create', name, like.deviceType, like.runtime], 'create', 120_000)).trim();
    this.forgetList();
    const sim = (await this.simulators()).find(s => s.udid === udid);
    if (!sim) throw new AppleError(`simctl created ${udid} but does not list it`);
    return sim;
  }

  /** A copy of a shut-down simulator (`simctl clone`: copy-on-write on APFS, so a second or two), under `name`. */
  async cloneFrom(source: string, name: string): Promise<Simulator> {
    if (physicalUdid(source)) throw new AppleError('a physical device cannot be copied', 'use a simulator');
    this.forgetList();
    const udid = (await this.#ok(['clone', source, name], 'clone', 120_000)).trim();
    this.forgetList();
    const sim = (await this.simulators()).find(s => s.udid === udid);
    if (!sim) throw new AppleError(`simctl cloned ${udid} but does not list it`);
    return sim;
  }

  /** The watch pairs on this Mac, whoever made them. */
  async pairs(): Promise<WatchPair[]> {
    return parsePairs(await this.#ok(['list', 'pairs', '-j'], 'list pairs'));
  }

  /** Pairs a watch with a phone; answers the new pair's id. A pair made on a phone with no pair is active at once. */
  async pair(watch: string, phone: string): Promise<string> {
    const id = (await this.#ok(['pair', watch, phone], 'pair')).trim();
    if (!/^[0-9A-F-]{36}$/i.test(id)) throw new AppleError(`simctl pair answered no pair id: ${id.slice(0, 120)}`);
    return id;
  }

  /** Makes the pair its phone's active one (the phone's other watches stay paired, inactive). */
  async activatePair(id: string, timeoutMs = 45_000): Promise<void> {
    const r = await this.simctl(['pair_activate', id], {timeoutMs});
    if (r.timedOut) throw new AppleError(`simctl pair_activate did not answer in ${Math.round(timeoutMs / 1000)}s`, 'CoreSimulator could not switch the phone to this watch: boot a fresh phone for the pair (`device boot`) and pair again');
    if (r.code !== 0) throw new AppleError(`pair_activate failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  }

  /** Removes a pair; a pair already gone is no error. */
  async unpair(id: string): Promise<void> {
    const r = await this.simctl(['unpair', id]);
    if (r.code !== 0 && !/Invalid device pair/i.test(r.stderr)) throw new AppleError(`unpair failed: ${r.stderr.trim()}`);
  }

  /** Deletes a simulator (one pitbox created for a session); it must be shut down. */
  /** Deletes a simulator and its Mac-side launchd folder (logs, overrides, what slim wrote), which simctl leaves. */
  async delete(udid: string) {
    if (physicalUdid(udid)) return;
    this.forgetList();
    await this.#ok(['delete', udid], 'delete', 60_000);
    this.forgetList();
    if (/^[0-9A-F-]{36}$/i.test(udid)) fs.rmSync(storeDir(udid), {recursive: true, force: true});
  }

  async shutdown(udid: string): Promise<{ms: number; gone: boolean}> {
    // A physical device stays on: giving it back only ends what pitbox runs on it.
    if (physicalUdid(udid)) {
      this.physical.closeLog(udid);
      return {ms: 0, gone: false};
    }
    this.forgetList();
    const t0 = Date.now();
    const r = await this.simctl(['shutdown', udid], {timeoutMs: 60_000});
    if (r.code !== 0 && !/current state: Shutdown/i.test(r.stderr)) throw new AppleError(`shutdown failed: ${r.stderr.trim()}`);
    this.forgetList();
    return {ms: Date.now() - t0, gone: true};
  }

  async install(udid: string, bundle: string): Promise<{ms: number; replaced: boolean; bundleId?: string}> {
    if (physicalUdid(udid)) return this.physical.install(udid, bundle);
    if (!fs.existsSync(bundle)) throw new AppleError(`no such file: ${bundle}`);
    if (/\.ipa$/i.test(bundle)) throw new AppleError('an .ipa is a device build', 'simulators take the .app from a simulator build (Products/Debug-iphonesimulator/MyApp.app)');
    const t0 = Date.now();
    await this.#ok(['install', udid, bundle], 'install', 600_000);
    return {ms: Date.now() - t0, replaced: false, bundleId: await bundleIdOf(bundle)};
  }

  /** Opens an app by bundle id or a deep link URL. `totalMs` is the time until the app process runs. */
  async open(udid: string, target: string, opts: {relaunch?: boolean; bundleId?: string; args?: string[]} = {}): Promise<{totalMs?: number; pid?: number}> {
    if (physicalUdid(udid)) return this.physical.open(udid, target, opts);
    const t0 = Date.now();
    if (target.includes('://')) {
      if (opts.relaunch && opts.bundleId) await this.stop(udid, opts.bundleId);
      await this.#ok(['openurl', udid, target], 'openurl', 60_000);
      return {totalMs: Date.now() - t0};
    }
    const args = ['launch', ...(opts.relaunch ? ['--terminate-running-process'] : []), udid, target, ...(opts.args ?? [])];
    const r = await this.simctl(args, {timeoutMs: 60_000});
    if (r.code !== 0) {
      const why = r.stderr.trim().split('\n').pop() ?? '';
      throw new AppleError(`launch failed: ${why}`, /not installed|FBSOpenApplicationErrorDomain.*4/i.test(r.stderr) ? 'is the app installed? `apps` lists bundle ids' : undefined);
    }
    const pid = /:\s*(\d+)/.exec(r.stdout)?.[1];
    return {totalMs: Date.now() - t0, pid: pid ? Number(pid) : undefined};
  }

  async stop(udid: string, bundleId: string) {
    if (physicalUdid(udid)) return this.physical.stop(udid, bundleId);
    const r = await this.simctl(['terminate', udid, bundleId]);
    // Terminating an app that does not run is fine.
    if (r.code !== 0 && !/found nothing to terminate|not running/i.test(r.stderr)) throw new AppleError(`terminate failed: ${r.stderr.trim()}`);
  }

  /** Wipes the app's data container (Documents, Library, tmp) — simctl has no `pm clear`. */
  async clear(udid: string, bundleId: string) {
    if (physicalUdid(udid)) throw new AppleError('an app\'s data on a device cannot be wiped from the Mac', 'reinstall the app (uninstall, then install) for a clean start');
    await this.stop(udid, bundleId);
    const dir = (await this.#ok(['get_app_container', udid, bundleId, 'data'], 'get_app_container')).trim();
    if (!dir || !fs.existsSync(dir) || !dir.includes('/Containers/Data/Application/')) throw new AppleError(`no data container for ${bundleId}`);
    for (const entry of fs.readdirSync(dir)) {
      // The container's own metadata stays; everything the app wrote goes.
      if (entry.startsWith('.com.apple.mobile_container_manager')) continue;
      fs.rmSync(path.join(dir, entry), {recursive: true, force: true});
    }
    for (const sub of ['Documents', 'Library', 'tmp']) fs.mkdirSync(path.join(dir, sub), {recursive: true});
  }

  /** Where a named copy of an app's data lives on this Mac: next to pitbox's other caches, per simulator. */
  #appStateDir(udid: string, bundleId: string, name: string) {
    return path.join(os.homedir(), 'Library', 'Caches', 'pitbox', 'app-states', udid, bundleId, name);
  }

  async #container(udid: string, bundleId: string) {
    const dir = (await this.#ok(['get_app_container', udid, bundleId, 'data'], 'get_app_container')).trim();
    if (!dir || !fs.existsSync(dir) || !dir.includes('/Containers/Data/Application/')) throw new AppleError(`no data container for ${bundleId}`);
    return dir;
  }

  /**
   * A simulator's side of a named state: a copy of the app's data container (simctl has no snapshot of a whole
   * simulator). The app is stopped first, so nothing is half written; whether it was running is returned, so the
   * caller can launch it again.
   */
  async appStateSave(udid: string, bundleId: string, name: string): Promise<{wasRunning: boolean}> {
    if (physicalUdid(udid)) throw new AppleError('named app states are kept for simulators only', 'start from a fresh install on a device, or use a simulator');
    const wasRunning = (await this.pid(udid, bundleId).catch(() => undefined)) !== undefined;
    await this.stop(udid, bundleId);
    const dir = await this.#container(udid, bundleId);
    const dest = this.#appStateDir(udid, bundleId, name);
    fs.rmSync(dest, {recursive: true, force: true});
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.cpSync(dir, dest, {recursive: true});
    return {wasRunning};
  }

  /** Brings the app's data back as it was saved, with the app stopped; the next launch starts from it. */
  async appStateRestore(udid: string, bundleId: string, name: string) {
    if (physicalUdid(udid)) throw new AppleError('named app states are kept for simulators only', 'start from a fresh install on a device, or use a simulator');
    const src = this.#appStateDir(udid, bundleId, name);
    if (!fs.existsSync(src)) throw new AppleError(`no saved app data "${name}" for ${bundleId} on this simulator`);
    await this.stop(udid, bundleId);
    const dir = await this.#container(udid, bundleId);
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('.com.apple.mobile_container_manager')) continue;
      fs.rmSync(path.join(dir, entry), {recursive: true, force: true});
    }
    for (const entry of fs.readdirSync(src)) {
      if (entry.startsWith('.com.apple.mobile_container_manager')) continue;
      fs.cpSync(path.join(src, entry), path.join(dir, entry), {recursive: true});
    }
  }

  async appStateDelete(udid: string, bundleId: string, name: string) {
    fs.rmSync(this.#appStateDir(udid, bundleId, name), {recursive: true, force: true});
  }

  /**
   * Writes string values into the app's own preferences (its `UserDefaults`), through the simulator's cfprefsd so
   * the app sees them on its next launch. Writing to the plist file directly would be lost to cfprefsd's cache.
   */
  async setDefaults(udid: string, bundleId: string, values: Record<string, string>) {
    if (physicalUdid(udid)) throw new AppleError('an app\'s preferences on a device are not written from the Mac', 'pass them at launch: open with args -<key> <value> (UserDefaults reads launch arguments)');
    const dir = (await this.#ok(['get_app_container', udid, bundleId, 'data'], 'get_app_container')).trim();
    const domain = path.join(dir, 'Library', 'Preferences', bundleId);
    for (const [k, v] of Object.entries(values)) await this.#ok(['spawn', udid, 'defaults', 'write', domain, k, '-string', v], `defaults write ${k}`);
  }

  async uninstall(udid: string, bundleId: string) {
    if (physicalUdid(udid)) return this.physical.uninstall(udid, bundleId);
    await this.#ok(['uninstall', udid, bundleId], 'uninstall', 60_000);
  }

  /** The app's data container on this Mac (its Documents, Library, tmp); throws when the app is not installed. */
  dataContainer(udid: string, bundleId: string): Promise<string> {
    if (physicalUdid(udid)) throw new AppleError('an app\'s data container on a device is not on this Mac', 'use a simulator to read the app\'s files');
    return this.#container(udid, bundleId);
  }

  /** The installed .app on this Mac; undefined when the app is not installed. */
  async appBundle(udid: string, bundleId: string): Promise<string | undefined> {
    if (physicalUdid(udid)) return undefined;
    const r = await this.simctl(['get_app_container', udid, bundleId, 'app']);
    const dir = r.stdout.trim();
    return r.code === 0 && dir && fs.existsSync(dir) ? dir : undefined;
  }

  /** Where each simulator app was installed last, by `udid bundleId`: a reinstall moves it. */
  readonly #bundles = new Map<string, string>();

  /**
   * Whether the app runs on the simulator, from the Mac's process list: a simulator's apps are processes of the
   * Mac, started from the installed .app. About 25 ms, against a quarter of a second for asking launchctl inside the
   * simulator. Undefined when the app is not installed or the process list cannot be read.
   */
  async appRunning(udid: string, bundleId: string): Promise<boolean | undefined> {
    if (physicalUdid(udid)) return this.physical.appRunning(udid, bundleId);
    const key = `${udid} ${bundleId}`;
    let dir = this.#bundles.get(key);
    if (!dir || !fs.existsSync(dir)) {
      dir = await this.appBundle(udid, bundleId);
      if (!dir) return undefined;
      this.#bundles.set(key, dir);
    }
    const r = await run('ps', ['-ax', '-o', 'command='], {timeoutMs: 10_000, env: {...process.env, LC_ALL: 'C'}});
    if (r.code !== 0) return undefined;
    return appProcess(r.stdout, dir);
  }

  /** Posts a Darwin notification inside the simulator (`notifyutil -p`): what an app's observer of that name hears. */
  async notify(udid: string, name: string): Promise<void> {
    if (physicalUdid(udid)) return this.physical.notify(udid, name);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new AppleError(`not a notification name: ${JSON.stringify(name)}`);
    await this.#ok(['spawn', udid, 'notifyutil', '-p', name], 'notifyutil');
  }

  /**
   * Delivers an APNs payload to an app on a simulator, as Apple's push service would (`simctl push`): the app
   * must have asked for notification permission; the payload names its app in `Simulator Target Bundle`.
   */
  async push(udid: string, bundleId: string, payload: Record<string, unknown>): Promise<void> {
    if (physicalUdid(udid)) throw new AppleError('a device takes pushes from APNs, not from the Mac', 'send through APNs (sandbox) with the app\'s device token, or test the push on a simulator');
    const r = await this.simctl(['push', udid, bundleId, '-'], {input: JSON.stringify(payload), timeoutMs: 30_000});
    if (r.code !== 0) throw new AppleError(`push failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
  }

  async #apps(udid: string): Promise<Record<string, {ApplicationType?: string; CFBundleExecutable?: string; CFBundleDisplayName?: string; CFBundleShortVersionString?: string}>> {
    const list = await this.#ok(['listapps', udid], 'listapps');
    // simctl prints an old-style plist; plutil turns it into JSON.
    const r = await run('plutil', ['-convert', 'json', '-o', '-', '-'], {input: list, timeoutMs: 10_000});
    if (r.code !== 0) throw new AppleError(`could not read the app list: ${r.stderr.trim()}`);
    return JSON.parse(r.stdout);
  }

  /** Installed user apps (system apps left out). */
  async packages(udid: string, filter?: string): Promise<string[]> {
    if (physicalUdid(udid)) return this.physical.packages(udid, filter);
    const apps = await this.#apps(udid);
    return Object.entries(apps)
      .filter(([id, a]) => a.ApplicationType === 'User' && (!filter || id.includes(filter)))
      .map(([id]) => id)
      .sort();
  }

  /** Recent unified-log lines, of one app's process when `bundleId` is given. */
  async logs(udid: string, opts: {bundleId?: string; lines?: number; grep?: string; level?: string; since?: string} = {}): Promise<string[]> {
    if (physicalUdid(udid)) return this.physical.logs(udid, opts);
    const args = ['spawn', udid, 'log', 'show', '--style', 'compact', '--last', opts.since ?? '5m'];
    const preds: string[] = [];
    if (opts.bundleId) {
      const exe = (await this.#apps(udid))[opts.bundleId]?.CFBundleExecutable;
      if (!exe) return [`(${opts.bundleId} is not installed)`];
      preds.push(`process == "${exe.replace(/"/g, '\\"')}"`);
    }
    const level = opts.level?.toLowerCase();
    if (level === 'e' || level === 'error') preds.push('messageType >= error');
    else if (level === 'w' || level === 'warn' || level === 'f' || level === 'fault') preds.push('messageType >= fault');
    else if (level === 'd' || level === 'debug' || level === 'v') args.push('--debug', '--info');
    else args.push('--info');
    if (preds.length) args.push('--predicate', preds.join(' AND '));
    const r = await this.simctl(args, {timeoutMs: 30_000});
    // The first line is the column header.
    const body = r.stdout.split('\n').filter(l => !/^Timestamp\s+Ty/.test(l)).join('\n');
    return tailLines(body, opts.lines ?? 50, opts.grep);
  }

  async settings(
    udid: string,
    s: {fontScale?: number; dark?: boolean; animations?: boolean; size?: string; density?: string; locale?: string; grant?: {bundleId: string; service: string}; revoke?: {bundleId: string; service: string}; reset?: {bundleId: string; service: string}},
  ): Promise<string[]> {
    if (physicalUdid(udid)) return this.physical.settings(udid, s, contentSize);
    const done: string[] = [];
    if (s.size || s.density) throw new AppleError('a simulator has a fixed screen size', 'boot another device type instead');
    if (s.animations !== undefined) throw new AppleError('simctl cannot switch animations off', 'leave animations on; the runner waits for them');
    if (s.fontScale !== undefined) {
      const category = contentSize(s.fontScale);
      await this.#ok(['ui', udid, 'content_size', category], 'content_size');
      done.push(`content size ${category}`);
    }
    if (s.dark !== undefined) {
      await this.#ok(['ui', udid, 'appearance', s.dark ? 'dark' : 'light'], 'appearance');
      done.push(`dark ${s.dark ? 'on' : 'off'}`);
    }
    if (s.locale !== undefined) {
      // Device-wide: the app reads it on its next launch.
      const locales = s.locale.split(',').map(l => l.trim()).filter(l => l && l !== '""');
      if (locales.length) {
        await this.#ok(['spawn', udid, 'defaults', 'write', '-g', 'AppleLanguages', '-array', ...locales], 'set languages');
        await this.#ok(['spawn', udid, 'defaults', 'write', '-g', 'AppleLocale', '-string', locales[0]!.replace('-', '_')], 'set locale');
        done.push(`locale ${locales.join(',')} (relaunch the app)`);
      } else {
        await this.simctl(['spawn', udid, 'defaults', 'delete', '-g', 'AppleLanguages']);
        await this.simctl(['spawn', udid, 'defaults', 'delete', '-g', 'AppleLocale']);
        done.push('locale reset (relaunch the app)');
      }
    }
    for (const [action, p] of [['grant', s.grant], ['revoke', s.revoke], ['reset', s.reset]] as const) {
      if (!p) continue;
      await this.#ok(['privacy', udid, action, p.service, p.bundleId], `privacy ${action}`);
      done.push(`${action === 'grant' ? 'granted' : action === 'revoke' ? 'revoked' : 'reset (the app asks again)'} ${p.service}`);
    }
    return done;
  }

  async screenshot(udid: string, file: string): Promise<{file: string; bytes: number}> {
    if (physicalUdid(udid)) return this.physical.screenshot(udid, file);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    let r = await this.simctl(['io', udid, 'screenshot', '--type=png', file], {timeoutMs: 20_000});
    // A foldable has two screens and simctl will not pick one: the lit one is what the user sees.
    if (r.code !== 0 && /Cannot choose between \d+ displays/.test(r.stderr)) {
      const lit = (await this.displays(udid)).find(d => d.active);
      if (lit) r = await this.simctl(['io', udid, 'screenshot', '--type=png', `--display=${lit.id}`, file], {timeoutMs: 20_000});
    }
    if (r.code !== 0 || !fs.existsSync(file)) throw new AppleError(`screenshot failed: ${r.stderr.trim().split('\n').pop()}`);
    return {file, bytes: fs.statSync(file).size};
  }

  /** The simulator's screens as CoreDevice reports them: which one is lit, and its size in pixels. */
  async displays(udid: string): Promise<Display[]> {
    const r = await run('xcrun', ['devicectl', 'device', 'info', 'displays', '--device', udid, '-q', '-j', '-'], {timeoutMs: 20_000});
    if (r.code !== 0) return [];
    try {
      return parseDisplays(JSON.parse(r.stdout));
    } catch {
      return [];
    }
  }

  /**
   * Folds a foldable: `closed` (the cover screen) or `open` (the inner one) swing the hinge through recorded hinge
   * motion, so the system and the app see the angle change; `swap` changes the lit screen at once without moving the
   * hinge. A speed may follow: `open slow`. The lit screen is read before, and after until it has changed.
   */
  /**
   * Folds a foldable the way Xcode's device window does: the hinge swings to a pose (closed 0°, half 130°, open
   * 180°, or any angle) and the system moves the app between the screens; `swap` changes the lit screen at once
   * without moving the hinge.
   */
  async fold(udid: string, value: string): Promise<{udid: string; posture: string; states: string[]; angle?: number; screen?: string; ms: number}> {
    const t0 = Date.now();
    const states = ['closed', 'half', 'open', 'swap', '<degrees>'];
    const [posture = '', speed = 'fast'] = value.trim().split(/\s+/);
    const sim = (await this.simulators()).find(s => s.udid === udid);
    if (sim?.kind !== 'foldable') throw new AppleError(`${sim?.name ?? udid} has no hinge`, 'posture is for foldables');
    const angle = posture in POSES ? POSES[posture] : /^\d+(\.\d+)?$/.test(posture) ? Number(posture) : undefined;
    if (posture !== 'swap' && (angle === undefined || angle > 180)) throw new AppleError(`an Apple foldable takes ${states.join(', ')} (0-180)`, 'posture closed|half|open|<degrees> [fast|medium|slow] · posture swap');
    const seconds = SPEEDS[speed];
    if (seconds === undefined) throw new AppleError(`unknown hinge speed "${speed}"`, 'fast, medium or slow');
    const folded = async () => {
      const state = foldState(await this.displays(udid));
      if (!state) throw new AppleError('cannot tell which screen is lit', 'devicectl device info displays answers nothing for this simulator');
      return state.startsWith('folded');
    };
    const was = await folded();
    // Only the ends of the swing say which screen must be lit; in between it is the system's choice.
    const want = posture === 'swap' ? !was : angle === 0 ? true : angle! >= POSES.half! ? false : undefined;
    const {foldTool} = await import('./fold.ts');
    // The helper swings from where it last left the hinge; the lit screen is the guess for its first swing.
    const args = posture === 'swap' ? ['swap', '0.5'] : ['hinge', String(angle), was ? '0' : '180', String(seconds)];
    const r = await this.simctl(['spawn', udid, await foldTool(), ...args], {timeoutMs: 60_000});
    if (r.code !== 0) throw new AppleError(`fold failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
    const deadline = Date.now() + 8000;
    while (want !== undefined && (await folded()) !== want) {
      if (Date.now() > deadline) throw new AppleError(`the hinge moved but the simulator stayed ${want ? 'open' : 'folded'}`, posture === 'swap' ? 'its reason is in the simulator log: SBDisplayToolService' : 'the motion service did not take the hinge angle: see locationd in the simulator log');
      await new Promise(res => setTimeout(res, 300));
    }
    const screen = foldState(await this.displays(udid));
    return {udid, posture, states, ...(angle !== undefined ? {angle} : {}), ...(screen ? {screen} : {}), ms: Date.now() - t0};
  }

  /**
   * Turns a foldable through its motion input, as Xcode's orientation picker does: the device window draws the
   * turned phone and the system sees the new orientation. Rotation in degrees, as on Android.
   */
  async turn(udid: string, rotation: string): Promise<void> {
    if (physicalUdid(udid)) throw new AppleError('a device is turned by the runner, not its motion input', 'use rotate 0|90|180|270');
    const orientation = TURNS[rotation === 'auto' ? '0' : rotation];
    if (!orientation) throw new AppleError('rotate 0, 90, 180, 270 or auto');
    const {foldTool} = await import('./fold.ts');
    const r = await this.simctl(['spawn', udid, await foldTool(), 'orient', orientation], {timeoutMs: 30_000});
    if (r.code !== 0) throw new AppleError(`turn failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  }

  /** The pid of a running app, from the simulator's launchd. */
  async pid(udid: string, bundleId: string): Promise<number | undefined> {
    if (physicalUdid(udid)) return this.physical.pid(udid, bundleId);
    const r = await this.simctl(['spawn', udid, 'launchctl', 'list'], {timeoutMs: 10_000});
    const line = r.stdout.split('\n').find(l => l.includes(`UIKitApplication:${bundleId}[`));
    const pid = Number(line?.split('\t')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  /**
   * Memory of the running app. A simulator app is a process of the Mac, so `ps` reads it directly. There is no
   * frame counter like Android's gfxinfo: frames stay unknown rather than estimated.
   */
  async perf(udid: string, bundleId: string, reset = false): Promise<{reset?: boolean; memoryMb?: number; note?: string}> {
    if (physicalUdid(udid)) throw new AppleError('memory of an app on a device is not read yet', 'use Instruments, or a simulator for perf');
    if (reset) return {reset: true, note: 'nothing to reset on a simulator: memory is read live, frames are not counted'};
    const pid = await this.pid(udid, bundleId);
    if (!pid) throw new AppleError(`${bundleId} is not running`, 'open it first');
    const r = await run('ps', ['-o', 'rss=', '-p', String(pid)], {timeoutMs: 5000});
    const kb = Number(r.stdout.trim());
    return {memoryMb: Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : undefined, note: 'resident memory; frame stats are not available on simulators'};
  }

  async info(udid: string): Promise<Record<string, string>> {
    if (physicalUdid(udid)) return this.physical.info(udid);
    const sim = (await this.simulators()).find(s => s.udid === udid);
    if (!sim) throw new AppleError(`unknown simulator ${udid}`);
    const [appearance, size] = await Promise.all([this.simctl(['ui', udid, 'appearance']), this.simctl(['ui', udid, 'content_size'])]);
    const out: Record<string, string> = {model: sim.name, os: sim.os, kind: sim.kind, state: sim.state, appearance: appearance.stdout.trim(), contentSize: size.stdout.trim()};
    if (sim.kind === 'foldable' && sim.state === 'Booted') {
      const fold = foldState(await this.displays(udid));
      if (fold) out.fold = fold;
    }
    return out;
  }
}

/** Hinge angles of the poses in Xcode's device window, and how long a swing takes. */
const POSES: Record<string, number> = {closed: 0, half: 130, open: 180};
const SPEEDS: Record<string, number> = {fast: 0.8, medium: 1.5, slow: 3};
/** Android rotations as the orientations the motion service takes. */
const TURNS: Record<string, string> = {'0': 'portrait', '90': 'landscape-left', '180': 'pud', '270': 'landscape-right'};

/** Which screen of a foldable is lit: the smaller one is the cover (folded), the larger the inner (open). */
export const foldState = (displays: Display[]): string | undefined => {
  const lit = displays.find(d => d.active);
  const other = displays.find(d => d !== lit && d.width * d.height > 0);
  if (!lit || !other) return undefined;
  const folded = lit.width * lit.height < other.width * other.height;
  return `${folded ? 'folded: cover screen' : 'open: inner screen'} ${lit.width}x${lit.height}`;
};

/** CFBundleIdentifier of a built .app, read from its Info.plist (binary or XML). */
export const bundleIdOf = async (app: string): Promise<string | undefined> => {
  const plist = path.join(app, 'Info.plist');
  if (!fs.existsSync(plist)) return undefined;
  const r = await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], {timeoutMs: 10_000});
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
};
