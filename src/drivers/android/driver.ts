// Android driver: phones, foldables, tablets, TV and XR — emulators and hardware, all through adb.
// The agent never calls adb itself; every operation it needs is here.

import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {run, type RunResult} from '../../util/proc.ts';
import {tailLines} from '../../util/text.ts';
import {avdKind, findAdb, findEmulator, listAvds} from './sdk.ts';

export type AndroidDevice = {serial: string; state: string; model?: string; avd?: string; kind?: string; emulator: boolean};

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

  constructor() {
    const adb = findAdb();
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

  /** AVD name per emulator serial: asking the emulator console every time is slow and busies adb. */
  readonly #avdNames = new Map<string, string>();

  async devices(): Promise<AndroidDevice[]> {
    let r = await this.adb(['devices', '-l'], undefined, {timeoutMs: 8000});
    // A busy adb server can hang a call; one retry before reporting no devices.
    if (r.timedOut || r.code !== 0) r = await this.adb(['devices', '-l'], undefined, {timeoutMs: 15_000});
    if (r.timedOut) throw new AndroidError('the adb server is not responding', '`doctor --fix` restarts it (a wedged server makes every device look offline)');
    const lines = r.stdout.replace(/\r/g, '').split('\n').slice(1).filter(l => l.trim());
    const serials = new Set(lines.map(l => l.trim().split(/\s+/)[0]));
    for (const s of [...this.#avdNames.keys()]) if (!serials.has(s)) this.#avdNames.delete(s);
    return Promise.all(
      lines.map(async line => {
        const [serial = '', state = ''] = line.trim().split(/\s+/);
        const model = /model:(\S+)/.exec(line)?.[1];
        const emulator = serial.startsWith('emulator-');
        let avd = this.#avdNames.get(serial);
        if (emulator && state === 'device' && !avd) {
          const name = await this.adb(['emu', 'avd', 'name'], serial, {timeoutMs: 5000});
          avd = name.stdout.replace(/\r/g, '').split('\n')[0]?.trim() || undefined;
          if (avd) this.#avdNames.set(serial, avd);
        }
        return {serial, state, model, avd, kind: avd ? avdKind(avd) : undefined, emulator};
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

  async boot(avd: string, opts: {wipe?: boolean; headless?: boolean; coldBoot?: boolean; timeoutMs?: number} = {}): Promise<{serial: string; ms: number; already: boolean}> {
    const t0 = Date.now();
    const running = (await this.devices()).find(d => d.avd === avd && d.state === 'device');
    if (running) return {serial: running.serial, ms: 0, already: true};
    if (!listAvds().includes(avd)) throw new AndroidError(`unknown AVD "${avd}"`, `available: ${listAvds().join(', ') || 'none'}`);
    const emulator = findEmulator();
    if (!emulator) throw new AndroidError('emulator binary not found', 'install the Android Emulator SDK package');
    const args = ['-avd', avd, '-no-boot-anim', '-no-audio'];
    if (opts.coldBoot !== false) args.push('-no-snapshot-load');
    if (opts.wipe) args.push('-wipe-data');
    if (opts.headless) args.push('-no-window');
    const child = spawn(emulator, args, {detached: true, stdio: 'ignore', windowsHide: true});
    child.unref();
    const deadline = t0 + (opts.timeoutMs ?? 240_000);
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const dev = (await this.devices()).find(d => d.avd === avd && d.state === 'device');
      if (!dev) continue;
      const booted = await this.adb(['shell', 'getprop', 'sys.boot_completed'], dev.serial, {timeoutMs: 5000});
      if (booted.stdout.trim() === '1') return {serial: dev.serial, ms: Date.now() - t0, already: false};
    }
    throw new AndroidError(`${avd} did not finish booting in ${Math.round((opts.timeoutMs ?? 240_000) / 1000)}s`, 'try `boot --wipe` if it hangs on the boot screen');
  }

  /** Shuts an emulator down and waits until adb no longer lists it (it takes ~20 s to save and exit). */
  async shutdown(serial: string, timeoutMs = 60_000): Promise<{ms: number; gone: boolean}> {
    const t0 = Date.now();
    await this.adb(['emu', 'kill'], serial, {timeoutMs: 10_000});
    while (Date.now() - t0 < timeoutMs) {
      if (!(await this.devices()).some(d => d.serial === serial)) return {ms: Date.now() - t0, gone: true};
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

  async launcherActivity(serial: string, pkg: string): Promise<string> {
    const out = await this.shell(serial, `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`);
    let line = out.trim().split('\n').pop()?.trim();
    if (!line || !line.includes('/')) {
      // TV apps declare LEANBACK_LAUNCHER instead.
      const tv = await this.shell(serial, `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER ${pkg}`);
      line = tv.trim().split('\n').pop()?.trim();
    }
    if (!line || !line.includes('/')) throw new AndroidError(`no launcher activity for ${pkg}`, 'is the app installed? `apps` lists packages');
    return line;
  }

  /** Opens an app by package or a deep link URL. Returns the launch time the activity manager reports. */
  async open(serial: string, target: string, opts: {relaunch?: boolean; pkg?: string} = {}): Promise<{totalMs?: number; component?: string}> {
    const isUrl = target.includes('://');
    const pkg = isUrl ? opts.pkg : target;
    if (opts.relaunch && pkg) await this.shell(serial, `am force-stop ${pkg}`);
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
      const pid = (await this.shell(serial, `pidof ${opts.pkg}`)).trim().split(/\s+/)[0];
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
      return `airplane mode ${profile === 'offline' ? 'on' : 'off'}`;
    }
    if (!serial.startsWith('emulator-')) throw new AndroidError('network speed profiles work on emulators only', 'use offline/online on hardware');
    const delay = {full: 'none', lte: 'none', umts: 'umts', edge: 'edge', gsm: 'gsm'}[profile];
    await this.adb(['emu', 'network', 'speed', profile], serial);
    await this.adb(['emu', 'network', 'delay', delay], serial);
    return `network ${profile}`;
  }

  async screenshot(serial: string, file: string): Promise<{file: string; bytes: number}> {
    const r = await this.adb(['exec-out', 'screencap', '-p'], serial, {timeoutMs: 20_000, encoding: 'buffer'});
    if (!r.buffer?.length) throw new AndroidError(`screencap failed: ${r.stderr.trim()}`);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, r.buffer);
    return {file, bytes: r.buffer.length};
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
    return {
      frames: num(/Total frames rendered:\s*(\d+)/),
      janky: num(/Janky frames:\s*\d+\s*\(([\d.]+)%\)/),
      p50: num(/50th percentile:\s*(\d+)ms/),
      p90: num(/90th percentile:\s*(\d+)ms/),
      p99: num(/99th percentile:\s*(\d+)ms/),
      memoryMb: pss ? Math.round(Number(pss) / 1024) : undefined,
    };
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
