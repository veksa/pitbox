// A device server on a Mac: the Apple driver, the XCUITest runner and crash reports behind token-protected HTTP,
// for a pitbox on another machine (a Windows host over a VPN overlay). It needs no project and no config: the
// project, its flows and its baselines stay on the machine that drives; only device operations come here.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {AppleDriver} from '../drivers/apple/driver.ts';
import {AppleRunner} from '../drivers/apple/runner.ts';
import {AppleCrashWatcher} from '../drivers/apple/crashes.ts';
import {run} from '../util/proc.ts';

export const DEVICE_HOST_VERSION = 1;

type P = Record<string, unknown>;
const s = (p: P, k: string) => (p[k] === undefined || p[k] === null ? undefined : String(p[k]));
const need = (p: P, k: string) => {
  const v = s(p, k);
  if (!v) throw new Error(`missing parameter: ${k}`);
  return v;
};

export const createDeviceHost = (token: string) => {
  const driver = new AppleDriver();
  const runners = new Map<string, AppleRunner>();
  const crashes = new Map<string, AppleCrashWatcher>();
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-uploads-'));

  const runner = (udid: string, bundleId?: string) => {
    let r = runners.get(udid);
    if (!r) {
      r = new AppleRunner(driver, udid, bundleId);
      runners.set(udid, r);
    }
    r.bundleId = bundleId;
    return r;
  };
  const watcher = (udid: string, bundleId?: string) => {
    const key = `${udid}|${bundleId ?? ''}`;
    let w = crashes.get(key);
    if (!w) {
      w = new AppleCrashWatcher(driver, udid, bundleId);
      crashes.set(key, w);
    }
    return w;
  };

  const methods: Record<string, (p: P) => Promise<unknown>> = {
    hello: async () => ({version: DEVICE_HOST_VERSION, host: os.hostname(), now: Date.now()}),
    simulators: async () => driver.simulators(),
    booted: async () => driver.booted(),
    resolve: async p => driver.resolve(s(p, 'selector')),
    boot: async p => driver.boot(need(p, 'selector'), (p.opts as {headless?: boolean; wipe?: boolean}) ?? {}),
    shutdown: async p => {
      const udid = need(p, 'udid');
      await runners.get(udid)?.stop();
      runners.delete(udid);
      return driver.shutdown(udid);
    },
    install: async p => {
      const dir = path.join(uploads, need(p, 'upload').replace(/[^\w-]/g, ''));
      const app = fs.readdirSync(dir).find(f => f.endsWith('.app'));
      if (!app) throw new Error('the upload holds no .app');
      try {
        return await driver.install(need(p, 'udid'), path.join(dir, app));
      } finally {
        fs.rmSync(dir, {recursive: true, force: true});
      }
    },
    open: async p => driver.open(need(p, 'udid'), need(p, 'target'), (p.opts as {relaunch?: boolean; bundleId?: string; args?: string[]}) ?? {}),
    stop: async p => driver.stop(need(p, 'udid'), need(p, 'bundleId')),
    clear: async p => driver.clear(need(p, 'udid'), need(p, 'bundleId')),
    uninstall: async p => driver.uninstall(need(p, 'udid'), need(p, 'bundleId')),
    packages: async p => driver.packages(need(p, 'udid'), s(p, 'filter')),
    logs: async p => driver.logs(need(p, 'udid'), (p.opts as Parameters<AppleDriver['logs']>[1]) ?? {}),
    settings: async p => driver.settings(need(p, 'udid'), (p.settings as Parameters<AppleDriver['settings']>[1]) ?? {}),
    screenshot: async p => {
      const file = path.join(uploads, `${crypto.randomBytes(6).toString('hex')}.png`);
      try {
        await driver.screenshot(need(p, 'udid'), file);
        return {png: fs.readFileSync(file).toString('base64')};
      } finally {
        fs.rmSync(file, {force: true});
      }
    },
    info: async p => driver.info(need(p, 'udid')),
    perf: async p => driver.perf(need(p, 'udid'), need(p, 'bundleId'), p.reset === true),
    setDefaults: async p => driver.setDefaults(need(p, 'udid'), need(p, 'bundleId'), (p.values as Record<string, string>) ?? {}),
    runner: async p => runner(need(p, 'udid'), s(p, 'bundleId')).call(need(p, 'cmd'), (p.args as P) ?? {}, Number(p.timeoutMs ?? 15_000)),
    runnerStop: async p => {
      const udid = need(p, 'udid');
      await runners.get(udid)?.stop();
      runners.delete(udid);
      return {};
    },
    crashBegin: async p => {
      watcher(need(p, 'udid'), s(p, 'bundleId')).begin(p.front as string[] | undefined);
      return {};
    },
    // `ageMs` instead of a timestamp: the two machines' clocks need not agree.
    crashes: async p => ({events: await watcher(need(p, 'udid'), s(p, 'bundleId')).since(Date.now() - Number(p.ageMs ?? 0)), now: Date.now()}),
  };

  const server = http.createServer(async (req, res) => {
    const reply = (body: unknown) => res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(body));
    if (req.headers['x-pitbox-token'] !== token) {
      res.writeHead(403).end();
      return;
    }
    try {
      const url = new URL(req.url ?? '/', 'http://host');
      if (url.pathname === '/upload') {
        // A tar of the .app; extracted next to the other uploads until `install` takes it.
        const id = crypto.randomBytes(8).toString('hex');
        const dir = path.join(uploads, id);
        fs.mkdirSync(dir);
        const tarFile = path.join(uploads, `${id}.tar`);
        await new Promise<void>((resolve, reject) => req.pipe(fs.createWriteStream(tarFile)).on('finish', resolve).on('error', reject));
        const r = await run('tar', ['-xf', tarFile, '-C', dir], {timeoutMs: 300_000});
        fs.rmSync(tarFile, {force: true});
        if (r.code !== 0) throw new Error(`could not unpack the upload: ${r.stderr.trim()}`);
        reply({ok: true, result: {upload: id}});
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {method: string; params?: P};
      const fn = methods[body.method];
      if (!fn) throw new Error(`unknown device host method: ${body.method}`);
      reply({ok: true, result: (await fn(body.params ?? {})) ?? null});
    } catch (e) {
      reply({ok: false, error: (e as Error).message});
    }
  });

  const close = async () => {
    for (const r of runners.values()) await r.stop().catch(() => undefined);
    server.close();
    fs.rmSync(uploads, {recursive: true, force: true});
  };
  return {server, close};
};

/** `pitbox serve-devices`: listens until stopped; the token comes from PITBOX_TOKEN or is made up and printed. */
export const serveDevices = async (listen: string) => {
  const [host, portText] = listen.includes(':') ? [listen.slice(0, listen.lastIndexOf(':')), listen.slice(listen.lastIndexOf(':') + 1)] : ['127.0.0.1', listen];
  const port = Number(portText) || 7700;
  const token = process.env.PITBOX_TOKEN || crypto.randomBytes(18).toString('hex');
  const {server, close} = createDeviceHost(token);
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, host || '127.0.0.1', () => resolve()));
  process.stdout.write(`pitbox device host on ${host}:${port}\nin the driving project's config: apple: {remote: 'http://<this mac>:${port}'}, and PITBOX_REMOTE_TOKEN=${token}\n`);
  const stop = () => void close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
};
