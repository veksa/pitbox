// Android driver: phones, foldables, tablets, TV and XR — emulators and hardware, all through adb.
// The agent never calls adb itself; every operation it needs is here.

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {isAlive, launchHidden, run, type RunResult} from '../../util/proc.ts';
import {tailLines} from '../../util/text.ts';
import {avdHome, avdKind, findAdb, findEmulator, listAvds} from './sdk.ts';
import {car, physicalDisplays, pngFrom, posture, rotate, wear, windowMode} from './formfactor.ts';
import {summarizeAtrace, type TraceSummary} from './atrace.ts';
import {connected, paired, parseMdnsServices, type MdnsService} from './wifi.ts';

/**
 * `instance`: which emulator this is (`pid:<n>`, the emulator process) — a serial is reused by the next emulator on
 * that port, a process is not, and a reboot of the guest keeps it. Undefined for hardware (its serial is its own) and
 * while the device is not online.
 */
export type AndroidDevice = {serial: string; state: string; model?: string; avd?: string; kind?: string; emulator: boolean; instance?: string};

/** The emulator process from `adb emu avd discoverypath` (`…/avd/running/pid_4242.ini`). */
export const emulatorInstance = (discoveryPath: string): string | undefined => {
  const pid = /pid_(\d+)\.ini/.exec(discoveryPath)?.[1];
  return pid ? `pid:${pid}` : undefined;
};

export type PerfReport = {reset?: boolean; frames?: number; janky?: number; p50?: number; p90?: number; p99?: number; memoryMb?: number};

export type NetworkProfile = 'full' | 'lte' | 'umts' | 'edge' | 'gsm' | 'offline' | 'online';

export const KEYS: Record<string, number> = {
  home: 3,
  back: 4,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  center: 23,
  select: 23,
  enter: 66,
  del: 67,
  menu: 82,
  search: 84,
  playpause: 85,
  appswitch: 187,
  wakeup: 224,
  // Keyboards (tablets, desktops)
  tab: 61,
  space: 62,
  escape: 111,
  forward_del: 112,
  page_up: 92,
  page_down: 93,
  move_home: 122,
  move_end: 123,
  // Media and TV remotes
  play: 126,
  pause: 127,
  stop: 86,
  next: 87,
  previous: 88,
  rewind: 89,
  fast_forward: 90,
  volume_up: 24,
  volume_down: 25,
  mute: 164,
  channel_up: 166,
  channel_down: 167,
  guide: 172,
  info: 165,
  captions: 175,
  settings: 176,
  // Watch buttons
  stem_primary: 264,
  stem_1: 265,
  stem_2: 266,
};

const lockDir = (avd: string) => path.join(avdHome(), `${avd}.avd`, 'hardware-qemu.ini.lock');

/** Whether `pid` is a running emulator: a lock's pid can belong to an unrelated process by now (ids are reused). */
const emulatorAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {encoding: 'utf8', windowsHide: true, timeout: 5000})
        : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {encoding: 'utf8', timeout: 5000});
    return /qemu|emulator/i.test(out);
  } catch {
    return true;
  }
};

/** Whether a running emulator holds the AVD (its lock names a live emulator process). */
export const avdLocked = (avd: string): boolean => {
  let pid = NaN;
  try {
    pid = Number(fs.readFileSync(path.join(lockDir(avd), 'pid'), 'utf8').trim());
  } catch {
    return false;
  }
  return Number.isInteger(pid) && pid > 0 && emulatorAlive(pid);
};

/** A lock left by an emulator that died: the next one would refuse the AVD. */
const clearStaleAvdLock = (avd: string) => {
  try {
    if (fs.existsSync(lockDir(avd)) && !avdLocked(avd)) fs.rmSync(lockDir(avd), {recursive: true, force: true});
  } catch {
    // unreadable lock: the emulator decides
  }
};

export class AndroidError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(hint ? `${message}\nhint: ${hint}` : message);
    this.hint = hint;
  }
}

export class AndroidDriver {
  readonly adbPath: string;

  /** `adbPath` stands in for the one found on the machine (tests). */
  constructor(adbPath?: string) {
    const adb = adbPath ?? findAdb();
    if (!adb) throw new AndroidError('adb not found', 'install Android SDK platform-tools or set ANDROID_HOME');
    this.adbPath = adb;
  }

  adb(args: string[], serial?: string, opts: {timeoutMs?: number; encoding?: 'buffer'} = {}): Promise<RunResult & {buffer?: Buffer}> {
    return run(this.adbPath, serial ? ['-s', serial, ...args] : args, {timeoutMs: opts.timeoutMs ?? 30_000, ...(opts.encoding ? {encoding: opts.encoding} : {})});
  }

  async shell(serial: string, command: string, timeoutMs = 30_000): Promise<string> {
    const r = await this.adb(['shell', command], serial, {timeoutMs});
    if (r.code !== 0 && !r.stdout) throw new AndroidError(`adb shell failed: ${command}\n${r.stderr.trim()}`);
    return r.stdout.replace(/\r/g, '');
  }

  /**
   * AVD name and instance per connection, asked once: asking the emulator console every time is slow and busies adb.
   * Keyed by serial and adb's transport id, and dropped as soon as the device is not online: a new emulator on a
   * reused port is a new connection, and never inherits the answers of the one before it.
   */
  readonly #known = new Map<string, {avd?: string; instance?: string}>();

  async devices(): Promise<AndroidDevice[]> {
    let r = await this.adb(['devices', '-l'], undefined, {timeoutMs: 8000});
    // A busy adb server can hang a call; one retry before reporting no devices.
    if (r.timedOut || r.code !== 0) r = await this.adb(['devices', '-l'], undefined, {timeoutMs: 15_000});
    if (r.timedOut) throw new AndroidError('the adb server is not responding', '`doctor --fix` restarts it (a wedged server makes every device look offline)');
    const lines = r.stdout.replace(/\r/g, '').split('\n').slice(1).filter(l => l.trim());
    const keyOf = (line: string) => {
      const [serial = '', state = ''] = line.trim().split(/\s+/);
      return {serial, state, key: `${serial}#${/transport_id:(\d+)/.exec(line)?.[1] ?? ''}`};
    };
    const live = new Set(lines.map(keyOf).filter(x => x.state === 'device').map(x => x.key));
    for (const k of [...this.#known.keys()]) if (!live.has(k)) this.#known.delete(k);
    return Promise.all(
      lines.map(async line => {
        const {serial, state, key} = keyOf(line);
        const model = /model:(\S+)/.exec(line)?.[1];
        const emulator = serial.startsWith('emulator-');
        let known = this.#known.get(key);
        if (emulator && state === 'device' && !known) {
          const name = await this.adb(['emu', 'avd', 'name'], serial, {timeoutMs: 5000});
          const avd = name.stdout.replace(/\r/g, '').split('\n')[0]?.trim() || undefined;
          const where = await this.adb(['emu', 'avd', 'discoverypath'], serial, {timeoutMs: 5000});
          known = {avd, instance: emulatorInstance(where.stdout)};
          if (avd) this.#known.set(key, known);
        }
        const {avd, instance} = known ?? {};
        return {serial, state, model, avd, kind: avd ? avdKind(avd) : undefined, emulator, ...(instance ? {instance} : {})};
      }),
    );
  }

  avds() {
    return listAvds().map(name => ({name, kind: avdKind(name)}));
  }

  /** Picks a device: by serial, AVD name or model; the only online device when no selector is given. */
  async resolve(selector?: string): Promise<string> {
    let online = (await this.devices()).filter(d => d.state === 'device');
    // adb sometimes answers an empty list while it is busy with concurrent calls; ask once more before failing.
    if (!online.length) {
      await new Promise(r => setTimeout(r, 400));
      online = (await this.devices()).filter(d => d.state === 'device');
    }
    if (selector) {
      const hit = online.find(d => d.serial === selector || d.avd === selector || d.model === selector);
      if (hit) return hit.serial;
      throw new AndroidError(`no online device matches "${selector}"`, online.length ? `online: ${online.map(d => d.avd ?? d.serial).join(', ')}` : 'boot one with `boot`');
    }
    if (online.length === 1) return online[0]!.serial;
    if (!online.length) throw new AndroidError('no online Android device', 'boot an emulator with `boot <avd>` or connect a device');
    throw new AndroidError('several devices online', `pass a device: ${online.map(d => d.avd ?? d.serial).join(', ')}`);
  }

  /**
   * Boots an AVD, or answers the instance already running. `newInstance` starts another instance of an AVD that
   * runs already (another session holds it): `-read-only`, so the two share the AVD's disk images and the new
   * one's changes are dropped when it exits.
   */
  async boot(avd: string, opts: {wipe?: boolean; headless?: boolean; coldBoot?: boolean; timeoutMs?: number; newInstance?: boolean} = {}): Promise<{serial: string; ms: number; already: boolean; readOnly?: boolean}> {
    const t0 = Date.now();
    const before = await this.devices();
    const running = before.find(d => d.avd === avd && d.state === 'device');
    const readOnly = !!opts.newInstance;
    if (running && !opts.newInstance) return {serial: running.serial, ms: 0, already: true};
    if (!listAvds().includes(avd)) throw new AndroidError(`unknown AVD "${avd}"`, `available: ${listAvds().join(', ') || 'none'}`);
    if (readOnly && opts.wipe) throw new AndroidError(`${avd} runs already: a second instance cannot wipe it`, 'boot another AVD to start clean');
    const emulator = findEmulator();
    if (!emulator) throw new AndroidError('emulator binary not found', 'install the Android Emulator SDK package');
    if (!readOnly) clearStaleAvdLock(avd);
    const args = ['-avd', avd, '-no-boot-anim', '-no-audio'];
    if (readOnly) args.push('-read-only');
    if (opts.coldBoot !== false) args.push('-no-snapshot-load');
    if (opts.wipe) args.push('-wipe-data');
    if (opts.headless) args.push('-no-window');
    const pid = await launchHidden(emulator, args);
    const deadline = t0 + (opts.timeoutMs ?? 240_000);
    // The instance this boot starts: not one that ran before it.
    const earlier = new Set(before.filter(d => d.avd === avd).map(d => d.serial));
    const mine = (list: AndroidDevice[]) => list.find(d => d.avd === avd && !earlier.has(d.serial));
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const all = await this.devices();
      const dev = [mine(all)].find(d => d?.state === 'device');
      // An emulator that exits on its way up (a lock, the hypervisor, a broken image) leaves nothing to wait for.
      if (!dev && pid && !isAlive(pid) && !mine(await this.devices())) {
        throw new AndroidError(`the emulator for ${avd} exited ${Math.round((Date.now() - t0) / 1000)}s into its boot`, `start it by hand to see why: emulator -avd ${avd}`);
      }
      if (!dev) continue;
      const booted = await this.adb(['shell', 'getprop', 'sys.boot_completed'], dev.serial, {timeoutMs: 5000});
      if (booted.stdout.trim() === '1') {
        // An emulator for automation: the screen stays on and the swipe-away lock screen is gone, or it comes back
        // mid-run and every app is behind it.
        await this.shell(dev.serial, 'svc power stayon true; wm dismiss-keyguard').catch(() => '');
        return {serial: dev.serial, ms: Date.now() - t0, already: false, ...(readOnly ? {readOnly} : {})};
      }
    }
    throw new AndroidError(`${avd} did not finish booting in ${Math.round((opts.timeoutMs ?? 240_000) / 1000)}s`, 'try `boot --wipe` if it hangs on the boot screen');
  }

  /** Shuts an emulator down and waits until adb no longer lists it (it takes ~20 s to save and exit). */
  async shutdown(serial: string, timeoutMs = 60_000): Promise<{ms: number; gone: boolean}> {
    const t0 = Date.now();
    const all = await this.devices();
    const avd = all.find(d => d.serial === serial)?.avd;
    // Another instance of the AVD (a -read-only one, or the one a -read-only one runs beside) holds its lock: the lock
    // is then no sign of this instance, and waiting for it would wait for the other session's emulator.
    const sharesAvd = !!avd && all.some(d => d.serial !== serial && d.avd === avd);
    // Killing the emulator drops what the guest has not written out yet: an APK installed just before can be
    // gone after the next boot while the package manager still lists it.
    await this.adb(['shell', 'sync'], serial, {timeoutMs: 20_000}).catch(() => undefined);
    await this.adb(['emu', 'kill'], serial, {timeoutMs: 10_000});
    while (Date.now() - t0 < timeoutMs) {
      // Gone from adb is not gone: the emulator still writes its disk and holds the AVD's lock for a few
      // seconds, and a boot in that window exits without a word.
      if (!(await this.devices()).some(d => d.serial === serial) && !(avd && !sharesAvd && avdLocked(avd))) return {ms: Date.now() - t0, gone: true};
      await new Promise(r => setTimeout(r, 1000));
    }
    return {ms: Date.now() - t0, gone: false};
  }

  async install(serial: string, apk: string, opts: {replace?: boolean; pkg?: string} = {}): Promise<{ms: number; replaced: boolean}> {
    if (!fs.existsSync(apk)) throw new AndroidError(`no such file: ${apk}`);
    const t0 = Date.now();
    let r = await this.adb(['install', '-r', '-d', '-g', apk], serial, {timeoutMs: 600_000});
    const out = `${r.stdout}\n${r.stderr}`;
    let replaced = false;
    // Another signature, or a higher version code on a build that is not debuggable: only uninstalling helps.
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match|INSTALL_FAILED_VERSION_DOWNGRADE/i.test(out)) {
      const pkg = opts.pkg ?? /package (\S+) signatures/i.exec(out)?.[1] ?? /Package (\S+)/.exec(out)?.[1];
      if (!opts.replace || !pkg) {
        const why = /DOWNGRADE/.test(out) ? 'a newer build is installed' : 'installed app has a different signature';
        throw new AndroidError(why, `pass replace=true to uninstall ${pkg ?? 'it'} first (its data is lost)`);
      }
      await this.adb(['uninstall', pkg], serial, {timeoutMs: 60_000});
      r = await this.adb(['install', '-r', '-d', '-g', apk], serial, {timeoutMs: 600_000});
      replaced = true;
    }
    if (!/Success/.test(`${r.stdout}${r.stderr}`)) {
      const reason = /Failure \[([^\]]+)\]/.exec(`${r.stdout}${r.stderr}`)?.[1] ?? r.stderr.trim().split('\n').pop();
      throw new AndroidError(`install failed: ${reason}`, /INSUFFICIENT_STORAGE/.test(reason ?? '') ? 'free space on /data: uninstall something or wipe the emulator' : undefined);
    }
    return {ms: Date.now() - t0, replaced};
  }

  /**
   * Whether the user's storage is still locked: after a boot of a device with a screen lock, no ordinary app can
   * start (its activities do not even resolve) until the PIN or pattern is entered.
   */
  async userLocked(serial: string): Promise<boolean> {
    const out = await this.shell(serial, 'dumpsys user | grep -m1 "State:"').catch(() => '');
    return /RUNNING_LOCKED/.test(out);
  }

  /** Folds or unfolds a foldable: closed, half, open, rear, or reset (see formfactor.ts). */
  posture(serial: string, name: string) {
    return posture((s, c, t) => this.shell(s, c, t), serial, name);
  }

  /** Locks the rotation at 0/90/180/270, or `auto`. */
  rotate(serial: string, rotation: string) {
    return rotate((s, c, t) => this.shell(s, c, t), serial, rotation);
  }

  /** Car-only operations: day/night, driving, parking, the rotary controller (see formfactor.ts). */
  car(serial: string, op: string, args: string[]) {
    return car((s, c, t) => this.shell(s, c, t), serial, op, args);
  }

  /** Watch-only operations: tiles, the watch face, ambient, home (see formfactor.ts). */
  wear(serial: string, op: string, args: string[]) {
    return wear((s, c, t) => this.shell(s, c, t), serial, op, args);
  }

  /** The app as a freeform window, fullscreen again, or a freeform window resized. */
  window(serial: string, pkg: string, mode: string, bounds?: string) {
    return windowMode((s, c, t) => this.shell(s, c, t), serial, pkg, () => this.launcherActivity(serial, pkg), mode, bounds);
  }

  async launcherActivity(serial: string, pkg: string): Promise<string> {
    const out = await this.shell(serial, `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`);
    let line = out.trim().split('\n').pop()?.trim();
    if (!line || !line.includes('/')) {
      // TV apps declare LEANBACK_LAUNCHER instead.
      const tv = await this.shell(serial, `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER ${pkg}`);
      line = tv.trim().split('\n').pop()?.trim();
    }
    if (!line || !line.includes('/')) {
      if (await this.userLocked(serial)) throw new AndroidError('the device is locked: no app can start until its screen lock is entered', 'unlock it once, or remove the screen lock in Settings → Security on this device');
      throw new AndroidError(`no launcher activity for ${pkg}`, 'is the app installed? `apps` lists packages');
    }
    return line;
  }

  /** Opens an app by package or a deep link URL. Returns the launch time the activity manager reports. */
  async open(serial: string, target: string, opts: {relaunch?: boolean; pkg?: string} = {}): Promise<{totalMs?: number; component?: string}> {
    const isUrl = target.includes('://');
    const pkg = isUrl ? opts.pkg : target;
    // A screen that went dark and its swipe-away lock screen hide whatever is opened; a PIN lock is not touched.
    await this.shell(serial, 'input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard').catch(() => '');
    if (opts.relaunch && pkg) {
      await this.shell(serial, `am force-stop ${pkg}`);
      // The stopped app's window plays its exit for a moment and stays in the accessibility tree meanwhile: a wait
      // could find the old screen there and a tap land on it. The relaunch waits for it to go (a theme change
      // makes the exit longer).
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        const n = Number((await this.shell(serial, `dumpsys window windows | grep -c 'u0 ${pkg}/'`).catch(() => '0')).trim());
        if (!n) break;
        await new Promise(r => setTimeout(r, 100));
      }
    }
    let cmd: string;
    let component: string | undefined;
    if (isUrl) {
      cmd = `am start -W -a android.intent.action.VIEW -d '${target.replace(/'/g, `'\\''`)}'${pkg ? ` ${pkg}` : ''}`;
    } else {
      component = await this.launcherActivity(serial, target);
      cmd = `am start -W -n ${component}`;
    }
    const out = await this.shell(serial, cmd, 60_000);
    if (/Error:|does not exist|unable to resolve/i.test(out)) throw new AndroidError(`launch failed: ${out.trim().split('\n').find(l => /Error|exist|resolve/i.test(l))}`);
    const total = /TotalTime:\s*(\d+)/.exec(out)?.[1];
    return {totalMs: total ? Number(total) : undefined, component};
  }

  async stop(serial: string, pkg: string) {
    await this.shell(serial, `am force-stop ${pkg}`);
  }

  async clear(serial: string, pkg: string) {
    const out = await this.shell(serial, `pm clear ${pkg}`);
    if (!/Success/.test(out)) throw new AndroidError(`pm clear failed: ${out.trim()}`);
  }

  async uninstall(serial: string, pkg: string) {
    const r = await this.adb(['uninstall', pkg], serial, {timeoutMs: 60_000});
    if (!/Success/.test(r.stdout)) throw new AndroidError(`uninstall failed: ${(r.stdout + r.stderr).trim()}`);
  }

  async packages(serial: string, filter?: string): Promise<string[]> {
    const out = await this.shell(serial, 'pm list packages -3');
    return out
      .split('\n')
      .map(l => l.replace(/^package:/, '').trim())
      .filter(p => p && (!filter || p.includes(filter)))
      .sort();
  }

  /** Recent log lines, of one app's process when `pkg` is given and running. */
  async logs(serial: string, opts: {pkg?: string; lines?: number; grep?: string; level?: string} = {}): Promise<string[]> {
    const args = ['logcat', '-d', '-v', 'time'];
    if (opts.pkg) {
      // pidof exits 1 when nothing runs, which the shell reports as a failure.
      const pid = (await this.shell(serial, `pidof ${opts.pkg}`).catch(() => '')).trim().split(/\s+/)[0];
      if (pid) args.push(`--pid=${pid}`);
      else if (!opts.grep) return [`(${opts.pkg} is not running)`];
    }
    args.push('-t', String(Math.max(2000, (opts.lines ?? 50) * 20)));
    if (opts.level) args.push(`*:${opts.level.toUpperCase()}`);
    const r = await this.adb(args, serial, {timeoutMs: 20_000});
    return tailLines(r.stdout.replace(/\r/g, ''), opts.lines ?? 50, opts.grep);
  }

  async settings(
    serial: string,
    s: {fontScale?: number; dark?: boolean; animations?: boolean; size?: string; density?: string; locale?: {pkg: string; locales: string}; grant?: {pkg: string; permission: string}; revoke?: {pkg: string; permission: string}},
  ): Promise<string[]> {
    const done: string[] = [];
    if (s.fontScale !== undefined) {
      await this.shell(serial, `settings put system font_scale ${s.fontScale}`);
      done.push(`font_scale ${s.fontScale}`);
    }
    if (s.dark !== undefined) {
      await this.shell(serial, `cmd uimode night ${s.dark ? 'yes' : 'no'}`);
      done.push(`dark ${s.dark ? 'on' : 'off'}`);
    }
    if (s.animations !== undefined) {
      const v = s.animations ? 1 : 0;
      await this.shell(serial, `settings put global window_animation_scale ${v}; settings put global transition_animation_scale ${v}; settings put global animator_duration_scale ${v}`);
      done.push(`animations ${s.animations ? 'on' : 'off'}`);
    }
    if (s.size) {
      await this.shell(serial, `wm size ${s.size}`);
      done.push(`size ${s.size}`);
    }
    if (s.density) {
      await this.shell(serial, `wm density ${s.density}`);
      done.push(`density ${s.density}`);
    }
    if (s.locale) {
      await this.shell(serial, `cmd locale set-app-locales ${s.locale.pkg} --locales ${s.locale.locales}`);
      done.push(`app locale ${s.locale.locales}`);
    }
    if (s.grant) {
      await this.shell(serial, `pm grant ${s.grant.pkg} ${s.grant.permission}`);
      done.push(`granted ${s.grant.permission}`);
    }
    if (s.revoke) {
      await this.shell(serial, `pm revoke ${s.revoke.pkg} ${s.revoke.permission}`);
      done.push(`revoked ${s.revoke.permission}`);
    }
    // A font scale change reaches a running app only after any window change (an Android quirk); nudge it.
    if (s.fontScale !== undefined && !s.size && !s.density) {
      const cur = (await this.shell(serial, 'wm density')).match(/(Override|Physical) density: (\d+)/g)?.pop()?.split(': ')[1];
      if (cur) await this.shell(serial, `wm density ${cur}`);
    }
    return done;
  }

  async network(serial: string, profile: NetworkProfile): Promise<string> {
    if (profile === 'offline' || profile === 'online') {
      const on = profile === 'online' ? 'disable' : 'enable';
      await this.shell(serial, `cmd connectivity airplane-mode ${on}`);
      if (profile === 'offline') return 'airplane mode on';
      // The network takes a few seconds to come back after airplane mode: a request sent at once still fails.
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        const out = await this.shell(serial, 'dumpsys connectivity').catch(() => '');
        if (/Active default network: \d+/.test(out)) return `airplane mode off · connected in ${((Date.now() - t0) / 1000).toFixed(1)}s`;
        await new Promise(r => setTimeout(r, 500));
      }
      return 'airplane mode off · no network after 20s';
    }
    if (!serial.startsWith('emulator-')) throw new AndroidError('network speed profiles work on emulators only', 'use offline/online on hardware');
    const delay = {full: 'none', lte: 'none', umts: 'umts', edge: 'edge', gsm: 'gsm'}[profile];
    await this.adb(['emu', 'network', 'speed', profile], serial);
    await this.adb(['emu', 'network', 'delay', delay], serial);
    return `network ${profile}`;
  }

  async screenshot(serial: string, file: string): Promise<{file: string; bytes: number}> {
    // A foldable has two screens and screencap takes the first one, lit or not: the screen that is on is asked
    // for by its id.
    const screens = physicalDisplays(await this.shell(serial, 'dumpsys display').catch(() => ''));
    const lit = screens.find(d => d.on);
    const display = screens.length > 1 && lit ? ['-d', lit.id] : [];
    const r = await this.adb(['exec-out', 'screencap', ...display, '-p'], serial, {timeoutMs: 20_000, encoding: 'buffer'});
    if (!r.buffer?.length) throw new AndroidError(`screencap failed: ${r.stderr.trim()}`);
    const png = pngFrom(r.buffer);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, png);
    return {file, bytes: png.length};
  }

  async key(serial: string, keys: string[]): Promise<void> {
    const codes = keys.map(k => {
      const code = KEYS[k.toLowerCase()] ?? Number(k);
      if (!Number.isInteger(code)) throw new AndroidError(`unknown key: ${k}`, `known: ${Object.keys(KEYS).join(', ')} or a keycode number`);
      return code;
    });
    await this.shell(serial, codes.map(c => `input keyevent ${c}`).join('; '));
  }

  async reverse(serial: string, ports: number[]): Promise<number[]> {
    for (const p of ports) await this.adb(['reverse', `tcp:${p}`, `tcp:${p}`], serial, {timeoutMs: 10_000});
    return this.reverseList(serial);
  }

  async reverseList(serial: string): Promise<number[]> {
    const r = await this.adb(['reverse', '--list'], serial, {timeoutMs: 10_000});
    return [...r.stdout.matchAll(/tcp:(\d+)\s+tcp:\d+/g)].map(m => Number(m[1])).sort((a, b) => a - b);
  }

  /**
   * Frames the app rendered since the last reset (count, janky share, frame time percentiles) and its memory.
   * `reset` starts a new window — measure an interaction by resetting before it and reading after.
   */
  async perf(serial: string, pkg: string, reset = false): Promise<PerfReport> {
    if (reset) {
      await this.shell(serial, `dumpsys gfxinfo ${pkg} reset`, 20_000);
      return {reset: true};
    }
    const [gfx, mem] = await Promise.all([this.shell(serial, `dumpsys gfxinfo ${pkg}`, 20_000), this.shell(serial, `dumpsys meminfo ${pkg} | grep -E "TOTAL PSS|TOTAL:"`, 20_000)]);
    const num = (re: RegExp) => {
      const m = re.exec(gfx);
      return m ? Number(m[1]) : undefined;
    };
    const pss = /TOTAL PSS:\s*(\d+)/.exec(mem)?.[1] ?? /TOTAL:\s*(\d+)/.exec(mem)?.[1];
    const frames = num(/Total frames rendered:\s*(\d+)/);
    // With no frames the percentiles are the top bucket of an empty histogram (4950 ms), not a measurement.
    const pct = (re: RegExp) => (frames === 0 ? undefined : num(re));
    return {
      frames,
      janky: num(/Janky frames:\s*\d+\s*\(([\d.]+)%\)/),
      p50: pct(/50th percentile:\s*(\d+)ms/),
      p90: pct(/90th percentile:\s*(\d+)ms/),
      p99: pct(/99th percentile:\s*(\d+)ms/),
      memoryMb: pss ? Math.round(Number(pss) / 1024) : undefined,
    };
  }

  /** Phones advertising wireless debugging on this network (adb's own mDNS discovery). */
  async mdnsServices(): Promise<MdnsService[]> {
    const r = await this.adb(['mdns', 'services'], undefined, {timeoutMs: 10_000});
    return parseMdnsServices(r.stdout);
  }

  async pair(host: string, port: number, code: string): Promise<void> {
    const r = await this.adb(['pair', `${host}:${port}`, code], undefined, {timeoutMs: 30_000});
    const out = `${r.stdout}\n${r.stderr}`.trim();
    if (!paired(out)) throw new AndroidError(`pairing with ${host}:${port} failed: ${out.split('\n').pop()}`, 'the code is valid while the phone shows it; pair again');
  }

  /**
   * Connects to a paired phone: adb may have connected on its own (it watches mDNS); otherwise the phone's
   * connect service on the same address is used. Answers the serial adb lists.
   */
  async connectPaired(host: string, timeoutMs = 30_000): Promise<string> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const online = (await this.devices()).find(d => d.state === 'device' && d.serial.includes(host));
      if (online) return online.serial;
      const svc = (await this.mdnsServices()).find(s => s.type === 'connect' && s.host === host);
      if (svc) {
        const r = await this.adb(['connect', `${svc.host}:${svc.port}`], undefined, {timeoutMs: 20_000});
        if (connected(`${r.stdout}\n${r.stderr}`)) return `${svc.host}:${svc.port}`;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new AndroidError(`paired with ${host}, but it does not offer a connection`, 'keep Wireless debugging on, on the same network, and try pair again');
  }

  /**
   * Starts the platform trace for the app (atrace: graphics, views, input, activities, the runtime, windows,
   * resources). CPU scheduling is left out: it multiplies the trace tenfold for little an app developer reads.
   */
  async traceStart(serial: string, pkg: string): Promise<void> {
    const r = await this.adb(['shell', 'atrace', '--async_start', '-b', '16384', '-a', pkg, 'gfx', 'view', 'input', 'am', 'dalvik', 'wm', 'res'], serial, {timeoutMs: 20_000});
    if (r.code !== 0) throw new AndroidError(`atrace did not start: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  }

  /** Stops the trace and sums it up for the app's process. */
  async traceStop(serial: string, pkg: string): Promise<TraceSummary & {pid?: number}> {
    const r = await this.adb(['exec-out', 'atrace', '--async_stop', '-a', pkg], serial, {timeoutMs: 60_000});
    const pid = Number((await this.shell(serial, `pidof ${pkg}`).catch(() => '')).trim().split(/\s+/)[0]);
    if (!pid) return {ms: 0, threads: [], long: [], longMs: 16};
    // Thread names from the process itself: the trace has `<...>` for some of them.
    const list = await this.shell(serial, `for t in /proc/${pid}/task/*; do echo \${t##*/} $(cat $t/comm); done`).catch(() => '');
    const names = new Map(list.split('\n').flatMap(l => {
      const m = /^(\d+) (.+)$/.exec(l.trim());
      return m ? [[Number(m[1]), m[2]!.trim()] as [number, string]] : [];
    }));
    return {...summarizeAtrace(r.stdout, pid, {names}), pid};
  }

  async info(serial: string): Promise<Record<string, string>> {
    const props = await this.shell(serial, 'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.cpu.abi; wm size; wm density; df -k /data | tail -1');
    const [model = '', release = '', sdk = '', abi = '', ...rest] = props.split('\n');
    const size = rest.find(l => /size:/.test(l))?.split(': ').pop() ?? '';
    const density = rest.filter(l => /density:/.test(l)).pop()?.split(': ').pop() ?? '';
    const df = rest.find(l => /\d+\s+\d+\s+\d+/.test(l))?.trim().split(/\s+/);
    const freeMb = df && df[3] ? String(Math.round(Number(df[3]) / 1024)) : '';
    return {model, android: release, sdk, abi, size, density, freeDataMb: freeMb};
  }
}
