// The dev server as pitbox runs it: the project's bundler on an internal port (a supervised service, so it
// survives daemon restarts), pitbox's proxy on the device-facing port, a native file watcher inside the
// bundler, and prewarming so the main bundle — and its bytecode — is ready before the device asks.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {DevserverConfig, ServiceConfig} from '../config/schema.ts';
import {BytecodeCache, findHermesc, hermesCompiler} from './hermes.ts';
import {DevProxy, isNativeBundleRequest} from './proxy.ts';

export const DEVSERVER = 'devserver';

const IGNORED = /(^|[\\/])(node_modules|\.git|\.pitbox|\.expo|\.gradle|build|Pods|DerivedData|\.cxx)([\\/]|$)/;

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
  readonly hermesc?: string;
  #watcher?: fs.FSWatcher;
  #debounce?: NodeJS.Timeout;
  #lastPrewarm?: DevserverStatus['prewarm'];
  readonly #stateFile: string;

  constructor(cfg: DevserverConfig, configRoot: string, stateDir: string) {
    this.cfg = cfg;
    this.root = cfg.root ? path.resolve(configRoot, cfg.root) : configRoot;
    this.port = cfg.port ?? 8081;
    this.internalPort = cfg.internalPort ?? this.port + 1;
    this.hermesc = cfg.bytecode ? findHermesc(this.root) : undefined;
    this.#stateFile = path.join(stateDir, 'devserver.json');
    this.proxy = new DevProxy({
      port: this.port,
      host: cfg.host,
      upstreamPort: this.internalPort,
      bytecode: this.hermesc ? {compile: hermesCompiler(this.hermesc, path.join(stateDir, 'bytecode', 'work')), cache: new BytecodeCache(path.join(stateDir, 'bytecode'))} : undefined,
    });
    try {
      const saved = JSON.parse(fs.readFileSync(this.#stateFile, 'utf8')) as {mainUrls?: Record<string, string>};
      for (const [p, u] of Object.entries(saved.mainUrls ?? {})) this.proxy.mainUrls.set(p, u);
    } catch {
      // nothing remembered yet
    }
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
        ...(adapter === 'metro' ? {EXPO_PACKAGER_PROXY_URL: `http://localhost:${this.port}`} : {}),
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

  async stop() {
    this.#watcher?.close();
    this.#watcher = undefined;
    await this.proxy.stop();
  }

  #watch() {
    if (this.#watcher) return;
    try {
      this.#watcher = fs.watch(this.root, {recursive: true}, (_event, file) => {
        if (!file || IGNORED.test(String(file))) return;
        this.proxy.generation++;
        if (this.#debounce) clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => void this.prewarm(), 1500);
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
    for (const platform of this.cfg.platforms ?? ['android']) {
      const t0 = Date.now();
      const url = await this.mainUrl(platform);
      if (!url) {
        results.push({platform, ms: 0, ok: false, note: 'main bundle URL unknown until a device asks (or set devserver.bundlePath)'});
        continue;
      }
      try {
        if (this.proxy.opts.bytecode) {
          const r = await this.proxy.bytecodeFor(url, `localhost:${this.port}`);
          results.push({platform, ms: Date.now() - t0, ok: !r.error, note: r.error ? `bundler answered ${r.status}` : r.cached ? 'bytecode cached' : 'bytecode compiled'});
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
