// Built-in doctor rules.

import fs from 'node:fs';
import path from 'node:path';
import {run, which} from '../util/proc.ts';
import {tcpOpen} from '../util/net.ts';
import {probePort} from '../stand/health.ts';
import {IDLE_MS, UNVERSIONED} from '../daemon/activity.ts';
import type {DoctorContext, Finding, Rule} from './types.ts';
import {allowCleartextInDebug, cleartextOf, detectProject} from '../init/project.ts';

/** Who listens on a TCP port: `pid name`, best effort. */
export const portOwner = async (port: number): Promise<string | undefined> => {
  if (process.platform === 'win32') {
    const r = await run('netstat', ['-ano', '-p', 'tcp'], {timeoutMs: 10_000});
    const line = r.stdout.split(/\r?\n/).find(l => new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`).test(l));
    const pid = line?.trim().split(/\s+/).pop();
    if (!pid) return undefined;
    const t = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {timeoutMs: 10_000});
    const name = t.stdout.split(',')[0]?.replace(/"/g, '').trim();
    return `pid ${pid}${name ? ` ${name}` : ''}`;
  }
  const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {timeoutMs: 10_000});
  const line = r.stdout.split('\n')[1];
  if (!line) return undefined;
  const [name, pid] = line.split(/\s+/);
  return `pid ${pid} ${name}`;
};

/**
 * The online devices doctor looks at: not one another session holds, which has its own stand, forwards and
 * settings — a fix here would reset its display, move its forwards or dismiss its dialogs.
 */
const ownDevices = async (ctx: DoctorContext) =>
  (await ctx.android!.devices()).filter(x => x.state === 'device' && !ctx.othersHold?.(x.serial, x.instance));

const adbAvailable: Rule = {
  id: 'adb',
  title: 'adb is installed',
  check: async ctx => (ctx.android ? [] : [{rule: 'adb', severity: 'warn', message: 'adb not found', hint: 'install Android SDK platform-tools or set ANDROID_HOME'}]),
};

/** Restarts adb from scratch: a wedged server ignores `kill-server`, so every adb process goes. */
export const restartAdb = async (adbPath: string): Promise<string> => {
  if (process.platform === 'win32') await run('taskkill', ['/F', '/IM', 'adb.exe'], {timeoutMs: 15_000});
  else await run('pkill', ['-9', '-x', 'adb'], {timeoutMs: 15_000});
  await new Promise(r => setTimeout(r, 800));
  const r = await run(adbPath, ['start-server'], {timeoutMs: 20_000});
  return r.code === 0 ? 'adb restarted' : `adb start-server exited ${r.code}: ${r.stderr.trim()}`;
};

const adbServer: Rule = {
  id: 'adb-server',
  title: 'the adb server answers',
  check: async ctx => {
    if (!ctx.android) return [];
    // Two tries: other rules run adb at the same moment, and one slow answer under load is not a wedged server.
    let r = await run(ctx.android.adbPath, ['devices'], {timeoutMs: 8000});
    if (r.timedOut) r = await run(ctx.android.adbPath, ['devices'], {timeoutMs: 8000});
    if (!r.timedOut) return [];
    return [
      {
        rule: 'adb-server',
        severity: 'error',
        message: 'the adb server did not answer twice in 8 s — every device looks offline and every call hangs',
        hint: 'a wedged server ignores kill-server; all adb processes must go',
        fix: () => restartAdb(ctx.android!.adbPath),
      },
    ];
  },
};

/** Two adb builds on one machine (an SDK one and one on PATH) take turns killing and starting the shared server. */
const adbBinaries: Rule = {
  id: 'adb-binaries',
  title: 'one adb on this machine',
  check: async ctx => {
    if (!ctx.android) return [];
    const onPath = which('adb');
    if (!onPath || path.resolve(onPath).toLowerCase() === path.resolve(ctx.android.adbPath).toLowerCase()) return [];
    const [a, b] = await Promise.all([run(ctx.android.adbPath, ['version'], {timeoutMs: 5000}), run(onPath, ['version'], {timeoutMs: 5000})]);
    const v = (s: string) => /Version (\S+)/.exec(s)?.[1] ?? '?';
    if (v(a.stdout) === v(b.stdout)) return [];
    return [
      {
        rule: 'adb-binaries',
        severity: 'warn',
        message: `two adb builds: ${ctx.android.adbPath} (${v(a.stdout)}) and ${onPath} on PATH (${v(b.stdout)})`,
        hint: 'tools using different builds share one server and can restart it under each other; keep one (put the SDK platform-tools first on PATH)',
      },
    ];
  },
};

const androidDevice: Rule = {
  id: 'android-device',
  title: 'an Android device is online',
  check: async ctx => {
    if (!ctx.android || !ctx.config.app?.android) return [];
    const devices = await ctx.android.devices();
    const offline = devices.filter(d => d.state !== 'device');
    const findings: Finding[] = offline.map(d => ({
      rule: 'android-device',
      severity: 'warn',
      message: `${d.serial} is ${d.state}`,
      hint: d.state === 'unauthorized' ? 'accept the USB debugging prompt on the device' : 'reconnect it, or restart adb',
      fix: async () => {
        await ctx.android!.adb(['reconnect', 'offline']);
        return 'adb reconnect offline';
      },
    }));
    if (!devices.some(d => d.state === 'device')) {
      findings.push({rule: 'android-device', severity: 'info', message: 'no Android device online', hint: ctx.config.android?.avd ? `boot ${ctx.config.android.avd}` : 'boot an emulator or connect a device'});
    }
    return findings;
  },
};

const reversePorts: Rule = {
  id: 'reverse-ports',
  title: 'exposed ports are forwarded to every Android device',
  check: async ctx => {
    if (!ctx.android || !ctx.exposedPorts.length) return [];
    const findings: Finding[] = [];
    const relayed = new Set((await ctx.forwardHealth?.())?.filter(h => h.via === 'relay').map(h => h.serial));
    for (const d of await ownDevices(ctx)) {
      // Devices on the runner relay have no adb forwards on purpose.
      if (relayed.has(d.serial)) continue;
      const have = await ctx.android.reverseList(d.serial);
      const missing = ctx.exposedPorts.filter(p => !have.includes(p));
      if (missing.length) {
        findings.push({
          rule: 'reverse-ports',
          severity: 'error',
          message: `${d.avd ?? d.serial}: ports not forwarded: ${missing.join(', ')}`,
          hint: 'the app cannot reach the stand on these ports; `adb reverse` silently drops forwards on reconnect',
          fix: async () => {
            const now = await ctx.android!.reverse(d.serial, missing);
            return `forwarded ${missing.join(', ')} → now ${now.join(', ')}`;
          },
        });
      }
    }
    return findings;
  },
};

const forwardData: Rule = {
  id: 'forward-data',
  title: 'forwarded ports really carry data',
  check: async ctx => {
    if (!ctx.forwardHealth || !ctx.exposedPorts.length) return [];
    const findings: Finding[] = [];
    for (const h of await ctx.forwardHealth()) {
      if (h.carries) continue;
      const emulator = h.serial.startsWith('emulator-');
      findings.push({
        rule: 'forward-data',
        severity: 'error',
        message: `${h.serial}: forwards (${h.via}) are in place but carry no data — the app sees every stand service as down`,
        hint: emulator ? 'adb reverse sometimes stops passing data while still listing its forwards; the runner relay goes through the emulator host alias instead' : 'reconnect the device or restart adb (doctor fix=true with the adb-server rule)',
        fix: emulator && ctx.useRelay ? () => ctx.useRelay!(h.serial) : undefined,
      });
    }
    return findings;
  },
};

const systemDialog: Rule = {
  id: 'system-dialog',
  title: 'no system dialog covers the screen',
  check: async ctx => {
    if (!ctx.systemDialogs) return [];
    return (await ctx.systemDialogs()).map(d => ({
      rule: 'system-dialog',
      severity: 'error' as const,
      message: `${d.serial}: "${d.title}" covers the screen — every wait and tap goes to the dialog`,
      hint: 'emulators show it after a slow boot or under load; Wait keeps the process, Close app restarts it',
      fix: ctx.dismissDialog ? () => ctx.dismissDialog!(d.serial) : undefined,
    }));
  },
};

/** CI mode makes Metro (and Expo) skip file watching: edits never reach the app, and it looks like a broken fix. */
const ciDevServer: Rule = {
  id: 'devserver-ci',
  title: 'the dev server watches files',
  check: async ctx => {
    const env = {...process.env, ...ctx.config.devserver?.env};
    if (!ctx.config.devserver || !env.CI || /^(0|false)$/i.test(env.CI)) return [];
    return [{rule: 'devserver-ci', severity: 'warn', message: `CI=${env.CI} reaches the dev server: Metro does not watch files in CI mode, edits never arrive`, hint: 'unset CI for the dev server (devserver.env: {CI: "false"} or start the daemon without it)'}];
  },
};

/** A run that stopped half-way (a matrix, a font-size check) leaves the device enlarged or resized for the next. */
const leftoverDisplay: Rule = {
  id: 'device-display',
  title: 'device display settings are at their defaults',
  check: async ctx => {
    if (!ctx.android) return [];
    const findings: Finding[] = [];
    for (const d of await ownDevices(ctx)) {
      const out = await ctx.android.shell(d.serial, 'settings get system font_scale; wm size; wm density').catch(() => '');
      const scale = Number(out.split('\n')[0]);
      const sizeOverride = /Override size:/.test(out);
      const densityOverride = /Override density:/.test(out);
      if ((Number.isFinite(scale) && scale !== 1) || sizeOverride || densityOverride) {
        findings.push({
          rule: 'device-display',
          severity: 'warn',
          message: `${d.avd ?? d.serial}: ${[scale !== 1 && Number.isFinite(scale) ? `font scale ${scale}` : '', sizeOverride ? 'display size overridden' : '', densityOverride ? 'density overridden' : ''].filter(Boolean).join(', ')}`,
          hint: 'probably left by an interrupted run; every screen and selector looks different until reset',
          fix: async () => {
            await ctx.android!.shell(d.serial, 'settings put system font_scale 1; wm size reset; wm density reset');
            return `${d.avd ?? d.serial}: font scale 1, display size and density reset`;
          },
        });
      }
    }
    return findings;
  },
};

/** A release build on the device never asks the dev server for anything. */
const releaseBuild: Rule = {
  id: 'app-debuggable',
  title: 'the installed app is a debug build when a dev server is configured',
  check: async ctx => {
    const pkg = ctx.config.app?.android;
    if (!ctx.android || !pkg || !ctx.config.devserver) return [];
    const findings: Finding[] = [];
    for (const d of await ownDevices(ctx)) {
      const out = await ctx.android.shell(d.serial, `dumpsys package ${pkg} | grep -m1 "pkgFlags"`).catch(() => '');
      if (out && !/DEBUGGABLE/.test(out)) {
        findings.push({rule: 'app-debuggable', severity: 'warn', message: `${d.avd ?? d.serial}: ${pkg} is a release build — it runs its embedded bundle and never talks to the dev server`, hint: 'install a debug build to iterate (fresh will say no app is connected)'});
      }
    }
    return findings;
  },
};

/** Animations make waits slower and flakier; turning them off is the usual setting for automated runs. */
const animations: Rule = {
  id: 'device-animations',
  title: 'animations are off for automated runs',
  check: async ctx => {
    if (!ctx.android) return [];
    const findings: Finding[] = [];
    for (const d of await ownDevices(ctx)) {
      const v = (await ctx.android.shell(d.serial, 'settings get global animator_duration_scale').catch(() => '')).trim();
      if (v && v !== '0' && v !== '0.0') {
        const shown = v === 'null' ? 'default (1)' : v;
        findings.push({
          rule: 'device-animations',
          severity: 'info',
          message: `${d.avd ?? d.serial}: animations on (${shown})`,
          hint: 'off makes settling faster and steadier; leave them on when the check is about an animation',
          fix: async () => (await ctx.android!.settings(d.serial, {animations: false})).join(', '),
        });
      }
    }
    return findings;
  },
};

const servicesHealthy: Rule = {
  id: 'services',
  title: 'stand services answer their probes',
  check: async ctx => {
    const findings: Finding[] = [];
    for (const s of await ctx.services.status()) {
      if (s.status === 'up' || s.status === 'external') continue;
      // The stand's own definition: the dev server is not in `config.services`, but it has a start command.
      const svc = ctx.services.definition(s.name);
      if (svc?.autostart === false && s.status === 'stopped') continue;
      const port = probePort(svc?.health);
      let owner: string | undefined;
      if (port && !(await tcpOpen(port))) owner = undefined;
      else if (port) owner = await portOwner(port);
      findings.push({
        rule: 'services',
        severity: 'error',
        message: `${s.name} is ${s.status}${s.detail ? ` (${s.detail.split('\n')[0]})` : ''}${owner ? `; port ${port} held by ${owner}` : ''}`,
        hint: owner ? 'something else holds the port — find out what it is before killing it' : svc?.start ? `start it: pitbox up ${s.name}` : 'start it outside pitbox, it has no start command',
        // `up` through the engine: the dev server also needs its proxy, which the service manager does not start.
        fix: svc?.start && !owner && ctx.config.services?.[s.name] ? async () => {
          const [r] = await ctx.services.up([s.name]);
          return `${s.name}: ${r?.status}`;
        } : undefined,
      });
    }
    return findings;
  },
};

const dataPartition: Rule = {
  id: 'android-storage',
  title: 'Android devices have room to install',
  check: async ctx => {
    if (!ctx.android) return [];
    const findings: Finding[] = [];
    for (const d of await ownDevices(ctx)) {
      const info = await ctx.android.info(d.serial).catch(() => undefined);
      const free = Number(info?.freeDataMb);
      if (Number.isFinite(free) && free > 0 && free < 600) {
        findings.push({rule: 'android-storage', severity: 'warn', message: `${d.avd ?? d.serial}: only ${free} MB free on /data`, hint: 'large debug APKs fail with INSUFFICIENT_STORAGE; uninstall apps or wipe the emulator'});
      }
    }
    return findings;
  },
};

/**
 * Metro's file map enables its native recursive watcher only on macOS; elsewhere it walks the whole tree and
 * opens one watch handle per directory. On Windows that costs tens of seconds per start for a typical app.
 */
export const metroWindowsWatcher: Rule = {
  id: 'metro-watcher',
  title: 'Metro uses a native file watcher',
  check: async ctx => {
    if (process.platform !== 'win32') return [];
    // pitbox's own dev server enables the native watcher at runtime.
    if (ctx.config.devserver && (ctx.config.devserver.adapter ?? 'metro') === 'metro') return [];
    const roots = new Set<string>([ctx.root, ...Object.values(ctx.config.services ?? {}).map(s => (s.cwd ? path.resolve(ctx.root, s.cwd) : ctx.root))]);
    const findings: Finding[] = [];
    // Expo's fork is the file map an Expo project's Metro loads; the plain package is checked only without it.
    const candidates = ['node_modules/@expo/metro-file-map/build/watchers/NativeWatcher.js', 'node_modules/metro-file-map/src/watchers/NativeWatcher.js'];
    for (const r of roots) {
      const file = candidates.map(c => path.join(r, c)).find(f => fs.existsSync(f));
      if (!file) continue;
      if (/platform\)\(\)\s*===\s*['"]darwin['"]/.test(fs.readFileSync(file, 'utf8'))) {
        findings.push({
          rule: 'metro-watcher',
          severity: 'warn',
          message: `${file}: native watcher is macOS-only, Metro will crawl every directory on start`,
          hint: "patch isSupported() to allow 'win32' (a yarn/patch-package patch survives installs); measured ~39s → ~4s per start",
        });
      }
    }
    return findings;
  },
};

/** A device with a screen lock runs no app after a boot until someone unlocks it. */
const deviceLocked: Rule = {
  id: 'device-locked',
  title: 'no device waits for its screen lock to be entered',
  check: async ctx => {
    if (!ctx.android) return [];
    const findings: Finding[] = [];
    for (const d of await ownDevices(ctx)) {
      if (await ctx.android.userLocked(d.serial)) {
        findings.push({rule: 'device-locked', severity: 'error', message: `${d.avd ?? d.serial}: locked after boot — no app can start until the screen lock is entered`, hint: 'unlock it once, or remove the screen lock in Settings → Security (an AVD for tests is better without one)'});
      }
    }
    return findings;
  },
};

/** Android blocks plain HTTP since API 28: a debug build that may not use it never reaches the stand. */
const cleartext: Rule = {
  id: 'android-cleartext',
  title: 'the Android debug build may use plain HTTP to reach the dev server and the stand',
  check: async ctx => {
    const p = detectProject(ctx.config.devserver?.root ? path.resolve(ctx.root, ctx.config.devserver.root) : ctx.root);
    if (!p?.appModule) return [];
    const c = cleartextOf(p.appModule);
    if (c.status === 'blocked') {
      return [{rule: 'android-cleartext', severity: 'error', message: `debug builds cannot use plain HTTP: ${c.reason}`, hint: 'allow it in the debug manifest, then rebuild', fix: async () => allowCleartextInDebug(p.appModule!)}];
    }
    if (c.status === 'config') return [{rule: 'android-cleartext', severity: 'info', message: c.reason}];
    return [];
  },
};

/**
 * Driving a Mac app needs two permissions of the app that started pitbox (a terminal, an editor): without
 * Accessibility no tree and no input, without Screen Recording no image of a window. Missing, each call would fail;
 * here it is named once with where to turn it on.
 */
export const macPermissions: Rule = {
  id: 'mac-permissions',
  title: 'the app that started pitbox may read and drive Mac apps',
  check: async ctx => {
    if (!ctx.macPermissions) return [];
    const p = await ctx.macPermissions();
    const findings: Finding[] = [];
    if (!p.accessibility) {
      findings.push({rule: 'mac-permissions', severity: 'error', message: `Accessibility is off for ${p.host}: pitbox cannot read or drive Mac apps`, hint: `System Settings › Privacy & Security › Accessibility → turn on ${p.host} (add it with + if it is not listed), then run again`});
    }
    if (!p.screen) {
      findings.push({rule: 'mac-permissions', severity: 'warn', message: `Screen Recording is off for ${p.host}: no screenshots or visual checks of Mac apps`, hint: `System Settings › Privacy & Security › Screen & System Audio Recording → turn on ${p.host}, then quit and reopen ${p.host}`});
    }
    return findings;
  },
};

/**
 * Two sessions on one project with different pitbox versions share one daemon: the daemon of one version serves
 * the other's calls, so what the newer one adds is missing or behaves as the older one did, without an error.
 */
export const daemonVersions: Rule = {
  id: 'daemon-versions',
  title: 'every client of the daemon runs its version of pitbox',
  check: async ctx => {
    if (!ctx.daemonClients) return [];
    const {version, strangers} = ctx.daemonClients();
    if (!strangers.length) return [];
    const who = strangers.map(c => (c.version === UNVERSIONED ? 'an older pitbox' : c.version)).join(', ');
    return [
      {
        rule: 'daemon-versions',
        severity: 'warn',
        message: `the daemon runs pitbox ${version}, and clients of other versions (${who}) used it in the last ${IDLE_MS / 60_000} min: their calls get this version's behaviour`,
        hint: 'run one pitbox version per project (the same package version for every agent and script), then `pitbox daemon restart` once nobody is mid-run',
      },
    ];
  },
};

/** Touch input goes through Chromium's input protocol: a web app with touch in another browser gets the mouse. */
export const webTouch: Rule = {
  id: 'web-touch',
  title: 'web apps with touch run in Chromium',
  check: async ctx =>
    Object.entries(ctx.config.web ?? {})
      .filter(([, w]) => w.browser && w.browser !== 'chromium' && (w.touch === true || (w.device !== undefined && w.touch !== false)))
      .map(([name, w]) => ({
        rule: 'web-touch',
        severity: 'warn' as const,
        message: `web:${name} asks for touch${w.touch ? '' : ` (device ${w.device})`} in ${w.browser}: press, swipe and touch stay the mouse's there`,
        hint: `browser: 'chromium' (default) for touch input, or touch: false to say the mouse is meant`,
      })),
};

export const builtinRules: Rule[] = [adbAvailable, adbServer, adbBinaries, androidDevice, reversePorts, forwardData, systemDialog, ciDevServer, leftoverDisplay, releaseBuild, deviceLocked, cleartext, animations, servicesHealthy, dataPartition, metroWindowsWatcher, macPermissions, daemonVersions, webTouch];
