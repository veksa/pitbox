// Built-in doctor rules.

import fs from 'node:fs';
import path from 'node:path';
import {run, which} from '../util/proc.ts';
import {tcpOpen} from '../util/net.ts';
import {probePort} from '../stand/health.ts';
import type {Finding, Rule} from './types.ts';

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
    const r = await run(ctx.android.adbPath, ['devices'], {timeoutMs: 6000});
    if (!r.timedOut) return [];
    return [
      {
        rule: 'adb-server',
        severity: 'error',
        message: 'the adb server does not answer within 6 s — every device looks offline and every call hangs',
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
    for (const d of (await ctx.android.devices()).filter(x => x.state === 'device')) {
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

const servicesHealthy: Rule = {
  id: 'services',
  title: 'stand services answer their probes',
  check: async ctx => {
    const findings: Finding[] = [];
    for (const s of await ctx.services.status()) {
      if (s.status === 'up' || s.status === 'external') continue;
      const svc = ctx.config.services?.[s.name];
      if (svc?.autostart === false && s.status === 'stopped') continue;
      const port = probePort(svc?.health);
      let owner: string | undefined;
      if (port && !(await tcpOpen(port))) owner = undefined;
      else if (port) owner = await portOwner(port);
      findings.push({
        rule: 'services',
        severity: 'error',
        message: `${s.name} is ${s.status}${s.detail ? ` (${s.detail.split('\n')[0]})` : ''}${owner ? `; port ${port} held by ${owner}` : ''}`,
        hint: owner ? 'something else holds the port — find out what it is before killing it' : svc?.start ? 'start it' : 'start it outside pitbox, it has no start command',
        fix: svc?.start && !owner ? async () => {
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
    for (const d of (await ctx.android.devices()).filter(x => x.state === 'device')) {
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

export const builtinRules: Rule[] = [adbAvailable, adbServer, adbBinaries, androidDevice, reversePorts, servicesHealthy, dataPartition, metroWindowsWatcher];
