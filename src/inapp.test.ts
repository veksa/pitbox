// The in-app script runs inside the app; here it runs in a sandbox with fake XMLHttpRequest and WebSocket.

import http from 'node:http';
import vm from 'node:vm';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {WebSocket as WsClient} from 'ws';
import {injectInApp, inAppScript} from './devserver/inapp.ts';
import {DevProxy} from './devserver/proxy.ts';
import {freePort} from './util/net.ts';

const cfg = {bundle: 'abc123', gen: 4, platform: 'android', http: 'http://localhost:8081', ws: 'ws://localhost:8081/pitbox/app'};

const sandbox = () => {
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
  const g: Record<string, unknown> = {XMLHttpRequest: FakeXhr, WebSocket: FakeWs, setTimeout, Date, Math, JSON, Array, String};
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

describe('proxy with the in-app script', () => {
  let upstream: http.Server;
  let proxy: DevProxy;
  let port: number;
  let version = 'v1';

  beforeAll(async () => {
    const upPort = await freePort();
    port = await freePort();
    upstream = http.createServer((_req, res) => res.writeHead(200, {'content-type': 'application/javascript'}).end(`var v="${version}";\n__r(1);\n__r(0);`));
    await new Promise<void>(r => upstream.listen(upPort, '127.0.0.1', () => r()));
    proxy = new DevProxy({port, upstreamPort: upPort, inApp: true});
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

    version = 'v2';
    await fetch(`http://127.0.0.1:${port}/index.bundle?platform=android`, {headers: {accept: 'multipart/mixed'}});
    expect(proxy.latest.get('android')).not.toBe(bundle);
    ws.close();
  });
});
