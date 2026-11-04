// The dev server as pitbox runs it: the project's bundler on an internal port (a supervised service, so it
// survives daemon restarts), pitbox's proxy on the device-facing port, a native file watcher inside the
// bundler, and prewarming so the main bundle — and its bytecode — is ready before the device asks.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {DevserverConfig, ServiceConfig} from '../config/schema.ts';
import {lanAddress} from '../util/lan.ts';
import {runShell} from '../util/proc.ts';
import {BytecodeCache, findHermesc, hermesCompiler} from './hermes.ts';
import {JsDebugger} from './jsdebug.ts';
import {DevProxy, eagerUrl, isNativeBundleRequest} from './proxy.ts';

export const DEVSERVER = 'devserver';

const IGNORED = /(^|[\\/])(node_modules|\.git|\.pitbox|\.expo|\.gradle|build|Pods|DerivedData|\.cxx)([\\/]|$)/;

export type Freshness = {
  generation: number;
  apps: {
    id: number;
    platform: string;
    bundle: string;
    latest?: string;
    fresh: boolean;
    note?: string;
    runningForS?: number;
    /** Edits that reached the app as hot updates since it loaded its bundle. */
    hot?: {updates: number; lastS: number; modules: number};
    /** The bundler could not compile the last edit; the app still runs the code before it. */
    compileError?: string;
  }[];
};

export type EmbedResult = {
  bundles: {platform: string; file?: string; kb?: number; kind?: 'bytecode' | 'source'; ms: number; error?: string}[];
  build?: {command: string; code: number | null; ms: number; tail: string[]};
};

export type DevserverStatus = {
  port: number;
  internalPort: number;
  proxy: boolean;
  bytecode: 'off' | 'on' | 'unavailable';
  hermesc?: string;
  generation: number;
  compiles: number;
  cacheHits: number;
  lastCompileMs?: number;
  lastSourceKB?: number;
  lastBytecodeKB?: number;
  lastError?: string;
  prewarm?: {platform: string; ms: number; ok: boolean; note?: string}[];
  requests: {url: string; kind: string; ms: number; kb: number; status: number; note?: string; ago: string}[];
};

const preloadPath = () => {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), `preload${path.extname(here)}`);
};

export class DevServer {
  readonly cfg: DevserverConfig;
  readonly root: string;
  readonly port: number;
  readonly internalPort: number;
  readonly proxy: DevProxy;
  readonly js: JsDebugger;
  readonly hermesc?: string;
  #watcher?: fs.FSWatcher;
  #debounce?: NodeJS.Timeout;
  #lastPrewarm?: DevserverStatus['prewarm'];
  readonly #stateFile: string;
  readonly #stateDir: string;

  constructor(cfg: DevserverConfig, configRoot: string, stateDir: string) {
    this.cfg = cfg;
    this.root = cfg.root ? path.resolve(configRoot, cfg.root) : configRoot;
    this.port = cfg.port ?? 8081;
    this.internalPort = cfg.internalPort ?? this.port + 1;
    this.hermesc = cfg.bytecode ? findHermesc(this.root) : undefined;
    this.#stateFile = path.join(stateDir, 'devserver.json');
    this.#stateDir = stateDir;
    this.proxy = new DevProxy({
      port: this.port,
      host: cfg.host === 'lan' ? '0.0.0.0' : cfg.host,
      upstreamPort: this.internalPort,
      bytecode: this.hermesc ? {compile: hermesCompiler(this.hermesc, path.join(stateDir, 'bytecode', 'work')), cache: new BytecodeCache(path.join(stateDir, 'bytecode'))} : undefined,
      inApp: cfg.inApp ?? (cfg.adapter ?? 'metro') !== 'command',
      root: this.root,
    });
    // The proxy's address first: Expo trusts only the address it is served at, which pitbox sets to the proxy.
    this.js = new JsDebugger(this.proxy, this.internalPort, () => this.reload(), [`http://${this.publicHost()}:${this.port}`, `http://localhost:${this.internalPort}`]);
    try {
      const saved = JSON.parse(fs.readFileSync(this.#stateFile, 'utf8')) as {mainUrls?: Record<string, string>};
      for (const [p, u] of Object.entries(saved.mainUrls ?? {})) this.proxy.mainUrls.set(p, u);
    } catch {
      // nothing remembered yet
    }
  }

  /** The address devices use: the LAN address when the proxy serves the network, localhost otherwise. */
  publicHost(): string {
    if (this.cfg.host === 'lan' || this.cfg.host === '0.0.0.0') return lanAddress() ?? 'localhost';
    return this.cfg.host && this.cfg.host !== '127.0.0.1' ? this.cfg.host : 'localhost';
  }

  /** The bundler as a supervised service on the internal port. */
  service(): ServiceConfig {
    const adapter = this.cfg.adapter ?? 'metro';
    const start = (this.cfg.start ?? 'yarn start --port {port}').replace(/\{port\}/g, String(this.internalPort));
    const nodeOptions = [process.env.NODE_OPTIONS, adapter === 'metro' ? `--import ${pathToFileURL(preloadPath()).href}` : undefined].filter(Boolean).join(' ');
    return {
      description: `${adapter} dev server behind pitbox on :${this.port}`,
      start,
      cwd: this.root,
      env: {
        ...(nodeOptions ? {NODE_OPTIONS: nodeOptions} : {}),
        // Expo writes absolute bundle URLs into its manifest; they must point at the proxy, not the bundler.
        ...(adapter === 'metro' ? {EXPO_PACKAGER_PROXY_URL: `http://${this.publicHost()}:${this.port}`} : {}),
        BROWSER: 'none',
        ...this.cfg.env,
      },
      health: `http://127.0.0.1:${this.internalPort}/status`,
      expose: this.port,
      startTimeout: this.cfg.startTimeout ?? 180,
    };
  }

  async start() {
    try {
      await this.proxy.start();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(`port ${this.port} is taken — another dev server is probably running; stop it or set devserver.port`);
      }
      throw e;
    }
    this.#watch();
  }

  /**
   * Takes the device-facing port before the bundler starts, and says why when it cannot. A bundler started behind
   * a port somebody else holds is the quiet failure: devices reach whoever holds it — another project's proxy
   * forwarding to the same internal port serves this bundle well enough — while freshness, the network log and
   * the console report to the other stand.
   */
  async claim(): Promise<string | undefined> {
    if (this.proxy.listening) return undefined;
    try {
      await this.start();
      return undefined;
    } catch (e) {
      return `${(e as Error).message} (the bundler was not started)`;
    }
  }

  async stop() {
    this.#watcher?.close();
    this.#watcher = undefined;
    this.js.stop();
    await this.proxy.stop();
  }

  #watch() {
    if (this.#watcher) return;
    try {
      this.#watcher = fs.watch(this.root, {recursive: true}, (_event, file) => {
        if (!file || IGNORED.test(String(file))) return;
        this.proxy.generation++;
        this.proxy.lastChangeAt = Date.now();
        if (this.#debounce) clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => void this.prewarm(), 800);
      });
      this.#watcher.on('error', () => undefined);
    } catch {
      // without a watcher prewarming still happens at start
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#stateFile), {recursive: true});
    fs.writeFileSync(this.#stateFile, JSON.stringify({mainUrls: Object.fromEntries(this.proxy.mainUrls)}, null, 2));
  }

  /** The main bundle URL for a platform: remembered from the device, configured, or read from Expo's manifest. */
  async mainUrl(platform: string): Promise<string | undefined> {
    const seen = this.proxy.mainUrls.get(platform);
    if (seen) return seen;
    if (this.cfg.bundlePath) return this.cfg.bundlePath.replace(/\{platform\}/g, platform);
    try {
      const res = await fetch(`http://127.0.0.1:${this.internalPort}/`, {
        headers: {'expo-platform': platform, accept: 'application/expo+json,application/json', host: `localhost:${this.port}`},
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      const url = /"launchAsset"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      if (url) {
        const u = new URL(url);
        const found = `${u.pathname}${u.search}`;
        this.proxy.mainUrls.set(platform, found);
        return found;
      }
    } catch {
      // not an Expo server
    }
    return undefined;
  }

  /** Builds every configured platform's main bundle (and bytecode) now, so the device's request is a cache hit. */
  async prewarm(): Promise<NonNullable<DevserverStatus['prewarm']>> {
    const results: NonNullable<DevserverStatus['prewarm']> = [];
    // By default Android and every platform a device has asked for: an iOS app's bundle is rebuilt after an edit
    // as an Android one is.
    for (const platform of this.cfg.platforms ?? [...new Set(['android', ...this.proxy.mainUrls.keys()])]) {
      const t0 = Date.now();
      const url = await this.mainUrl(platform);
      if (!url) {
        results.push({platform, ms: 0, ok: false, note: 'main bundle URL unknown until a device asks (or set devserver.bundlePath)'});
        continue;
      }
      try {
        if (this.proxy.opts.bytecode || this.proxy.opts.inApp) {
          const r = await this.proxy.bundleFor(url, this.proxy.mainHosts.get(platform) ?? `localhost:${this.port}`, true);
          // The compressed copy too, so the device's first request does not wait for it.
          if (!r.error) this.proxy.gzipped(r.body);
          const what = !this.proxy.opts.bytecode ? 'source built' : r.cached ? 'bytecode cached' : 'bytecode compiled';
          results.push({platform, ms: Date.now() - t0, ok: !r.error, note: r.error ? `bundler answered ${r.status}` : what});
        } else {
          const res = await fetch(`http://127.0.0.1:${this.internalPort}${url}`, {headers: {host: `localhost:${this.port}`}});
          await res.arrayBuffer();
          results.push({platform, ms: Date.now() - t0, ok: res.status === 200, note: `source ${res.status}`});
        }
      } catch (e) {
        results.push({platform, ms: Date.now() - t0, ok: false, note: (e as Error).message});
      }
    }
    this.#lastPrewarm = results;
    this.#save();
    return results;
  }

  /** Where each platform's embedded bundle goes: configured, or the app's assets for React Native on Android. */
  embedOutputs(): Record<string, string> {
    const out = this.cfg.embed?.output;
    if (out && Object.keys(out).length) return Object.fromEntries(Object.entries(out).filter((e): e is [string, string] => !!e[1]));
    return (this.cfg.adapter ?? 'metro') === 'command' ? {} : {android: 'android/app/src/main/assets/index.android.bundle'};
  }

  /**
   * Writes the app's bundle into its sources from the running bundler (whole, as bytecode when the app's Hermes
   * compiler is there), then runs the configured build: a debug build that runs with no dev server at all.
   */
  async embed(): Promise<EmbedResult> {
    const outputs = this.embedOutputs();
    if (!Object.keys(outputs).length) throw new Error('nowhere to put the bundle: set devserver.embed.output.{android,ios}');
    const hermesc = this.hermesc ?? findHermesc(this.root);
    const bundles: EmbedResult['bundles'] = [];
    for (const [platform, rel] of Object.entries(outputs)) {
      const t0 = Date.now();
      const url = await this.mainUrl(platform);
      if (!url) {
        bundles.push({platform, ms: 0, error: 'main bundle URL unknown until a device asks (or set devserver.bundlePath)'});
        continue;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${this.internalPort}${eagerUrl(url)}`, {headers: {accept: 'application/javascript'}, signal: AbortSignal.timeout(300_000)});
        const source = Buffer.from(await res.arrayBuffer());
        if (res.status !== 200 || /json/.test(res.headers.get('content-type') ?? '')) throw new Error(`the bundler answered ${res.status}: ${source.toString('utf8').slice(0, 200)}`);
        const body = hermesc ? await hermesCompiler(hermesc, path.join(this.#stateDir, 'embed'))(source) : source;
        const file = path.resolve(this.root, rel);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, body);
        bundles.push({platform, file, kb: Math.round(body.length / 1024), kind: hermesc ? 'bytecode' : 'source', ms: Date.now() - t0});
      } catch (e) {
        bundles.push({platform, ms: Date.now() - t0, error: (e as Error).message});
      }
    }
    const command = this.cfg.embed?.build;
    if (!command || bundles.some(b => b.error)) return {bundles};
    const t0 = Date.now();
    const r = await runShell(command, {cwd: this.root, timeoutMs: (this.cfg.embed?.timeout ?? 900) * 1000});
    const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).filter(l => l.trim()).slice(-6);
    return {bundles, build: {command, code: r.code, ms: Date.now() - t0, tail}};
  }

  /** Asks every connected app to reload, through the bundler's message socket. */
  async reload(): Promise<number> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.internalPort}/message`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), {once: true});
      ws.addEventListener('error', () => reject(new Error('dev server message socket is not reachable')), {once: true});
    });
    ws.send(JSON.stringify({version: 2, method: 'reload'}));
    await new Promise(r => setTimeout(r, 200));
    ws.close();
    return this.proxy.stats.requests.length;
  }

  /**
   * Which code each connected app runs, against the newest build: stale when its bundle is older, and possibly
   * stale when files changed after the newest build (the rebuild has not happened yet).
   */
  /** Waits (up to `maxMs`) for edits to settle: no file change in the last second and no hot-update round running. */
  async settled(maxMs = 5000): Promise<void> {
    const end = Date.now() + maxMs;
    const busy = () => Date.now() - this.proxy.lastChangeAt < 1000 || this.proxy.hotClients().some(h => !h.closedAt && h.inRound);
    while (busy() && Date.now() < end) await new Promise(r => setTimeout(r, 150));
  }

  freshness(): Freshness {
    const p = this.proxy;
    const apps = p.apps().map(a => {
      if (!a.hello) return {id: a.id, platform: '?', bundle: '?', fresh: false, note: 'connected, not introduced yet'};
      const latest = p.latest.get(a.hello.platform);
      const built = p.builds.get(a.hello.bundle);
      const newest = latest ? p.builds.get(latest) : undefined;
      const pending = newest !== undefined && p.generation > newest.generation;
      // The app's hot-update connection (one per app and platform in practice).
      const hot = p.hotClients().find(h => !h.closedAt && h.platform === a.hello!.platform && h.connectedAt >= a.connectedAt - 60_000);
      const hotInfo = hot?.lastUpdate ? {updates: hot.updates, lastS: Math.round((Date.now() - hot.lastUpdate.at) / 1000), modules: hot.lastUpdate.modules} : undefined;
      if (hot?.lastError) {
        return {id: a.id, platform: a.hello.platform, bundle: a.hello.bundle, latest, fresh: false, note: 'the last edit did not compile; the app runs the code before it', compileError: hot.lastError.message || hot.lastError.type, hot: hotInfo};
      }
      // A hot-update round that compiled after the last file change: the app runs the newest code without a new
      // bundle. The bundler and pitbox hear of a change separately, so a second of slack between the two.
      const hotFresh = !!hot?.registered && !hot.inRound && hot.syncedAt !== undefined && hot.syncedAt >= p.lastChangeAt - 1000;
      const fresh = (!!latest && latest === a.hello.bundle && !pending) || hotFresh;
      const note = fresh
        ? undefined
        : latest && latest !== a.hello.bundle
          ? `runs bundle ${a.hello.bundle}${built ? ` built ${Math.round((Date.now() - built.at) / 1000)}s ago` : ' from before this daemon'}; newest is ${latest} — relaunch or reload the app`
          : pending
            ? `files changed after the newest build (${p.generation - newest!.generation} change events) — rebuilding; check again or prewarm`
            : 'no build recorded for its platform yet';
      return {id: a.id, platform: a.hello.platform, bundle: a.hello.bundle, latest, fresh, note, runningForS: Math.round((Date.now() - a.hello.startedAt) / 1000), hot: hotInfo};
    });
    return {apps, generation: p.generation};
  }

  status(): DevserverStatus {
    const s = this.proxy.stats;
    const now = Date.now();
    return {
      port: this.port,
      internalPort: this.internalPort,
      proxy: this.proxy.listening,
      bytecode: !this.cfg.bytecode ? 'off' : this.hermesc ? 'on' : 'unavailable',
      hermesc: this.hermesc,
      generation: this.proxy.generation,
      compiles: s.compiles,
      cacheHits: s.cacheHits,
      lastCompileMs: s.lastCompileMs,
      lastSourceKB: s.lastSourceBytes ? Math.round(s.lastSourceBytes / 1024) : undefined,
      lastBytecodeKB: s.lastBytecodeBytes ? Math.round(s.lastBytecodeBytes / 1024) : undefined,
      lastError: s.lastError,
      prewarm: this.#lastPrewarm,
      requests: s.requests.slice(-5).map(r => ({url: r.url.split('?')[0] ?? r.url, kind: r.kind, ms: r.ms, kb: Math.round(r.bytes / 1024), status: r.status, note: r.note, ago: `${Math.round((now - r.at) / 1000)}s`})),
    };
  }
}

export {isNativeBundleRequest};
