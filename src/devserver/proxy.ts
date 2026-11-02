// The device-facing side of the dev server: a transparent HTTP and WebSocket proxy in front of the bundler.
// It sees every bundle request (so it can measure them), and when bytecode is on it answers the app's main
// bundle request — the one the native loader makes — with Hermes bytecode compiled on the host, from a cache
// that the daemon fills before the device asks.

import http from 'node:http';
import net from 'node:net';
import type {BytecodeCache, Compiler} from './hermes.ts';
import {BytecodeCache as Cache} from './hermes.ts';

export type BundleRequest = {at: number; url: string; kind: 'bytecode' | 'source' | 'lazy'; ms: number; bytes: number; status: number; note?: string};

export type ProxyStats = {
  requests: BundleRequest[];
  compiles: number;
  cacheHits: number;
  lastCompileMs?: number;
  lastSourceBytes?: number;
  lastBytecodeBytes?: number;
  lastError?: string;
};

export type ProxyOptions = {
  port: number;
  host?: string;
  upstreamPort: number;
  bytecode?: {compile: Compiler; cache: BytecodeCache};
};

/** The native bundle loader asks for multipart; the app's own `fetch` of a lazy bundle does not. */
export const isNativeBundleRequest = (method: string | undefined, url: string, accept: string | undefined) =>
  method === 'GET' && /\.bundle(\?|$)/.test(url) && /multipart\/mixed/.test(accept ?? '') && !/[?&]modulesOnly=true/.test(url);

/** Bytecode cannot be `eval`-ed, so lazily split bundles are folded into the main one. */
export const eagerUrl = (url: string) => url.replace(/([?&])lazy=true/, '$1lazy=false');

export const platformOf = (url: string) => /[?&]platform=(\w+)/.exec(url)?.[1] ?? 'unknown';

export class DevProxy {
  readonly opts: ProxyOptions;
  readonly stats: ProxyStats = {requests: [], compiles: 0, cacheHits: 0};
  /** Bumped by the file watcher; a cached answer from an older generation is not trusted without a check. */
  generation = 0;
  /** Last main bundle URL each platform asked for — what prewarming rebuilds. */
  readonly mainUrls = new Map<string, string>();
  #server?: http.Server;
  /** Upgraded (WebSocket) connections, which the HTTP server no longer tracks. */
  readonly #sockets = new Set<net.Socket>();
  readonly #served = new Map<string, {generation: number; key: string}>();

  constructor(opts: ProxyOptions) {
    this.opts = opts;
  }

  get listening() {
    return this.#server?.listening ?? false;
  }

  async start(): Promise<void> {
    if (this.listening) return;
    const server = http.createServer((req, res) => void this.#handle(req, res));
    server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket as net.Socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host ?? '127.0.0.1', () => resolve());
    });
    this.#server = server;
  }

  async stop() {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }

  #record(r: BundleRequest) {
    this.stats.requests.push(r);
    if (this.stats.requests.length > 20) this.stats.requests.shift();
  }

  readonly #compiling = new Map<string, Promise<Buffer>>();

  /** Resolves once every background compile has finished (tests, prewarm reporting). */
  async whenIdle() {
    await Promise.allSettled([...this.#compiling.values()]);
  }

  #compile(key: string, source: Buffer): Promise<Buffer> {
    const bc = this.opts.bytecode!;
    const pending = this.#compiling.get(key);
    if (pending) return pending;
    const job = (async () => {
      const t0 = Date.now();
      const bytecode = await bc.compile(source);
      this.stats.compiles++;
      this.stats.lastCompileMs = Date.now() - t0;
      this.stats.lastBytecodeBytes = bytecode.length;
      bc.cache.put(key, bytecode);
      return bytecode;
    })();
    job.catch(e => (this.stats.lastError = (e as Error).message)).finally(() => this.#compiling.delete(key));
    this.#compiling.set(key, job);
    return job;
  }

  /**
   * The main bundle for a URL: bytecode when it is ready (or `wait` is set), otherwise the eager source now with
   * the compile carrying on in the background — so a device is never slower than with the bundler alone.
   */
  async bundleFor(url: string, host: string, wait: boolean): Promise<{kind: 'bytecode' | 'source'; body: Buffer; cached: boolean; status: number; error?: boolean}> {
    const bc = this.opts.bytecode;
    if (!bc) throw new Error('bytecode is off');
    const generation = this.generation;
    const served = this.#served.get(url);
    if (served && served.generation === generation) {
      const hit = bc.cache.get(served.key);
      if (hit) {
        this.stats.cacheHits++;
        return {kind: 'bytecode', body: hit, cached: true, status: 200};
      }
    }
    const res = await fetch(`http://127.0.0.1:${this.opts.upstreamPort}${eagerUrl(url)}`, {headers: {accept: 'application/javascript', host}});
    const source = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || /json/.test(res.headers.get('content-type') ?? '')) {
      return {kind: 'source', body: source, cached: false, status: res.status, error: true};
    }
    this.stats.lastSourceBytes = source.length;
    const key = Cache.key(source);
    const hit = bc.cache.get(key);
    if (hit) {
      this.stats.cacheHits++;
      this.#served.set(url, {generation, key});
      return {kind: 'bytecode', body: hit, cached: true, status: 200};
    }
    const compile = this.#compile(key, source).then(b => {
      this.#served.set(url, {generation, key});
      return b;
    });
    if (wait) return {kind: 'bytecode', body: await compile, cached: false, status: 200};
    compile.catch(() => undefined);
    return {kind: 'source', body: source, cached: false, status: 200};
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url ?? '/';
    const t0 = Date.now();
    const isBundle = req.method === 'GET' && /\.bundle(\?|$)/.test(url);
    const native = isNativeBundleRequest(req.method, url, req.headers.accept);
    if (native) this.mainUrls.set(platformOf(url), url);

    if (native && this.opts.bytecode) {
      try {
        const r = await this.bundleFor(url, req.headers.host ?? `localhost:${this.opts.port}`, false);
        if (r.error) {
          res.writeHead(r.status, {'content-type': 'application/json'}).end(r.body);
          this.#record({at: t0, url, kind: 'source', ms: Date.now() - t0, bytes: r.body.length, status: r.status, note: 'bundler error'});
          return;
        }
        res.writeHead(200, {'content-type': 'application/javascript', 'content-length': r.body.length, 'cache-control': 'no-store'});
        res.end(r.body);
        this.#record({at: t0, url, kind: r.kind, ms: Date.now() - t0, bytes: r.body.length, status: 200, note: r.kind === 'bytecode' ? 'cached' : 'bytecode not ready, compiling in background'});
        return;
      } catch (e) {
        // Fall back to source: a broken compiler must not take the app down with it.
        this.stats.lastError = (e as Error).message;
      }
    }

    const upstream = http.request({host: '127.0.0.1', port: this.opts.upstreamPort, path: url, method: req.method, headers: req.headers}, up => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      let bytes = 0;
      up.on('data', (d: Buffer) => (bytes += d.length));
      up.pipe(res);
      if (isBundle) up.on('end', () => this.#record({at: t0, url, kind: native ? 'source' : 'lazy', ms: Date.now() - t0, bytes, status: up.statusCode ?? 0}));
    });
    upstream.on('error', e => {
      if (!res.headersSent) res.writeHead(502, {'content-type': 'text/plain'});
      res.end(`pitbox: dev server unreachable on :${this.opts.upstreamPort} (${e.message})`);
    });
    req.pipe(upstream);
  }

  #upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    const up = net.connect(this.opts.upstreamPort, '127.0.0.1', () => {
      const headers = Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => `${k}: ${x}`) : [`${k}: ${v}`]));
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  }
}
