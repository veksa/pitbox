// The in-app script runs inside the app; here it runs in a sandbox with fake XMLHttpRequest and WebSocket.

import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {WebSocket as WsClient} from 'ws';
import {injectInApp, inAppScript} from './devserver/inapp.ts';
import {DevProxy} from './devserver/proxy.ts';
import {freePort} from './util/net.ts';

const cfg = {bundle: 'abc123', gen: 4, platform: 'android', http: 'http://localhost:8081', ws: 'ws://localhost:8081/pitbox/app'};

const sandbox = (opts: {errorUtils?: boolean} = {}) => {
  const sent: string[] = [];
  const sockets: FakeWs[] = [];
  class FakeXhr {
    headers: Record<string, string> = {};
    url = '';
    listeners: Record<string, (() => void)[]> = {};
    status = 200;
    open(_m: string, url: string) {
      this.url = url;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    addEventListener(t: string, f: () => void) {
      (this.listeners[t] ??= []).push(f);
    }
    send() {
      for (const f of this.listeners.loadend ?? []) f();
    }
  }
  class FakeWs {
    static OPEN = 1;
    url: string;
    received: string[] = [];
    onopen?: () => void;
    onmessage?: (e: {data: string}) => void;
    onclose?: () => void;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    send(d: string) {
      sent.push(`${this.url} ${d}`);
    }
    dispatchEvent(ev: {type: string; data?: string}) {
      if (ev.type === 'message') this.received.push(String(ev.data));
      return true;
    }
  }
  const g: Record<string, unknown> = {XMLHttpRequest: FakeXhr, WebSocket: FakeWs, setTimeout, Date, Math, JSON, Array, String, Map, Set};
  if (opts.errorUtils) {
    let handler: ((e: unknown, fatal: boolean) => void) | undefined = () => undefined;
    g.ErrorUtils = {
      setGlobalHandler: (h: typeof handler) => (handler = h),
      getGlobalHandler: () => handler,
      fire: (e: unknown, fatal: boolean) => handler?.(e, fatal),
    };
  }
  g.globalThis = g;
  vm.createContext(g);
  vm.runInContext(inAppScript(cfg), g);
  return {g, sent, sockets, FakeXhr};
};

describe('in-app script', () => {
  it('is spliced in front of the app entry, after runtime initialisation', () => {
    const bundle = Buffer.from('var a=1;\n__d(function(){},0);\n__r(81);\n__r(0);\n//# sourceMappingURL=x');
    const out = injectInApp(bundle, ';INJECTED;\n').toString();
    expect(out).toBe('var a=1;\n__d(function(){},0);\n__r(81);\n;INJECTED;\n__r(0);\n//# sourceMappingURL=x');
  });

  it('introduces itself with the running bundle and answers queries', () => {
    const {sent, sockets} = sandbox();
    const channel = sockets.find(s => s.url === cfg.ws)!;
    channel.onopen!();
    expect(JSON.parse(sent[0]!.split(' ').slice(1).join(' '))).toMatchObject({type: 'hello', bundle: 'abc123', gen: 4, platform: 'android'});
    channel.onmessage!({data: JSON.stringify({type: 'query', what: 'idle', reqId: 7})});
    expect(JSON.parse(sent[1]!.split(' ').slice(1).join(' '))).toMatchObject({type: 'reply', reqId: 7, data: {inflight: 0}});
  });

  it('stamps requests with a traceparent from the daemon and applies fail rules', () => {
    const {g, sockets} = sandbox();
    const channel = sockets.find(s => s.url === cfg.ws)!;
    channel.onmessage!({data: JSON.stringify({type: 'trace', id: 'f'.repeat(32)})});
    const Xhr = g.XMLHttpRequest as new () => {open: (m: string, u: string) => void; send: () => void; headers: Record<string, string>; url: string};
    const a = new Xhr();
    a.open('GET', 'https://api.example.test/feed');
    a.send();
    expect(a.headers.traceparent).toMatch(/^00-f{32}-[0-9a-f]{16}-01$/);
    channel.onmessage!({data: JSON.stringify({type: 'rules', rules: [{id: 'r1', match: '/feed', action: 'fail'}]})});
    const b = new Xhr();
    b.open('GET', 'https://api.example.test/feed');
    expect(b.url).toBe('http://127.0.0.1:9/pitbox-fail');
  });

  it('freezes a socket: it stays open, sends nothing, receives nothing', () => {
    const {g, sockets} = sandbox();
    const channel = sockets.find(s => s.url === cfg.ws)!;
    const Ws = g.WebSocket as new (u: string) => {send: (d: string) => void; dispatchEvent: (e: {type: string; data?: string}) => boolean; received: string[]};
    const app = new Ws('wss://api.example.test/ws');
    app.dispatchEvent({type: 'message', data: 'before'});
    channel.onmessage!({data: JSON.stringify({type: 'rules', rules: [{id: 'r1', kind: 'ws', match: 'api.example.test', action: 'freeze'}]})});
    app.dispatchEvent({type: 'message', data: 'during'});
    channel.onmessage!({data: JSON.stringify({type: 'rules', rules: []})});
    app.dispatchEvent({type: 'message', data: 'after'});
    expect(app.received).toEqual(['before', 'after']);
  });
});

describe('js errors from inside the app', () => {
  it('sees errors before the handler the app installs, passes them on, and sends them once connected', () => {
    const {g, sent, sockets} = sandbox({errorUtils: true});
    const eu = g.ErrorUtils as {setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => void; fire: (e: unknown, fatal: boolean) => void};
    const seen: unknown[] = [];
    eu.setGlobalHandler(e => seen.push(e));
    eu.fire(new Error('early'), true);
    expect(seen).toHaveLength(1);
    const channel = sockets.find(s => s.url === cfg.ws)!;
    (channel as unknown as {readyState: number}).readyState = 1;
    channel.onopen!();
    const msgs = sent.map(x => JSON.parse(x.split(' ').slice(1).join(' ')));
    expect(msgs.find(m => m.type === 'error')).toMatchObject({message: 'early', fatal: true});
    expect(msgs.find(m => m.type === 'error').stack).toContain('early');
  });
});

describe('react tree from inside the app', () => {
  it('lists host components with ids, labels and text, nested', () => {
    const {sockets, sent, g} = sandbox();
    const text = {type: 'RCTText', memoizedProps: {children: 'Get started'}, child: null, sibling: null};
    const button = {type: 'RCTView', memoizedProps: {testID: 'watch', accessibilityLabel: 'Get started'}, child: text, sibling: null};
    const wrapper = {type: () => null, memoizedProps: {}, child: button, sibling: null};
    const screen = {type: 'RCTView', memoizedProps: {testID: 'home'}, child: wrapper, sibling: null};
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {renderers: new Map([[1, {}]]), getFiberRoots: () => new Set([{current: {child: screen}}])};
    const channel = sockets.find(x => x.url === cfg.ws)!;
    channel.onmessage!({data: JSON.stringify({type: 'query', what: 'tree', reqId: 3})});
    const reply = JSON.parse(sent[sent.length - 1]!.split(' ').slice(1).join(' '));
    expect(reply.data.nodes).toEqual([
      {s: 0, d: 0, c: 'View', id: 'home'},
      {s: 0, d: 1, c: 'View', id: 'watch', l: 'Get started'},
      {s: 0, d: 2, c: 'Text', t: 'Get started'},
    ]);
  });
});

describe('proxy with the in-app script', () => {
  let upstream: http.Server;
  let proxy: DevProxy;
  let port: number;
  let version = 'v1';
  const root = path.resolve('/app');

  beforeAll(async () => {
    const upPort = await freePort();
    port = await freePort();
    upstream = http.createServer((req, res) => {
      if (req.url === '/symbolicate') {
        // Stands in for the bundler: names the file after the function and keeps the position it was given.
        let body = '';
        req.on('data', d => (body += d));
        req.on('end', () => {
          const {stack} = JSON.parse(body) as {stack: {methodName: string; lineNumber: number; column: number}[]};
          res.writeHead(200, {'content-type': 'application/json'}).end(
            JSON.stringify({stack: stack.map(f => ({...f, file: path.join(root, 'src', `${f.methodName}.ts`)})), codeFrame: {content: '  1 | x\n\u001b[31m>\u001b[0m 2 | boom()\n'}}),
          );
        });
        return;
      }
      res.writeHead(200, {'content-type': 'application/javascript'}).end(`var v="${version}";\n__r(1);\n__r(0);`);
    });
    await new Promise<void>(r => upstream.listen(upPort, '127.0.0.1', () => r()));
    proxy = new DevProxy({port, upstreamPort: upPort, inApp: true, root});
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    upstream.closeAllConnections();
    upstream.close();
  });

  it('injects into the native main bundle only, and tracks which bundle each app runs', async () => {
    const main = await (await fetch(`http://127.0.0.1:${port}/index.bundle?platform=android`, {headers: {accept: 'multipart/mixed'}})).text();
    expect(main).toContain('__pitbox');
    expect(main.indexOf('__pitbox')).toBeLessThan(main.indexOf('__r(0)'));
    const lazy = await (await fetch(`http://127.0.0.1:${port}/x.bundle?platform=android&modulesOnly=true`)).text();
    expect(lazy).not.toContain('__pitbox');

    const bundle = proxy.latest.get('android')!;
    const ws = new WsClient(`ws://127.0.0.1:${port}/pitbox/app`);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({type: 'hello', bundle, gen: 0, platform: 'android', startedAt: Date.now()}));
    ws.on('message', d => {
      const m = JSON.parse(String(d));
      if (m.type === 'query') ws.send(JSON.stringify({type: 'reply', reqId: m.reqId, data: {inflight: 2}}));
    });
    await new Promise(r => setTimeout(r, 100));
    expect(proxy.apps()[0]?.hello?.bundle).toBe(bundle);
    expect((await proxy.query<{inflight: number}>('idle'))[0]?.data.inflight).toBe(2);

    // Frames: one above the in-app script, one inside it (pitbox's own, dropped), one below it (shifted back).
    const scriptLines = inAppScript({...cfg, bundle, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/pitbox/app`}).split('\n').length - 1;
    const url = `http://127.0.0.1:${port}/index.bundle?platform=android`;
    const stack = ['Error: boom', `    at above (${url}:1:5)`, `    at inside (${url}:4:1)`, `    at below (address at ${url}:${3 + scriptLines}:2)`, '    at apply (native)'].join('\n');
    const t0 = Date.now();
    ws.send(JSON.stringify({type: 'error', message: 'boom', name: 'TypeError', stack, fatal: true}));
    await new Promise(r => setTimeout(r, 100));
    const [e] = await proxy.errorsSince(t0);
    expect(e).toMatchObject({message: 'TypeError: boom', fatal: true, symbolicated: true, code: '2 | boom()'});
    expect(e!.frames).toEqual(['above  src/above.ts:1:5', 'below  src/below.ts:3:2']);

    version = 'v2';
    await fetch(`http://127.0.0.1:${port}/index.bundle?platform=android`, {headers: {accept: 'multipart/mixed'}});
    expect(proxy.latest.get('android')).not.toBe(bundle);
    ws.close();
  });
});
