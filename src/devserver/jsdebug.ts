// The app's JS runtime as tools, over the debugger protocol: evaluate an expression in the app, and logpoints —
// a value logged at a source line without editing code or rebuilding.
//
// A logpoint is a conditional breakpoint whose condition records the values and answers false, so the app never
// stops. The condition calls a closure created in the paused frame, which reads its locals and lets an error in
// one expression be reported instead of silently skipping the hit. Hermes evaluates in a frame only with the
// debug information it builds when it compiles source itself; host-compiled bytecode does not carry it (hermesc
// cannot emit it), so while logpoints exist the dev server serves source, and the first logpoint reloads an app
// that runs bytecode.

import type {CdpEvent, CdpPage} from './cdp.ts';
import {CdpSession, listPages, pickPage} from './cdp.ts';
import type {DevProxy} from './proxy.ts';
import {bundlePosition, type BundlePos, type RawSourceMap} from './sourcemap.ts';
import {pitboxFmt} from './valuefmt.ts';

// The body below runs inside the app, not in Node. Plain ES5: it is sent as source and evaluated by the runtime.
/* eslint-disable */
function pitboxJs(fmt: (v: any, depth?: number, seen?: any[]) => string): any {
  var g: any = globalThis as any;
  if (g.__pitboxJs) return g.__pitboxJs;
  var LIMIT = 4000;
  var errText = function (e: any) {
    return e && e.name ? e.name + ': ' + e.message : String(e);
  };
  var show = function (v: any) {
    var s = fmt(v, 0, []);
    return s.length > LIMIT ? s.slice(0, LIMIT) + '… (' + s.length + ' chars)' : s;
  };
  var api: any = {
    hits: [],
    results: {},
    seq: 0,
    run: function (src: string) {
      var v;
      try {
        v = (0, eval)(src);
      } catch (e) {
        return {error: errText(e)};
      }
      if (v && typeof v.then === 'function') {
        var id = ++api.seq;
        v.then(
          function (x: any) {
            api.results[id] = {value: show(x)};
          },
          function (e: any) {
            api.results[id] = {error: errText(e)};
          },
        );
        return {pending: id};
      }
      return {value: show(v)};
    },
    take: function (id: number) {
      var r = api.results[id];
      if (!r) return {pending: id};
      delete api.results[id];
      return r;
    },
    // One closure per expression, so a typo in one still lets the others through.
    hit: function (id: string, fs: any[]) {
      var parts: string[] = [];
      for (var i = 0; i < fs.length; i++) {
        try {
          parts.push(fmt(fs[i](), 0, []));
        } catch (e) {
          parts.push('! ' + errText(e));
        }
      }
      var v = parts.join('  ');
      if (v.length > 1000) v = v.slice(0, 1000) + '…';
      api.hits.push({id: id, at: Date.now(), v: v});
      if (api.hits.length > 500) api.hits.shift();
      return false;
    },
    drain: function () {
      return api.hits.splice(0);
    },
  };
  g.__pitboxJs = api;
  return api;
}
/* eslint-enable */

const HELPER = `(${pitboxJs.toString()})(${pitboxFmt.toString()})`;

export type Hit = {at: number; v: string};

export type Logpoint = {
  id: string;
  file: string;
  line: number;
  exprs: string[];
  /** The source file and line the breakpoint landed on (the next line with code when `line` has none). */
  source?: string;
  codeLine?: number;
  at?: BundlePos;
  error?: string;
  count: number;
  hits: Hit[];
};

export type EvalResult = {value?: string; error?: string; app: string; apps: number; ms: number};

const KEEP_HITS = 50;

/** `file:line` → parts; the file may contain a drive letter's colon. */
export const parseAt = (at: string): {file: string; line: number} => {
  const m = /^(.+):(\d+)$/.exec(at.trim());
  if (!m) throw new Error(`a logpoint goes at <file>:<line>, not "${at}"`);
  return {file: m[1]!, line: Number(m[2])};
};

/** Each expression must parse on its own: a syntax error in a breakpoint condition fails without a word. */
export const checkExprs = (exprs: string[]) => {
  for (const e of exprs) {
    try {
      new Function(`return (${e});`);
    } catch (err) {
      throw new Error(`cannot log "${e}": ${(err as Error).message}`);
    }
  }
};

export const conditionFor = (id: string, exprs: string[]) =>
  `globalThis.__pitboxJs ? globalThis.__pitboxJs.hit(${JSON.stringify(id)}, [${exprs.map(e => `function () { return (${e}); }`).join(', ')}]) : false`;

/** The bundler path behind a script URL the runtime reports (its host may be any address the device used). */
export const mapPathOf = (scriptUrl: string): string => {
  let p = scriptUrl.replace(/^\w+:\/\/[^/]+/, '');
  if (!p.includes('?')) p = p.replace('//&', '?');
  return p.replace(/\.bundle(?=\?|$)/, '.map');
};

const isBundle = (url: string) => /\.bundle(\?|\/\/&|$)/.test(url);
const isMain = (url: string) => isBundle(url) && !/modulesOnly=true/.test(url);

type Placed = Logpoint & {bps: string[]};

export class JsDebugger {
  readonly #proxy: DevProxy;
  readonly #port: number;
  readonly #reload: () => Promise<unknown>;
  #session?: CdpSession;
  #debuggerOn = false;
  /** Bundle scripts the runtime has parsed in this session, by script id, with when they were parsed. */
  readonly #scripts = new Map<string, {url: string; at: number}>();
  readonly #maps = new Map<string, RawSourceMap>();
  readonly #logpoints = new Map<string, Placed>();
  #seq = 0;
  #timer?: NodeJS.Timeout;
  #replacing?: NodeJS.Timeout;
  #paused = 0;

  constructor(proxy: DevProxy, upstreamPort: number, reload: () => Promise<unknown>) {
    this.#proxy = proxy;
    this.#port = upstreamPort;
    this.#reload = reload;
  }

  async #open(device?: string): Promise<CdpSession> {
    const cur = this.#session;
    if (cur && !cur.closed && (!device || pickPage([cur.page], device))) return cur;
    // An app that was just opened lists its runtime a few seconds later, once its JS has started.
    let pages = await listPages(this.#port);
    for (const end = Date.now() + 10_000; !pages.length && Date.now() < end; ) {
      await new Promise(r => setTimeout(r, 300));
      pages = await listPages(this.#port);
    }
    const page = pickPage(pages, device);
    if (!page) {
      throw new Error(
        pages.length
          ? `no app matches "${device}"; debuggable apps: ${pages.map(p => p.deviceName ?? p.title).join(', ')}`
          : 'no debuggable app: none runs a dev build against this dev server, or its JS has not started yet',
      );
    }
    cur?.close();
    const s = await CdpSession.open(page, this.#port);
    this.#session = s;
    this.#debuggerOn = false;
    this.#scripts.clear();
    s.on(e => this.#event(s, e));
    s.onClose(() => {
      if (this.#session === s) this.#session = undefined;
    });
    return s;
  }

  #event(s: CdpSession, e: CdpEvent) {
    if (s !== this.#session) return;
    if (e.method === 'Debugger.scriptParsed') {
      const url = String(e.params.url ?? '');
      if (!isBundle(url)) return;
      this.#scripts.set(String(e.params.scriptId), {url, at: Date.now()});
      // A reload parses a new main bundle in the same session: the breakpoints of the old one are gone.
      if (isMain(url) && this.#logpoints.size) this.#replaceSoon();
    } else if (e.method === 'Runtime.executionContextsCleared') {
      this.#scripts.clear();
    } else if (e.method === 'Debugger.paused') {
      // pitbox never wants the app stopped: a `debugger` statement or a breakpoint left by someone else is passed.
      this.#paused++;
      void s.send('Debugger.resume').catch(() => undefined);
    }
  }

  #replaceSoon() {
    clearTimeout(this.#replacing);
    this.#replacing = setTimeout(() => void this.#placeAll().catch(() => undefined), 300);
  }

  async #value<T>(s: CdpSession, expression: string, timeoutMs = 10_000): Promise<T> {
    const r = await s.send<{result?: {value?: unknown; description?: string}; exceptionDetails?: {text?: string; exception?: {description?: string}}}>('Runtime.evaluate', {expression, returnByValue: true}, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluation failed');
    return r.result?.value as T;
  }

  /** Evaluates `expr` in the app's global scope (statements allowed); a promise is awaited up to `timeoutMs`. */
  async evaluate(expr: string, device?: string, timeoutMs = 10_000): Promise<EvalResult> {
    const t0 = Date.now();
    const s = await this.#open(device);
    const app = s.page.deviceName ?? s.page.title;
    const apps = (await listPages(this.#port)).length;
    let r = await this.#value<{value?: string; error?: string; pending?: number}>(s, `${HELPER}.run(${JSON.stringify(expr)})`, timeoutMs);
    while (r?.pending !== undefined) {
      if (Date.now() - t0 > timeoutMs) return {error: `the promise did not settle in ${Math.round(timeoutMs / 1000)}s`, app, apps, ms: Date.now() - t0};
      await new Promise(res => setTimeout(res, 100));
      r = await this.#value(s, `${HELPER}.take(${r.pending})`);
    }
    return {value: r?.value, error: r?.error, app, apps, ms: Date.now() - t0};
  }

  async #enableDebugger(s: CdpSession) {
    if (this.#debuggerOn) return;
    await s.send('Debugger.enable');
    this.#debuggerOn = true;
    const end = Date.now() + 3000;
    while (![...this.#scripts.values()].some(x => isMain(x.url)) && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  }

  async #map(scriptUrl: string): Promise<RawSourceMap> {
    const p = mapPathOf(scriptUrl);
    const key = `${this.#proxy.generation}|${p}`;
    const hit = this.#maps.get(key);
    if (hit) return hit;
    const res = await fetch(`http://127.0.0.1:${this.#port}${p}`, {signal: AbortSignal.timeout(120_000)});
    if (!res.ok) throw new Error(`the bundler did not give the source map (${res.status})`);
    const map = (await res.json()) as RawSourceMap;
    this.#maps.clear();
    this.#maps.set(key, map);
    return map;
  }

  /** Sets the logpoint's breakpoint in whichever parsed bundle holds its file (the main one first). */
  async #place(s: CdpSession, lp: Placed) {
    lp.bps = [];
    const scripts = [...this.#scripts.entries()].sort((a, b) => Number(isMain(b[1].url)) - Number(isMain(a[1].url)));
    if (!scripts.length) throw new Error('the app has no bundle loaded yet');
    let lastError: Error | undefined;
    for (const [scriptId, {url}] of scripts) {
      let hit;
      try {
        hit = bundlePosition(await this.#map(url), lp.file, lp.line);
      } catch (e) {
        lastError = e as Error;
        if (/is not in the bundle/.test(lastError.message)) continue;
        throw lastError;
      }
      const r = await s.send<{breakpointId: string; actualLocation?: {lineNumber: number; columnNumber?: number}}>('Debugger.setBreakpoint', {
        location: {scriptId, lineNumber: hit.at.line, columnNumber: hit.at.column},
        condition: conditionFor(lp.id, lp.exprs),
      });
      lp.bps.push(r.breakpointId);
      lp.source = hit.source;
      lp.codeLine = hit.line;
      // The runtime may move the breakpoint to the next statement it can stop at.
      lp.at = r.actualLocation ? {line: r.actualLocation.lineNumber, column: r.actualLocation.columnNumber ?? 0} : hit.at;
      lp.error = undefined;
      return;
    }
    throw lastError ?? new Error(`${lp.file} is not in the running bundle`);
  }

  async #placeAll() {
    const s = this.#session;
    if (!s || s.closed) return;
    await this.#enableDebugger(s);
    await this.#value(s, `${HELPER}, 0`).catch(() => undefined);
    for (const lp of this.#logpoints.values()) {
      try {
        await this.#place(s, lp);
      } catch (e) {
        lp.error = (e as Error).message;
      }
    }
  }

  /** Collects recorded hits from the app; reattaches after the app restarted while logpoints exist. */
  async #tick() {
    if (!this.#logpoints.size) return;
    let s = this.#session;
    if (!s || s.closed) {
      try {
        s = await this.#open();
      } catch {
        return;
      }
      await this.#placeAll().catch(() => undefined);
    }
    const hits = await this.#value<{id: string; at: number; v: string}[]>(s, 'globalThis.__pitboxJs ? globalThis.__pitboxJs.drain() : []', 5000).catch(() => []);
    for (const h of hits ?? []) {
      const lp = this.#logpoints.get(h.id);
      if (!lp) continue;
      lp.count++;
      lp.hits.push({at: h.at, v: h.v});
      if (lp.hits.length > KEEP_HITS) lp.hits.shift();
    }
  }

  #startTimer() {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#tick().catch(() => undefined), 2000);
    this.#timer.unref();
  }

  /**
   * Serves source instead of bytecode while logpoints exist; reloads an app that runs bytecode and waits for its
   * new bundle. Answers whether it reloaded.
   */
  async #ensureSource(device?: string): Promise<boolean> {
    if (!this.#proxy.opts.bytecode) return false;
    this.#proxy.debugSource = true;
    // The app knows best (the in-app script carries how it was served); the proxy's memory is the fallback, and
    // it is empty after a daemon restart.
    let onBytecode = [...this.#proxy.servedKind.values()].includes('bytecode');
    try {
      const fromSource = await this.#value<boolean | null>(await this.#open(device), 'globalThis.__pitbox ? !!globalThis.__pitbox.fromSource : null');
      if (typeof fromSource === 'boolean') onBytecode = !fromSource;
    } catch {
      // no runtime to ask yet
    }
    if (!onBytecode) return false;
    const since = Date.now();
    await this.#reload();
    const end = since + 90_000;
    while (Date.now() < end) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const s = await this.#open(device);
        await this.#enableDebugger(s);
        if ([...this.#scripts.values()].some(x => isMain(x.url) && x.at >= since)) return true;
      } catch {
        // the app is between runtimes
      }
    }
    throw new Error('the app did not come back after the reload to source (logpoints need it); relaunch it and try again');
  }

  async log(at: string, exprs: string[], device?: string): Promise<{logpoint: Logpoint; reloaded: boolean}> {
    const {file, line} = parseAt(at);
    checkExprs(exprs);
    const reloaded = await this.#ensureSource(device);
    const s = await this.#open(device);
    await this.#enableDebugger(s);
    await this.#value(s, `${HELPER}, 0`);
    const lp: Placed = {id: `lp${++this.#seq}`, file, line, exprs, count: 0, hits: [], bps: []};
    try {
      await this.#place(s, lp);
    } catch (e) {
      if (!this.#logpoints.size) this.#proxy.debugSource = false;
      throw e;
    }
    this.#logpoints.set(lp.id, lp);
    this.#startTimer();
    return {logpoint: this.#public(lp), reloaded};
  }

  #public({bps: _bps, ...lp}: Placed): Logpoint {
    return {...lp, hits: [...lp.hits]};
  }

  /** Logpoints with their hits so far (the newest `limit` each). */
  async hits(id?: string, limit = 20): Promise<{logpoints: Logpoint[]; paused: number}> {
    await this.#tick().catch(() => undefined);
    const lps = [...this.#logpoints.values()].filter(lp => !id || lp.id === id);
    if (id && !lps.length) throw new Error(`no logpoint ${id}`);
    return {logpoints: lps.map(lp => ({...this.#public(lp), hits: lp.hits.slice(-limit)})), paused: this.#paused};
  }

  /** Removes one logpoint or all; with none left the app goes back to bytecode on its next start. */
  async clear(id?: string): Promise<{cleared: string[]; bytecodeBack: boolean}> {
    await this.#tick().catch(() => undefined);
    const gone = [...this.#logpoints.values()].filter(lp => !id || lp.id === id);
    if (id && !gone.length) throw new Error(`no logpoint ${id}`);
    const s = this.#session;
    for (const lp of gone) {
      this.#logpoints.delete(lp.id);
      if (s && !s.closed) for (const bp of lp.bps) await s.send('Debugger.removeBreakpoint', {breakpointId: bp}).catch(() => undefined);
    }
    let bytecodeBack = false;
    if (!this.#logpoints.size) {
      clearInterval(this.#timer);
      this.#timer = undefined;
      if (s && !s.closed && this.#debuggerOn) await s.send('Debugger.disable').catch(() => undefined);
      this.#debuggerOn = false;
      bytecodeBack = this.#proxy.debugSource && !!this.#proxy.opts.bytecode;
      this.#proxy.debugSource = false;
    }
    return {cleared: gone.map(lp => lp.id), bytecodeBack};
  }

  get page(): CdpPage | undefined {
    return this.#session?.page;
  }

  stop() {
    clearInterval(this.#timer);
    clearTimeout(this.#replacing);
    this.#timer = undefined;
    this.#logpoints.clear();
    this.#proxy.debugSource = false;
    this.#session?.close();
    this.#session = undefined;
  }
}
