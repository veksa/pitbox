// A Chrome DevTools Protocol client for the JS runtime of an app, through the dev server's inspector proxy
// (`/json/list` lists the debuggable pages, `/inspector/debug` carries a session to one of them). Recent React
// Native pages accept several debuggers at once, so pitbox's session does not push out a person's DevTools; on
// older ones the newer connection wins.

import {WebSocket} from 'ws';

export type CdpPage = {
  id: string;
  title: string;
  appId?: string;
  deviceName?: string;
  description?: string;
  webSocketDebuggerUrl: string;
  reactNative?: {logicalDeviceId?: string; capabilities?: Record<string, boolean>};
};

/** The pages the bundler's inspector proxy knows, newest last. Empty when the bundler has none or no proxy. */
export const listPages = async (port: number, timeoutMs = 3000): Promise<CdpPage[]> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(timeoutMs)});
    if (!res.ok) return [];
    const pages = (await res.json()) as CdpPage[];
    // The proxy adds a synthetic "reloadable" page for legacy runtimes; it is not a runtime of its own.
    return Array.isArray(pages) ? pages.filter(p => p.webSocketDebuggerUrl && !/don't use/.test((p as {vm?: string}).vm ?? '')) : [];
  } catch {
    return [];
  }
};

/** A page for `device` (a substring of its device name or title), or the newest one. */
export const pickPage = (pages: CdpPage[], device?: string): CdpPage | undefined => {
  if (!device) return pages[pages.length - 1];
  const d = device.toLowerCase();
  const named = pages.filter(p => `${p.deviceName ?? ''} ${p.title}`.toLowerCase().includes(d));
  // A device serial (emulator-5554) is not in the page's name. With every page on one device (one app, or a
  // relaunch whose old runtime is still listed) the newest is the one; across devices there is no guessing.
  if (named.length) return named[named.length - 1];
  return new Set(pages.map(p => p.deviceName ?? p.title)).size === 1 ? pages[pages.length - 1] : undefined;
};

export type CdpEvent = {method: string; params: Record<string, unknown>};

export class CdpError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

export class CdpSession {
  readonly page: CdpPage;
  readonly #ws: WebSocket;
  #seq = 0;
  readonly #pending = new Map<number, {resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout}>();
  readonly #listeners = new Set<(e: CdpEvent) => void>();
  readonly #onClose = new Set<() => void>();
  #closed = false;

  private constructor(page: CdpPage, ws: WebSocket) {
    this.page = page;
    this.#ws = ws;
    ws.on('message', raw => {
      let msg: {id?: number; result?: Record<string, unknown>; error?: {message?: string; code?: number}; method?: string; params?: Record<string, unknown>};
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new CdpError(msg.error.message ?? 'CDP error', msg.error.code));
        else p.resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const l of this.#listeners) l({method: msg.method, params: msg.params ?? {}});
      }
    });
    const closed = () => {
      if (this.#closed) return;
      this.#closed = true;
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(new CdpError('the app\'s debugger connection closed (the app stopped or reloaded)'));
      }
      this.#pending.clear();
      for (const f of this.#onClose) f();
    };
    ws.on('close', closed);
    ws.on('error', closed);
  }

  /**
   * Opens a session. The bundler only takes debugger connections from an origin it trusts, as a browser would
   * send; Node sends none, so it is set here. React Native's inspector rejects (401) an origin that is neither its
   * own address nor a local host name; Expo's accepts and then drops any origin whose host and port differ from the
   * address it was told it is served at (the proxy's). So the first origin is the one devices use, and a 401 tries
   * the next.
   */
  static async open(page: CdpPage, port: number, timeoutMs = 5000, origins = [`http://localhost:${port}`]): Promise<CdpSession> {
    const url = page.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`);
    let last = '';
    for (const origin of origins) {
      const ws = new WebSocket(url, {origin, handshakeTimeout: timeoutMs});
      const r = await new Promise<CdpSession | string>(resolve => {
        ws.once('open', () => resolve(new CdpSession(page, ws)));
        ws.once('unexpected-response', (_req, res) => {
          resolve(`the bundler refused origin ${origin} (${res.statusCode})`);
          ws.terminate();
        });
        ws.once('error', e => resolve(e.message));
      });
      if (typeof r !== 'string') return r;
      last = r;
    }
    throw new CdpError(`cannot open the app's debugger: ${last}`);
  }

  get closed() {
    return this.#closed;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (this.#closed) return Promise.reject(new CdpError('the app\'s debugger connection is closed'));
    const id = ++this.#seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(`${method}: no answer from the app in ${Math.round(timeoutMs / 1000)}s (paused or busy?)`));
      }, timeoutMs);
      this.#pending.set(id, {resolve: r => resolve(r as T), reject, timer});
      this.#ws.send(JSON.stringify({id, method, params}));
    });
  }

  on(listener: (e: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(f: () => void) {
    this.#onClose.add(f);
  }

  close() {
    this.#ws.close();
  }
}
