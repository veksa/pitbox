// The daemon: one per project, HTTP RPC on loopback with a random token, discovered through
// `.pitbox/daemon.json`. It keeps services, actors, mocks and port forwards alive between agent sessions.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {Engine} from './engine.ts';
import {DAEMON_STOP, daemonFile, VERSION, type DaemonInfo} from './info.ts';

export {DAEMON_STOP, daemonFile, VERSION, type DaemonInfo};





export const serve = async (configFile?: string) => {
  const engine = await Engine.create(configFile);
  const {stateDir, root, file} = engine.loaded;
  fs.mkdirSync(stateDir, {recursive: true});
  const gitignore = path.join(stateDir, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n');
  const token = crypto.randomBytes(24).toString('hex');

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await engine.stopAll().catch(() => undefined);
    try {
      const info = JSON.parse(fs.readFileSync(daemonFile(stateDir), 'utf8')) as DaemonInfo;
      if (info.pid === process.pid) fs.unlinkSync(daemonFile(stateDir));
    } catch {
      // already gone
    }
    process.exit(code);
  };

  const server = http.createServer(async (req, res) => {
    if (req.headers['x-pitbox-token'] !== token) {
      res.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let method = '';
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {method: string; params?: Record<string, unknown>};
      method = body.method;
      if (method === DAEMON_STOP) {
        res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({ok: true, result: {stopping: true}}));
        setTimeout(() => void shutdown(0), 50);
        return;
      }
      const result = await engine.call(method, body.params ?? {});
      res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({ok: true, result}));
    } catch (e) {
      res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({ok: false, error: (e as Error).message}));
    }
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('daemon failed to listen');
  const info: DaemonInfo = {pid: process.pid, port: address.port, token, config: file, root, startedAt: Date.now(), version: VERSION};
  fs.writeFileSync(daemonFile(stateDir), JSON.stringify(info, null, 2));
  engine.startWatching();
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.stdout.write(`pitbox daemon ${process.pid} on 127.0.0.1:${address.port} for ${root}\n`);
};
