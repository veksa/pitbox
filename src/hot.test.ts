// The bundler's hot-update channel through pitbox's proxy: an app on bytecode registers the eager graph its
// bytecode came from (otherwise the bundler finds no graph and hot updates stop without a word), and every
// round and compile error is seen on the way.

import http from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {WebSocket as WsClient, WebSocketServer, type WebSocket} from 'ws';
import {DevProxy} from './devserver/proxy.ts';
import {freePort} from './util/net.ts';

const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 20));
};

describe('hot updates through the proxy', () => {
  let port: number;
  let upstream: http.Server;
  let proxy: DevProxy;
  const got: unknown[] = [];
  let bundler: WebSocket | undefined;

  beforeAll(async () => {
    port = await freePort();
    const upPort = await freePort();
    upstream = http.createServer((_q, s) => s.end());
    const wss = new WebSocketServer({server: upstream, path: '/hot'});
    wss.on('connection', ws => {
      bundler = ws;
      ws.on('message', d => got.push(JSON.parse(String(d))));
    });
    await new Promise<void>(r => upstream.listen(upPort, '127.0.0.1', () => r()));
    proxy = new DevProxy({port, upstreamPort: upPort, root: 'C:\\work\\app'});
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    upstream.closeAllConnections();
    upstream.close();
  });

  const round = (msgs: object[]) => {
    for (const m of msgs) bundler!.send(JSON.stringify(m));
  };

  it('points a bytecode app at the eager graph, and follows rounds and compile errors', async () => {
    proxy.servedKind.set('android', 'bytecode');
    const app = new WsClient(`ws://127.0.0.1:${port}/hot`);
    const seen: {type: string}[] = [];
    app.on('message', d => seen.push(JSON.parse(String(d))));
    await new Promise(r => app.on('open', r));
    // Sent at once, before the proxy has its own connection to the bundler: queued, not lost.
    app.send(JSON.stringify({type: 'register-entrypoints', entryPoints: ['http://localhost:8081/index.bundle?platform=android&dev=true&lazy=true']}));
    app.send(JSON.stringify({type: 'log', level: 'log', data: ['hi']}));
    await until(() => got.length === 2);
    expect(got).toEqual([
      {type: 'register-entrypoints', entryPoints: ['http://localhost:8081/index.bundle?platform=android&dev=true&lazy=false']},
      {type: 'log', level: 'log', data: ['hi']},
    ]);

    round([{type: 'update-start', body: {isInitialUpdate: true}}, {type: 'update', body: {isInitialUpdate: true, added: [], modified: [], deleted: []}}, {type: 'update-done', body: {}}, {type: 'bundle-registered'}]);
    await until(() => seen.length === 4);
    expect(proxy.hotClients()[0]).toMatchObject({platform: 'android', eager: true, registered: true, updates: 0, inRound: false});

    round([{type: 'update-start', body: {isInitialUpdate: false}}, {type: 'update', body: {isInitialUpdate: false, added: [], modified: [[1, 'code']], deleted: []}}, {type: 'update-done', body: {}}]);
    await until(() => seen.length === 7);
    expect(proxy.hotClients()[0]).toMatchObject({updates: 1, lastUpdate: {modules: 1}});
    expect(proxy.hotClients()[0]!.lastError).toBeUndefined();

    // The bundler ends a failed round with update-done too: the error stays until a round compiles.
    round([
      {type: 'update-start', body: {isInitialUpdate: false}},
      {type: 'error', body: {type: 'TransformError', message: 'SyntaxError: C:\\work\\app\\App.tsx: Unexpected token (34:6)\n\x1b[0m> 34 | </Text>'}},
      {type: 'update-done', body: {}},
    ]);
    await until(() => seen.length === 10);
    expect(proxy.hotClients()[0]!.lastError).toEqual({at: expect.any(Number), type: 'TransformError', message: 'SyntaxError: App.tsx: Unexpected token (34:6)\n> 34 | </Text>'});

    round([{type: 'update-start', body: {isInitialUpdate: false}}, {type: 'update', body: {isInitialUpdate: false, added: [], modified: [], deleted: []}}, {type: 'update-done', body: {}}]);
    await until(() => seen.length === 13);
    expect(proxy.hotClients()[0]).toMatchObject({updates: 1});
    expect(proxy.hotClients()[0]!.lastError).toBeUndefined();
    app.close();
    await until(() => !!proxy.hotClients()[0]!.closedAt);
  });

  it('leaves the registration of an app on source as it is', async () => {
    proxy.servedKind.set('android', 'source');
    got.length = 0;
    const app = new WsClient(`ws://127.0.0.1:${port}/hot`);
    await new Promise(r => app.on('open', r));
    app.send(JSON.stringify({type: 'register-entrypoints', entryPoints: ['http://localhost:8081/index.bundle?platform=android&lazy=true']}));
    await until(() => got.length === 1);
    expect(got[0]).toEqual({type: 'register-entrypoints', entryPoints: ['http://localhost:8081/index.bundle?platform=android&lazy=true']});
    app.close();
  });
});
