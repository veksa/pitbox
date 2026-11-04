// The CLI finds the project's daemon: a busy one is waited for, never doubled by a second daemon.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {connect} from './daemon/client.ts';
import {daemonFile, VERSION} from './daemon/info.ts';

const project = (port: number) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-client-'));
  fs.writeFileSync(path.join(dir, 'pitbox.config.json'), '{}');
  fs.mkdirSync(path.join(dir, '.pitbox'));
  // This test process stands in for the daemon: alive, and listening on `port`.
  fs.writeFileSync(daemonFile(path.join(dir, '.pitbox')), JSON.stringify({pid: process.pid, port, token: 't', config: '', root: dir, startedAt: Date.now(), version: '0'}));
  return path.join(dir, 'pitbox.config.json');
};

describe('finding the daemon', () => {
  it('waits for a daemon that is alive but slow to answer instead of starting a second one', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      setTimeout(() => res.end(JSON.stringify({ok: true, result: 'pong'})), 4000);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as {port: number}).port;
    try {
      const c = await connect({config: project(port)});
      expect(c.info.port).toBe(port);
    } finally {
      server.close();
    }
  }, 30_000);

  it('says so when a live daemon never answers', async () => {
    const server = http.createServer(req => req.resume());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as {port: number}).port;
    try {
      await expect(connect({config: project(port), busyWaitMs: 1000})).rejects.toThrow(/is running but has not answered/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 30_000);
});

describe('version', () => {
  it('is the package version, not a placeholder', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {version: string};
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe('0.0.0');
  });
});
