// Dev server pieces against fakes: the watcher patch in a child process, the proxy in front of a fake bundler.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {BytecodeCache} from './devserver/hermes.ts';
import {DevProxy, eagerUrl, isNativeBundleRequest} from './devserver/proxy.ts';
import {freePort} from './util/net.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-dev-'));

describe('watcher patch', () => {
  it('allows the native watcher of a file map package that hides it behind exports', () => {
    const pkg = path.join(dir, 'app', 'node_modules', 'metro-file-map');
    fs.mkdirSync(path.join(pkg, 'src', 'watchers'), {recursive: true});
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name: 'metro-file-map', main: 'src/index.js', exports: {'.': './src/index.js'}}));
    fs.writeFileSync(path.join(pkg, 'src', 'watchers', 'NativeWatcher.js'), `"use strict";\nclass NativeWatcher { static isSupported() { return require('os').platform() === 'darwin'; } }\nexports.default = NativeWatcher;\n`);
    fs.writeFileSync(path.join(pkg, 'src', 'index.js'), `exports.supported = () => require('./watchers/NativeWatcher').default.isSupported();\n`);
    const preload = pathToFileURL(path.resolve('src/devserver/preload.ts')).href;
    const out = execFileSync(process.execPath, ['--import', preload, '-e', "console.log(require('metro-file-map').supported())"], {cwd: path.join(dir, 'app'), encoding: 'utf8'}).trim();
    expect(out).toBe('true');
  });

  it('drops recursive watch events that carry no file name instead of passing them to the bundler', () => {
    const preload = pathToFileURL(path.resolve('src/devserver/preload.ts')).href;
    const script = [
      "const fs = require('fs');",
      "const seen = [];",
      "const w = fs.watch(process.cwd(), {recursive: true}, (type, name) => seen.push(name));",
      "w.emit('change', 'rename', null);",
      "w.emit('change', 'change', 'a.js');",
      "w.close();",
      "console.log(JSON.stringify(seen));",
    ].join(' ');
    const out = execFileSync(process.execPath, ['--import', preload, '-e', script], {cwd: dir, encoding: 'utf8'}).trim();
    expect(JSON.parse(out)).toEqual(process.platform === 'win32' ? ['a.js'] : [null, 'a.js']);
  });
});

describe('bundle request rules', () => {
  it('converts only the native main bundle request', () => {
    expect(isNativeBundleRequest('GET', '/index.bundle?platform=android&dev=true', 'multipart/mixed')).toBe(true);
    expect(isNativeBundleRequest('GET', '/en.bundle?platform=android&modulesOnly=true', 'multipart/mixed')).toBe(false);
    expect(isNativeBundleRequest('GET', '/index.bundle?platform=android', undefined)).toBe(false);
    expect(isNativeBundleRequest('GET', '/status', 'multipart/mixed')).toBe(false);
    expect(eagerUrl('/a.bundle?platform=android&lazy=true&dev=true')).toBe('/a.bundle?platform=android&lazy=false&dev=true');
  });
});

describe('proxy', () => {
  let upstream: http.Server;
  let proxy: DevProxy;
  let port: number;
  let compiles = 0;
  const seen: string[] = [];

  beforeAll(async () => {
    const upPort = await freePort();
    port = await freePort();
    upstream = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      if (req.url === '/status') return void res.end('packager-status:running');
      if (req.url?.startsWith('/broken.bundle')) return void res.writeHead(500, {'content-type': 'application/json'}).end('{"message":"syntax error"}');
      if (req.url?.includes('.bundle')) return void res.writeHead(200, {'content-type': 'application/javascript'}).end(`var src = ${JSON.stringify(req.url)};`);
      res.writeHead(404).end();
    });
    upstream.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', d => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
    });
    await new Promise<void>(r => upstream.listen(upPort, '127.0.0.1', () => r()));
    proxy = new DevProxy({
      port,
      upstreamPort: upPort,
      bytecode: {
        compile: async src => {
          compiles++;
          return Buffer.concat([Buffer.from('HBC:'), src]);
        },
        cache: new BytecodeCache(path.join(dir, 'cache')),
      },
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    upstream.closeAllConnections();
    upstream.close();
  });

  const get = (url: string, accept?: string) =>
    fetch(`http://127.0.0.1:${port}${url}`, {headers: accept ? {accept} : {}}).then(async r => ({status: r.status, body: await r.text()}));

  it('never makes the device wait for a compile: source first, bytecode from cache once it is ready', async () => {
    const a = await get('/main.bundle?platform=android&lazy=true', 'multipart/mixed');
    expect(a.status).toBe(200);
    expect(a.body).toBe('var src = "/main.bundle?platform=android&lazy=false";');
    await proxy.whenIdle();
    const b = await get('/main.bundle?platform=android&lazy=true', 'multipart/mixed');
    expect(b.body).toBe('HBC:var src = "/main.bundle?platform=android&lazy=false";');
    const c = await get('/main.bundle?platform=android&lazy=true', 'multipart/mixed');
    expect(c.body).toBe(b.body);
    expect(compiles).toBe(1);
    expect(proxy.stats.cacheHits).toBeGreaterThanOrEqual(1);
    expect(proxy.mainUrls.get('android')).toBe('/main.bundle?platform=android&lazy=true');
  });

  it('rechecks the source after a file change but does not recompile identical output', async () => {
    const before = seen.length;
    proxy.generation++;
    await get('/main.bundle?platform=android&lazy=true', 'multipart/mixed');
    expect(seen.length).toBe(before + 1);
    expect(compiles).toBe(1);
  });

  it('passes lazy bundles and other requests through as they are', async () => {
    const lazy = await get('/en.bundle?platform=android&modulesOnly=true&lazy=true');
    expect(lazy.body).toBe('var src = "/en.bundle?platform=android&modulesOnly=true&lazy=true";');
    expect((await get('/status')).body).toBe('packager-status:running');
    expect(proxy.stats.requests.some(r => r.kind === 'lazy')).toBe(true);
  });

  it('relays bundler errors instead of compiling them', async () => {
    const r = await get('/broken.bundle?platform=android', 'multipart/mixed');
    expect(r.status).toBe(500);
    expect(r.body).toContain('syntax error');
  });

  it('pipes websocket upgrades both ways', async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write('GET /message HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      });
      let buf = '';
      s.on('data', d => {
        buf += d.toString();
        if (buf.includes('101') && !buf.includes('echo:')) s.write('ping');
        if (buf.includes('echo:ping')) {
          s.destroy();
          resolve(buf);
        }
      });
      s.on('error', reject);
    });
    expect(reply).toContain('echo:ping');
  });
});
