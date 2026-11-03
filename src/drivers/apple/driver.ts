// Apple driver: iPhone, iPad, Apple TV, Apple Vision Pro and Apple Watch simulators, all through simctl.
// The agent never calls xcrun itself; every operation it needs is here. Gaps of the simulator tooling are
// reported as unsupported, never emulated silently.

import fs from 'node:fs';
import path from 'node:path';
import {run, which, type RunResult} from '../../util/proc.ts';
import {tailLines} from '../../util/text.ts';

export type SimKind = 'phone' | 'foldable' | 'tablet' | 'tv' | 'xr' | 'watch';

export type Simulator = {udid: string; name: string; state: string; runtime: string; os: string; kind: SimKind; available: boolean};

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
    })),
  );
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

export const isAppleBundle = (file: string) => /\.(app|ipa)\/?$/i.test(file);

export class AppleDriver {
  readonly xcrun: string;

  constructor() {
    if (process.platform !== 'darwin') throw new AppleError('Apple simulators run on macOS only');
    const xcrun = which('xcrun');
    if (!xcrun) throw new AppleError('xcrun not found', 'install Xcode and run `xcode-select -s /Applications/Xcode.app`');
    this.xcrun = xcrun;
  }

  simctl(args: string[], opts: {timeoutMs?: number; encoding?: 'buffer'; input?: string} = {}): Promise<RunResult & {buffer?: Buffer}> {
    return run(this.xcrun, ['simctl', ...args], {timeoutMs: opts.timeoutMs ?? 30_000, ...(opts.encoding ? {encoding: opts.encoding} : {}), ...(opts.input !== undefined ? {input: opts.input} : {})});
  }

  async #ok(args: string[], what: string, timeoutMs = 30_000): Promise<string> {
    const r = await this.simctl(args, {timeoutMs});
    if (r.code !== 0) throw new AppleError(`${what} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
    return r.stdout;
  }

  async simulators(): Promise<Simulator[]> {
    const r = await this.simctl(['list', 'devices', '-j'], {timeoutMs: 15_000});
    if (r.code !== 0) throw new AppleError(`simctl list failed: ${r.stderr.trim()}`, 'is Xcode installed and its license accepted (`sudo xcodebuild -license accept`)?');
    return parseSimulators(r.stdout).filter(s => s.available);
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
    if (booted.length === 1) return booted[0]!.udid;
    if (!booted.length) throw new AppleError('no booted simulator', 'boot one with `boot <name>`');
    throw new AppleError('several simulators booted', `pass a device: ${booted.map(s => s.udid).join(', ')}`);
  }

  async boot(selector: string, opts: {headless?: boolean; wipe?: boolean; timeoutMs?: number} = {}): Promise<{udid: string; name: string; ms: number; already: boolean; note?: string}> {
    const t0 = Date.now();
    const sims = await this.simulators();
    const sim = pickSimulator(sims, selector);
    if (!sim) throw new AppleError(`unknown simulator "${selector}"`, `available: ${[...new Set(sims.map(s => s.name))].join(', ') || 'none — create one in Xcode › Devices'}`);
    if (sim.state === 'Booted' && !opts.wipe) {
      const note = opts.headless ? undefined : await this.#showWindow(sim.udid);
      return {udid: sim.udid, name: sim.name, ms: 0, already: true, ...(note ? {note} : {})};
    }
    if (opts.wipe) {
      if (sim.state === 'Booted') await this.simctl(['shutdown', sim.udid], {timeoutMs: 60_000});
      await this.#ok(['erase', sim.udid], 'erase', 120_000);
    }
    const r = await this.simctl(['boot', sim.udid], {timeoutMs: 120_000});
    if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) throw new AppleError(`boot failed: ${r.stderr.trim().split('\n').pop()}`);
    const timeoutMs = opts.timeoutMs ?? 240_000;
    const status = await this.simctl(['bootstatus', sim.udid, '-b'], {timeoutMs});
    if (status.timedOut) throw new AppleError(`${sim.name} did not finish booting in ${Math.round(timeoutMs / 1000)}s`, 'try `boot --wipe`');
    const note = opts.headless ? undefined : await this.#showWindow(sim.udid);
    return {udid: sim.udid, name: sim.name, ms: Date.now() - t0, already: false, ...(note ? {note} : {})};
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

  async shutdown(udid: string): Promise<{ms: number; gone: boolean}> {
    const t0 = Date.now();
    const r = await this.simctl(['shutdown', udid], {timeoutMs: 60_000});
    if (r.code !== 0 && !/current state: Shutdown/i.test(r.stderr)) throw new AppleError(`shutdown failed: ${r.stderr.trim()}`);
    return {ms: Date.now() - t0, gone: true};
  }

  async install(udid: string, bundle: string): Promise<{ms: number; replaced: boolean; bundleId?: string}> {
    if (!fs.existsSync(bundle)) throw new AppleError(`no such file: ${bundle}`);
    if (/\.ipa$/i.test(bundle)) throw new AppleError('an .ipa is a device build', 'simulators take the .app from a simulator build (Products/Debug-iphonesimulator/MyApp.app)');
    const t0 = Date.now();
    await this.#ok(['install', udid, bundle], 'install', 600_000);
    return {ms: Date.now() - t0, replaced: false, bundleId: await bundleIdOf(bundle)};
  }

  /** Opens an app by bundle id or a deep link URL. `totalMs` is the time until the app process runs. */
  async open(udid: string, target: string, opts: {relaunch?: boolean; bundleId?: string; args?: string[]} = {}): Promise<{totalMs?: number; pid?: number}> {
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
    const r = await this.simctl(['terminate', udid, bundleId]);
    // Terminating an app that does not run is fine.
    if (r.code !== 0 && !/found nothing to terminate|not running/i.test(r.stderr)) throw new AppleError(`terminate failed: ${r.stderr.trim()}`);
  }

  /** Wipes the app's data container (Documents, Library, tmp) — simctl has no `pm clear`. */
  async clear(udid: string, bundleId: string) {
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

  /**
   * Writes string values into the app's own preferences (its `UserDefaults`), through the simulator's cfprefsd so
   * the app sees them on its next launch. Writing to the plist file directly would be lost to cfprefsd's cache.
   */
  async setDefaults(udid: string, bundleId: string, values: Record<string, string>) {
    const dir = (await this.#ok(['get_app_container', udid, bundleId, 'data'], 'get_app_container')).trim();
    const domain = path.join(dir, 'Library', 'Preferences', bundleId);
    for (const [k, v] of Object.entries(values)) await this.#ok(['spawn', udid, 'defaults', 'write', domain, k, '-string', v], `defaults write ${k}`);
  }

  async uninstall(udid: string, bundleId: string) {
    await this.#ok(['uninstall', udid, bundleId], 'uninstall', 60_000);
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
    const apps = await this.#apps(udid);
    return Object.entries(apps)
      .filter(([id, a]) => a.ApplicationType === 'User' && (!filter || id.includes(filter)))
      .map(([id]) => id)
      .sort();
  }

  /** Recent unified-log lines, of one app's process when `bundleId` is given. */
  async logs(udid: string, opts: {bundleId?: string; lines?: number; grep?: string; level?: string; since?: string} = {}): Promise<string[]> {
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
    s: {fontScale?: number; dark?: boolean; animations?: boolean; size?: string; density?: string; locale?: string; grant?: {bundleId: string; service: string}; revoke?: {bundleId: string; service: string}},
  ): Promise<string[]> {
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
    for (const [action, p] of [['grant', s.grant], ['revoke', s.revoke]] as const) {
      if (!p) continue;
      await this.#ok(['privacy', udid, action, p.service, p.bundleId], `privacy ${action}`);
      done.push(`${action === 'grant' ? 'granted' : 'revoked'} ${p.service}`);
    }
    return done;
  }

  async screenshot(udid: string, file: string): Promise<{file: string; bytes: number}> {
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
    const orientation = TURNS[rotation === 'auto' ? '0' : rotation];
    if (!orientation) throw new AppleError('rotate 0, 90, 180, 270 or auto');
    const {foldTool} = await import('./fold.ts');
    const r = await this.simctl(['spawn', udid, await foldTool(), 'orient', orientation], {timeoutMs: 30_000});
    if (r.code !== 0) throw new AppleError(`turn failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  }

  /** The pid of a running app, from the simulator's launchd. */
  async pid(udid: string, bundleId: string): Promise<number | undefined> {
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
    if (reset) return {reset: true, note: 'nothing to reset on a simulator: memory is read live, frames are not counted'};
    const pid = await this.pid(udid, bundleId);
    if (!pid) throw new AppleError(`${bundleId} is not running`, 'open it first');
    const r = await run('ps', ['-o', 'rss=', '-p', String(pid)], {timeoutMs: 5000});
    const kb = Number(r.stdout.trim());
    return {memoryMb: Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : undefined, note: 'resident memory; frame stats are not available on simulators'};
  }

  async info(udid: string): Promise<Record<string, string>> {
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
