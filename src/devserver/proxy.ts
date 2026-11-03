// The device-facing side of the dev server: a transparent HTTP and WebSocket proxy in front of the bundler.
// It sees every bundle request (so it can measure them). For the app's main bundle — the request the native
// loader makes — it can splice in pitbox's in-app script (freshness, network log and rules, trace headers)
// and answer with Hermes bytecode compiled on the host, from a cache the daemon fills before the device asks.
// Apps talk back over `/pitbox/app`. The bundler's hot-update channel (`/hot`) passes through pitbox too: an
// app given bytecode runs the eager graph, so its registration is pointed at that graph (the bundler knows no
// other one, and hot updates would stop without a word), and every update and compile error is seen on the way.

import http from 'node:http';
import net from 'node:net';
import {WebSocket as WsClient, WebSocketServer, type RawData, type WebSocket} from 'ws';
import type {BytecodeCache, Compiler} from './hermes.ts';
import {BytecodeCache as Cache} from './hermes.ts';
import {injectInApp, inAppScript} from './inapp.ts';
import {formatFrames, injectionOf, parseStack, symbolicate, unshift, type Injection} from './symbolicate.ts';

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
  /** Splice the in-app script into the main bundle. */
  inApp?: boolean;
  /** App directory: symbolicated paths are shown relative to it. */
  root?: string;
};

export type NetRule = {
  id: string;
  kind?: 'http' | 'ws';
  /** Substring of the URL, or `*`. */
  match: string;
  action: 'fail' | 'mock' | 'delay' | 'freeze';
  status?: number;
  body?: unknown;
  ms?: number;
};

/** A JS error that reached the app's global handler, with its stack mapped to source files. */
export type JsError = {at: number; app: number; platform?: string; message: string; fatal: boolean; frames: string[]; code?: string; symbolicated: boolean};

/** An app's hot-update connection to the bundler, as pitbox saw it pass. */
export type HotClient = {
  id: number;
  platform?: string;
  connectedAt: number;
  registered: boolean;
  /** Registration pointed at the eager graph the app's bytecode was built from. */
  eager?: boolean;
  /** Rounds that changed modules in the app. */
  updates: number;
  lastUpdate?: {at: number; modules: number};
  /** When the last round that compiled ended (empty rounds count: the change did not touch the app). */
  syncedAt?: number;
  /** A round has started and not ended. */
  inRound: boolean;
  lastError?: {at: number; type: string; message: string};
  closedAt?: number;
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export type AppHello = {bundle: string; gen: number; platform: string; startedAt: number};
export type AppInfo = {id: number; remote: string; connectedAt: number; hello?: AppHello};

/** The native bundle loader asks for multipart; the app's own `fetch` of a lazy bundle does not. */
export const isNativeBundleRequest = (method: string | undefined, url: string, accept: string | undefined) =>
  method === 'GET' && /\.bundle(\?|$)/.test(url) && /multipart\/mixed/.test(accept ?? '') && !/[?&]modulesOnly=true/.test(url);

/** Bytecode cannot be `eval`-ed, so lazily split bundles are folded into the main one. */
export const eagerUrl = (url: string) => url.replace(/([?&])lazy=true/, '$1lazy=false');

export const platformOf = (url: string) => /[?&]platform=(\w+)/.exec(url)?.[1] ?? 'unknown';

type AppSession = AppInfo & {ws: WebSocket};

export class DevProxy {
  readonly opts: ProxyOptions;
  readonly stats: ProxyStats = {requests: [], compiles: 0, cacheHits: 0};
  /** Bumped by the file watcher; a cached answer from an older generation is not trusted without a check. */
  generation = 0;
  /** When the file watcher last saw a change. */
  lastChangeAt = 0;
  /** Last main bundle URL each platform asked for — what prewarming rebuilds. */
  readonly mainUrls = new Map<string, string>();
  /** Host header of the last main bundle request per platform — the address devices use, which prewarming must match. */
  readonly mainHosts = new Map<string, string>();
  /** Bundles built, by id (hash of the bundler's output): when and from which generation. */
  readonly builds = new Map<string, {generation: number; at: number}>();
  /** The newest bundle id per platform. */
  readonly latest = new Map<string, string>();
  rules: NetRule[] = [];
  trace: string | null = null;
  /** Serve source even with bytecode on: the runtime's debugger needs the debug info it builds from source itself. */
  debugSource = false;
  /** What each platform's app was last given for its main bundle. */
  readonly servedKind = new Map<string, 'bytecode' | 'source'>();
  #server?: http.Server;
  /** Upgraded (WebSocket) connections, which the HTTP server no longer tracks. */
  readonly #sockets = new Set<net.Socket>();
  readonly #served = new Map<string, {generation: number; key: string; bundle: string}>();
  readonly #compiling = new Map<string, Promise<Buffer>>();
  readonly #wss = new WebSocketServer({noServer: true});
  readonly #hotWss = new WebSocketServer({noServer: true});
  readonly hot = new Map<number, HotClient & {close: () => void}>();
  #hotSeq = 0;
  readonly #apps = new Map<number, AppSession>();
  #appSeq = 0;
  #reqSeq = 0;
  readonly #replies = new Map<number, (data: unknown) => void>();
  /** Where the in-app script went in each bundle, by bundle id. */
  readonly #injections = new Map<string, Injection>();
  readonly errors: JsError[] = [];
  /** When apps said hello (host clock), newest last. */
  readonly #hellos: number[] = [];
  readonly #symbolicating = new Set<Promise<void>>();

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
    for (const a of this.#apps.values()) a.ws.terminate();
    this.#apps.clear();
    for (const h of this.hot.values()) h.close();
    this.hot.clear();
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
   * The main bundle for a URL, with the in-app script spliced in when enabled: bytecode when it is ready (or
   * `wait` is set), otherwise source now with the compile carrying on in the background — so a device is never
   * slower than with the bundler alone.
   */
  async bundleFor(url: string, host: string, wait: boolean): Promise<{kind: 'bytecode' | 'source'; body: Buffer; cached: boolean; status: number; error?: boolean; bundle?: string}> {
    const bc = this.debugSource ? undefined : this.opts.bytecode;
    const generation = this.generation;
    const servedKey = `${host}|${url}`;
    const served = this.#served.get(servedKey);
    if (bc && served && served.generation === generation) {
      const hit = bc.cache.get(served.key);
      if (hit) {
        this.stats.cacheHits++;
        return {kind: 'bytecode', body: hit, cached: true, status: 200, bundle: served.bundle};
      }
    }
    const res = await fetch(`http://127.0.0.1:${this.opts.upstreamPort}${bc ? eagerUrl(url) : url}`, {headers: {accept: 'application/javascript', host}});
    const source = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || /json/.test(res.headers.get('content-type') ?? '')) {
      return {kind: 'source', body: source, cached: false, status: res.status, error: true};
    }
    this.stats.lastSourceBytes = source.length;
    const platform = platformOf(url);
    const bundle = Cache.key(source).slice(0, 12);
    const known = this.builds.get(bundle);
    // Rebuilding the same output (an edit undone) still means "up to date as of this generation".
    this.builds.set(bundle, {generation: Math.max(generation, known?.generation ?? 0), at: known?.at ?? Date.now()});
    this.latest.set(platform, bundle);
    let body: Buffer = source;
    if (this.opts.inApp) {
      const script = inAppScript({bundle, gen: generation, platform, http: `http://${host}`, ws: `ws://${host}/pitbox/app`, fromSource: !bc});
      body = injectInApp(source, script);
      const at = injectionOf(source.toString('utf8'), script);
      if (at) this.#injections.set(bundle, at);
    }
    if (!bc) return {kind: 'source', body, cached: false, status: 200, bundle};
    const key = Cache.key(body);
    const hit = bc.cache.get(key);
    if (hit) {
      this.stats.cacheHits++;
      this.#served.set(servedKey, {generation, key, bundle});
      return {kind: 'bytecode', body: hit, cached: true, status: 200, bundle};
    }
    const compile = this.#compile(key, body).then(b => {
      this.#served.set(servedKey, {generation, key, bundle});
      return b;
    });
    if (wait) return {kind: 'bytecode', body: await compile, cached: false, status: 200, bundle};
    compile.catch(() => undefined);
    return {kind: 'source', body, cached: false, status: 200, bundle};
  }

  // ---- apps -------------------------------------------------------------------------------------------------

  apps(): AppInfo[] {
    return [...this.#apps.values()].map(({ws: _ws, ...info}) => info);
  }

  #send(msg: unknown, app?: AppSession) {
    const data = JSON.stringify(msg);
    for (const a of app ? [app] : this.#apps.values()) if (a.ws.readyState === a.ws.OPEN) a.ws.send(data);
  }

  setRules(rules: NetRule[]) {
    this.rules = rules;
    this.#send({type: 'rules', rules});
  }

  setTrace(id: string | null) {
    this.trace = id;
    this.#send({type: 'trace', id});
  }

  /** Asks every connected app; resolves with the answers that arrive within `timeoutMs`. */
  async query<T = unknown>(what: 'idle' | 'log' | 'tree' | 'console', extra: Record<string, unknown> = {}, timeoutMs = 2000): Promise<{app: AppInfo; data: T}[]> {
    const asks = [...this.#apps.values()].map(
      app =>
        new Promise<{app: AppInfo; data: T} | undefined>(resolve => {
          const reqId = ++this.#reqSeq;
          const timer = setTimeout(() => {
            this.#replies.delete(reqId);
            resolve(undefined);
          }, timeoutMs);
          this.#replies.set(reqId, data => {
            clearTimeout(timer);
            const {ws: _ws, ...info} = app;
            resolve({app: info, data: data as T});
          });
          this.#send({type: 'query', what, reqId, ...extra}, app);
        }),
    );
    return (await Promise.all(asks)).filter((x): x is {app: AppInfo; data: T} => !!x);
  }

  /**
   * The JS side of an app start after `since`: the main bundle request, then the moment the bundle started running
   * (from the in-app script's hello). Gives up on the request after `requestMs` (not a dev build, or another server) and on the hello
   * after `helloMs`.
   */
  async startAfter(since: number, requestMs = 8000, helloMs = 60_000): Promise<{bundle?: BundleRequest; runningAt?: number}> {
    const until = (ms: number, done: () => boolean) =>
      new Promise<void>(resolve => {
        const end = Date.now() + ms;
        const tick = () => (done() || Date.now() > end ? resolve() : setTimeout(tick, 100));
        tick();
      });
    const request = () => this.stats.requests.find(r => r.at >= since && r.kind !== 'lazy');
    const hello = () => this.#hellos.find(t => t >= since);
    await until(requestMs, () => !!request() || !!hello());
    if (!request() && !hello()) return {};
    await until(helloMs, () => !!hello());
    return {bundle: request(), runningAt: hello()};
  }

  #onError(app: AppSession, msg: {message?: string; name?: string; stack?: string; fatal?: boolean}) {
    const name = msg.name && msg.name !== 'Error' ? `${msg.name}: ` : '';
    const raw = unshift(parseStack(String(msg.stack ?? '')), app.hello ? this.#injections.get(app.hello.bundle) : undefined);
    const e: JsError = {at: Date.now(), app: app.id, platform: app.hello?.platform, message: `${name}${String(msg.message ?? '')}`.slice(0, 500), fatal: !!msg.fatal, frames: formatFrames(raw, this.opts.root ?? process.cwd()), symbolicated: false};
    this.errors.push(e);
    if (this.errors.length > 30) this.errors.shift();
    const job = symbolicate(this.opts.upstreamPort, raw).then(r => {
      if (!r.ok) return;
      e.frames = formatFrames(r.frames, this.opts.root ?? process.cwd());
      e.code = r.code;
      e.symbolicated = true;
    });
    this.#symbolicating.add(job);
    void job.finally(() => this.#symbolicating.delete(job));
  }

  /** Where a call came from: the first app frames of a stack the app sent, mapped to source files. */
  async callSite(app: AppInfo, stack: string, limit = 1): Promise<string[]> {
    const raw = unshift(parseStack(stack), app.hello ? this.#injections.get(app.hello.bundle) : undefined);
    if (!raw.length) return [];
    const r = await symbolicate(this.opts.upstreamPort, raw);
    return formatFrames(r.frames, this.opts.root ?? process.cwd(), limit).filter(l => !l.startsWith('…'));
  }

  /** JS errors received since `since` (ms epoch), once their symbolication is done or `waitMs` has passed. */
  async errorsSince(since: number, waitMs = 3000): Promise<JsError[]> {
    if (this.#symbolicating.size) await Promise.race([Promise.allSettled([...this.#symbolicating]), new Promise(r => setTimeout(r, waitMs))]);
    return this.errors.filter(e => e.at >= since);
  }

  #onApp(ws: WebSocket, remote: string) {
    const app: AppSession = {id: ++this.#appSeq, ws, remote, connectedAt: Date.now()};
    this.#apps.set(app.id, app);
    ws.on('message', raw => {
      let msg: {type?: string; reqId?: number; data?: unknown} & Partial<AppHello>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        app.hello = {bundle: String(msg.bundle), gen: Number(msg.gen), platform: String(msg.platform), startedAt: Number(msg.startedAt)};
        // When the bundle started running, on the host's clock: the app says how long ago, not when.
        this.#hellos.push(Date.now() - Math.max(0, Number((msg as {sinceStart?: number}).sinceStart) || 0));
        if (this.#hellos.length > 20) this.#hellos.shift();
        this.#send({type: 'rules', rules: this.rules}, app);
        if (this.trace) this.#send({type: 'trace', id: this.trace}, app);
      } else if (msg.type === 'error') {
        this.#onError(app, msg as unknown as {message?: string; name?: string; stack?: string; fatal?: boolean});
      } else if (msg.type === 'reply' && msg.reqId !== undefined) {
        this.#replies.get(msg.reqId)?.(msg.data);
        this.#replies.delete(msg.reqId);
      }
    });
    ws.on('close', () => this.#apps.delete(app.id));
    ws.on('error', () => this.#apps.delete(app.id));
  }

  // ---- http -------------------------------------------------------------------------------------------------

  async #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url ?? '/';
    const t0 = Date.now();

    const mock = /^\/pitbox\/mock\/([\w-]+)/.exec(url);
    if (mock) {
      const rule = this.rules.find(r => r.id === mock[1] && r.action === 'mock');
      if (!rule) return void res.writeHead(404).end('no such mock');
      if (rule.ms) await new Promise(r => setTimeout(r, rule.ms));
      const json = typeof rule.body !== 'string';
      res.writeHead(rule.status ?? 200, {'content-type': json ? 'application/json' : 'text/plain'}).end(json ? JSON.stringify(rule.body ?? {}) : (rule.body as string));
      return;
    }

    const isBundle = req.method === 'GET' && /\.bundle(\?|$)/.test(url);
    const native = isNativeBundleRequest(req.method, url, req.headers.accept);
    if (native) {
      this.mainUrls.set(platformOf(url), url);
      if (req.headers.host) this.mainHosts.set(platformOf(url), req.headers.host);
    }

    if (native && (this.opts.bytecode || this.opts.inApp)) {
      try {
        const r = await this.bundleFor(url, req.headers.host ?? `localhost:${this.opts.port}`, false);
        if (r.error) {
          res.writeHead(r.status, {'content-type': 'application/json'}).end(r.body);
          this.#record({at: t0, url, kind: 'source', ms: Date.now() - t0, bytes: r.body.length, status: r.status, note: 'bundler error'});
          return;
        }
        res.writeHead(200, {'content-type': 'application/javascript', 'content-length': r.body.length, 'cache-control': 'no-store'});
        res.end(r.body);
        this.servedKind.set(platformOf(url), r.kind);
        const note = r.kind === 'bytecode' ? 'cached' : this.debugSource ? 'source for the debugger' : this.opts.bytecode ? 'bytecode not ready, compiling in background' : undefined;
        this.#record({at: t0, url, kind: r.kind, ms: Date.now() - t0, bytes: r.body.length, status: 200, note});
        return;
      } catch (e) {
        // Fall back to plain proxying: a broken compiler or injector must not take the app down with it.
        this.stats.lastError = (e as Error).message;
      }
    }

    if (native) this.servedKind.set(platformOf(url), 'source');
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

  /** Hot-update clients, newest first; closed ones are kept a while for what they last saw. */
  hotClients(): HotClient[] {
    return [...this.hot.values()].map(({close: _c, ...h}) => h).sort((a, b) => b.connectedAt - a.connectedAt);
  }

  #onHot(app: WebSocket, req: http.IncomingMessage) {
    const h: HotClient & {close: () => void} = {id: ++this.#hotSeq, connectedAt: Date.now(), registered: false, updates: 0, inRound: false, close: () => undefined};
    this.hot.set(h.id, h);
    // Closed clients older than the newest ten are forgotten.
    const closed = [...this.hot.values()].filter(x => x.closedAt).sort((a, b) => b.connectedAt - a.connectedAt);
    for (const old of closed.slice(10)) this.hot.delete(old.id);
    const headers = {...req.headers};
    for (const k of ['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions']) delete headers[k];
    const up = new WsClient(`ws://127.0.0.1:${this.opts.upstreamPort}${req.url ?? '/hot'}`, {headers: headers as Record<string, string>});
    const queue: string[] = [];
    let initial = false;
    let modules = 0;
    let failed = false;
    const root = (this.opts.root ?? '').replace(/[\/]+$/, '');
    const done = () => {
      if (h.closedAt) return;
      h.closedAt = Date.now();
      if (app.readyState === app.OPEN) app.close();
      if (up.readyState === up.OPEN || up.readyState === up.CONNECTING) up.terminate();
    };
    h.close = () => {
      done();
      app.terminate();
    };
    const toUp = (text: string) => (up.readyState === up.OPEN ? up.send(text) : queue.push(text));
    up.on('open', () => {
      for (const t of queue.splice(0)) up.send(t);
    });
    app.on('message', (raw: RawData) => {
      const text = String(raw);
      let msg: {type?: string; entryPoints?: string[]};
      try {
        msg = JSON.parse(text);
      } catch {
        return toUp(text);
      }
      if (msg.type === 'register-entrypoints' && Array.isArray(msg.entryPoints)) {
        msg.entryPoints = msg.entryPoints.map(u => {
          const platform = platformOf(u);
          h.platform ??= platform;
          if (this.servedKind.get(platform) !== 'bytecode') return u;
          h.eager = true;
          return eagerUrl(u);
        });
        return toUp(JSON.stringify(msg));
      }
      toUp(text);
    });
    up.on('message', (raw: RawData) => {
      const text = String(raw);
      try {
        const msg = JSON.parse(text) as {type?: string; body?: {isInitialUpdate?: boolean; added?: unknown[]; modified?: unknown[]; deleted?: unknown[]; type?: string; message?: string}};
        if (msg.type === 'bundle-registered') h.registered = true;
        else if (msg.type === 'update-start') {
          initial = !!msg.body?.isInitialUpdate;
          modules = 0;
          failed = false;
          h.inRound = true;
        } else if (msg.type === 'update') {
          modules += (msg.body?.added?.length ?? 0) + (msg.body?.modified?.length ?? 0) + (msg.body?.deleted?.length ?? 0);
        } else if (msg.type === 'update-done') {
          // The bundler ends a round with update-done whether or not it compiled.
          h.inRound = false;
          if (!failed) {
            h.syncedAt = Date.now();
            h.lastError = undefined;
            if (!initial && modules) {
              h.updates++;
              h.lastUpdate = {at: Date.now(), modules};
            }
          }
        } else if (msg.type === 'error') {
          failed = true;
          let message = String(msg.body?.message ?? '').replace(ANSI, '');
          if (root) message = message.split(`${root}\\`).join('').split(`${root}/`).join('');
          h.lastError = {at: Date.now(), type: String(msg.body?.type ?? 'Error'), message: message.slice(0, 1500)};
        }
      } catch {
        // not JSON: pass it on as it is
      }
      if (app.readyState === app.OPEN) app.send(text);
    });
    app.on('close', done);
    app.on('error', done);
    up.on('close', done);
    up.on('error', done);
  }

  #upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    if ((req.url ?? '').startsWith('/pitbox/app')) {
      this.#wss.handleUpgrade(req, socket, head, ws => this.#onApp(ws, socket.remoteAddress ?? ''));
      return;
    }
    if ((req.url ?? '').startsWith('/hot')) {
      this.#hotWss.handleUpgrade(req, socket, head, ws => this.#onHot(ws, req));
      return;
    }
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
