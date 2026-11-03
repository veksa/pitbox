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

const sandbox = (opts: {errorUtils?: boolean; console?: Record<string, (...a: unknown[]) => void>} = {}) => {
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
  if (opts.console) g.console = opts.console;
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
    // With a status, the failure is an HTTP answer from the dev server.
    channel.onmessage!({data: JSON.stringify({type: 'rules', rules: [{id: 'r2', match: '/feed', action: 'fail', status: 503}]})});
    const c = new Xhr();
    c.open('GET', 'https://api.example.test/feed');
    expect(c.url).toBe(`${cfg.http}/pitbox/mock/r2`);
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

describe('the app console', () => {
  const reply = (sent: string[]) => JSON.parse(sent[sent.length - 1]!.split(' ').slice(1).join(' ')).data as {l: string; m: string; stack?: string}[];

  it('keeps what the app logged as text, warnings with their stack, and still prints it', () => {
    const printed: unknown[][] = [];
    const print = (...a: unknown[]) => void printed.push(a);
    const {g, sent, sockets} = sandbox({console: {log: print, warn: print, error: print}});
    const c = g.console as Record<string, (...a: unknown[]) => void>;
    c.log!('user', {id: 7, tags: ['a']});
    c.warn!('Deprecated %s, use %s', 'foo', 'bar');
    c.error!('%d%% done', 42.5);
    expect(printed).toHaveLength(3);
    sockets.find(s => s.url === cfg.ws)!.onmessage!({data: JSON.stringify({type: 'query', what: 'console', reqId: 1})});
    const entries = reply(sent);
    expect(entries.map(e => [e.l, e.m])).toEqual([
      ['log', 'user {id: 7, tags: ["a"]}'],
      ['warn', 'Deprecated foo, use bar'],
      ['error', '42% done'],
    ]);
    expect(entries[0]!.stack).toBeUndefined();
    expect(entries[1]!.stack).toMatch(/Error/);
  });

  it('keeps the newest 300 entries', () => {
    const {g, sent, sockets} = sandbox({console: {log: () => undefined}});
    const c = g.console as Record<string, (...a: unknown[]) => void>;
    for (let i = 0; i < 305; i++) c.log!(`n ${i}`);
    sockets.find(s => s.url === cfg.ws)!.onmessage!({data: JSON.stringify({type: 'query', what: 'console', reqId: 2})});
    const entries = reply(sent);
    expect(entries).toHaveLength(300);
    expect(entries[0]!.m).toBe('n 5');
  });
});

describe('react commits', () => {
  type Fiber = {tag: number; type: unknown; flags: number; actualDuration: number; memoizedProps?: unknown; memoizedState?: unknown; alternate?: Fiber | null; child?: Fiber | null; sibling?: Fiber | null};
  const fiber = (f: Partial<Fiber> & {type: unknown}): Fiber => ({tag: 0, flags: 0, actualDuration: 0, alternate: null, child: null, sibling: null, ...f});

  it('counts the components a commit rendered, their own time and why, and skips subtrees React left alone', () => {
    const commits: unknown[] = [];
    const hook = {onCommitFiberRoot: (_id: number, root: unknown) => void commits.push(root)};
    const {g, sent, sockets} = sandbox();
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    const channel = sockets.find(s => s.url === cfg.ws)!;
    const ask = (q: object) => {
      channel.onmessage!({data: JSON.stringify({type: 'query', what: 'renders', reqId: 9, ...q})});
      return JSON.parse(sent[sent.length - 1]!.split(' ').slice(1).join(' ')).data;
    };
    expect(ask({start: true})).toEqual({started: true, react: true});

    function Main() {}
    function Row() {}
    function Button() {}
    const onPress = () => undefined;
    // An untouched subtree: the same child object as before, with flags left from the commit that mounted it.
    const staleRow = fiber({type: Row, flags: 1, actualDuration: 9});
    const listPrev = fiber({type: 'RCTScrollView', child: staleRow});
    const list = fiber({type: 'RCTScrollView', child: staleRow, alternate: listPrev});
    // Main's state hook changed; its button got a new onPress; the other button got equal props.
    const prevHooks = {memoizedState: 'a', next: {memoizedState: {create: 1, deps: []}, next: null}};
    const hooks = {memoizedState: 'b', next: {memoizedState: {create: 2, deps: []}, next: null}};
    const b1Prev = fiber({type: Button, memoizedProps: {title: 'Go', onPress: () => undefined}});
    const b1 = fiber({type: Button, flags: 1, actualDuration: 1, memoizedProps: {title: 'Go', onPress}, alternate: b1Prev});
    const b2Prev = fiber({type: Button, memoizedProps: {title: 'Stop'}});
    const b2 = fiber({type: Button, flags: 1, actualDuration: 0.5, memoizedProps: {title: 'Stop'}, alternate: b2Prev});
    b1.sibling = b2;
    b2.sibling = list;
    const mainPrev = fiber({type: Main, memoizedProps: {}, memoizedState: prevHooks, child: b1Prev});
    const main = fiber({type: Main, flags: 1, actualDuration: 4, memoizedProps: mainPrev.memoizedProps, memoizedState: hooks, child: b1, alternate: mainPrev});
    const rootPrev = fiber({tag: 3, type: null, child: mainPrev});
    const root = {current: fiber({tag: 3, type: null, actualDuration: 4, child: main, alternate: rootPrev})};
    (g.__REACT_DEVTOOLS_GLOBAL_HOOK__ as typeof hook).onCommitFiberRoot(1, root);
    // A mount: no previous fiber.
    const mounted = {current: fiber({tag: 3, type: null, actualDuration: 2, child: fiber({type: Row, flags: 1, actualDuration: 2})})};
    (g.__REACT_DEVTOOLS_GLOBAL_HOOK__ as typeof hook).onCommitFiberRoot(1, mounted);
    expect(commits).toHaveLength(2);

    const r = ask({stop: true});
    expect(r).toMatchObject({commits: 2, renderMs: 6, components: 3});
    const by = Object.fromEntries((r.shown as {name: string; n: number; ms: number; why: [string, number][]}[]).map(c => [c.name, c]));
    expect(by.Main).toEqual({name: 'Main', n: 1, ms: 2.5, why: [['state', 1]]});
    expect(by.Button).toMatchObject({n: 2, ms: 1.5});
    expect(Object.fromEntries(by.Button!.why)).toEqual({'props onPress': 1, 'parent rendered, same props': 1});
    expect(by.Row).toEqual({name: 'Row', n: 1, ms: 2, why: [['mount', 1]]});
    expect(ask({stop: true})).toEqual({error: 'no React measurement running'});
  });

  it('measures the JS heap over the window, also without React', () => {
    const {g, sent, sockets} = sandbox();
    let stats = {js_allocatedBytes: 4_000_000, js_totalAllocatedBytes: 10_000_000, js_numGCs: 2, js_gcTime: 0.004};
    g.HermesInternal = {getInstrumentedStats: () => stats};
    const channel = sockets.find(s => s.url === cfg.ws)!;
    const ask = (q: object) => {
      channel.onmessage!({data: JSON.stringify({type: 'query', what: 'renders', reqId: 3, ...q})});
      return JSON.parse(sent[sent.length - 1]!.split(' ').slice(1).join(' ')).data;
    };
    expect(ask({start: true})).toEqual({started: true, react: false});
    stats = {js_allocatedBytes: 5_000_000, js_totalAllocatedBytes: 13_000_000, js_numGCs: 5, js_gcTime: 0.0105};
    expect(ask({stop: true})).toMatchObject({react: false, commits: 0, heap: {liveBefore: 4_000_000, liveAfter: 5_000_000, allocated: 3_000_000, gcs: 3, gcMs: 6.5}});
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
    proxy = new DevProxy({port, upstreamPort: upPort, inApp: true, root, pingMs: 100});
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

  it('drops an app session that stops answering pings, keeps one that answers', async () => {
    // Sessions an earlier test closed are gone first.
    await new Promise(r => setTimeout(r, 300));
    const before = proxy.apps().length;
    const live = new WsClient(`ws://127.0.0.1:${port}/pitbox/app`);
    // A dead app behind a relay: the socket stays open on the host and nothing answers.
    const dead = new WsClient(`ws://127.0.0.1:${port}/pitbox/app`, {autoPong: false});
    await Promise.all([new Promise(r => live.on('open', r)), new Promise(r => dead.on('open', r))]);
    await new Promise(r => setTimeout(r, 50));
    expect(proxy.apps().length).toBe(before + 2);
    await new Promise(r => setTimeout(r, 400));
    expect(proxy.apps().length).toBe(before + 1);
    live.close();
    dead.terminate();
  });

  it('times an app start: the bundle request, then when the bundle started running', async () => {
    expect(await proxy.startAfter(Date.now(), 200, 200)).toEqual({});
    const t0 = Date.now();
    await fetch(`http://127.0.0.1:${port}/index.bundle?platform=android`, {headers: {accept: 'multipart/mixed'}});
    const started = proxy.startAfter(t0, 2000, 2000);
    const ws = new WsClient(`ws://127.0.0.1:${port}/pitbox/app`);
    await new Promise(r => ws.on('open', r));
    // The bundle starts running after the launch, so the 40 ms it reports must not reach back before t0.
    await new Promise(r => setTimeout(r, 60));
    const sent = Date.now();
    ws.send(JSON.stringify({type: 'hello', bundle: 'x', gen: 0, platform: 'android', startedAt: 0, sinceStart: 40}));
    const r = await started;
    expect(r.bundle?.kind).toBe('source');
    expect(r.runningAt).toBeLessThanOrEqual(Date.now() - 40);
    expect(r.runningAt).toBeGreaterThanOrEqual(sent - 40);
    ws.close();
  });
});
