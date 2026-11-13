// The daemon: one per project, HTTP RPC on loopback with a random token, discovered through
// `.pitbox/daemon.json`. It keeps services, actors, mocks and port forwards alive between agent sessions.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {Engine} from './engine.ts';
import {daemonAnswers, resolveProject} from './client.ts';
import {takeOver} from './siblings.ts';
import {withLockAsync} from '../lease/lease.ts';
import {IDLE_MS} from './activity.ts';
import {DAEMON_ACTIVITY, DAEMON_STOP, daemonFile, VERSION, VERSION_HEADER, type DaemonInfo} from './info.ts';

export {DAEMON_STOP, daemonFile, VERSION, type DaemonInfo};





/**
 * One daemon per config: refused while the daemon in the daemon file answers; the other daemons of the config that
 * have run past their start — unreachable, their file overwritten — are stopped first, so this one adopts their device
 * leases (siblings.ts). Runs under the config's start lock (serve), so two daemons starting at once never judge each
 * other unreachable: the second waits, then finds the first answering.
 */
const onlyDaemon = async (file: string, stateDir: string) => {
  let listed: DaemonInfo | undefined;
  try {
    listed = JSON.parse(fs.readFileSync(daemonFile(stateDir), 'utf8')) as DaemonInfo;
  } catch {
    listed = undefined;
  }
  const reachable = listed && listed.pid !== process.pid && (await daemonAnswers(listed)) ? listed.pid : undefined;
  const r = await takeOver(file, reachable);
  if (r.refuse) throw new Error(r.refuse);
  const stamp = new Date().toISOString();
  if (r.stopped.length) process.stderr.write(`${stamp} stopped ${r.stopped.length} other daemon${r.stopped.length > 1 ? 's' : ''} of this config nobody could reach: pid ${r.stopped.join(', ')}\n`);
  if (r.left.length) process.stderr.write(`${stamp} another daemon of this config did not stop on SIGTERM: pid ${r.left.join(', ')}\n`);
  if (r.starting.length) process.stderr.write(`${stamp} another daemon of this config is still starting, left alone: pid ${r.starting.join(', ')}\n`);
};

/** How long a daemon waits for another one of its config to finish starting before it gives up. */
const START_LOCK_WAIT_MS = 90_000;

export const serve = async (configFile?: string) => {
  const project = resolveProject({config: configFile});
  fs.mkdirSync(project.stateDir, {recursive: true});
  // From the check for other daemons until this one's daemon file is written, one start of the config at a time.
  // Not the clients' `daemon` lock: a client holds that while it waits for the daemon it spawned to answer.
  await withLockAsync(path.join(project.stateDir, 'daemon-start'), () => start(configFile, project), START_LOCK_WAIT_MS);
};

const start = async (configFile: string | undefined, project: {file: string; stateDir: string}) => {
  await onlyDaemon(project.file, project.stateDir);
  const engine = await Engine.create(configFile);
  const {stateDir, root, file} = engine.loaded;
  fs.mkdirSync(stateDir, {recursive: true});
  const gitignore = path.join(stateDir, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n');
  const token = crypto.randomBytes(24).toString('hex');

  let shuttingDown = false;
  /** `release`: give the devices back (an explicit stop); any other exit hands them to the next daemon. */
  const shutdown = async (code = 0, release = false) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await engine.stopAll({release}).catch(() => undefined);
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
      if (method === DAEMON_ACTIVITY) {
        res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({ok: true, result: engine.activity.report()}));
        return;
      }
      if (method === DAEMON_STOP) {
        // `pitbox daemon stop|restart` always stops it. Any other stop is a client of another version replacing the
        // daemon — an older pitbox sends no params at all — and waits until no session is at work here.
        const busy = body.params?.by === 'user' ? undefined : engine.activity.busy();
        if (busy) {
          const error = `pitbox daemon ${process.pid} (version ${VERSION}) is in use (${busy}): it is not replaced by another version while a session works with it; it may be once idle for ${IDLE_MS / 60_000} min, or now with \`pitbox daemon restart\``;
          res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({ok: false, error}));
          process.stderr.write(`${new Date().toISOString()} refused a stop from a client of version ${req.headers[VERSION_HEADER] ?? 'unknown'}: ${busy}\n`);
          return;
        }
        res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({ok: true, result: {stopping: true}}));
        // Only a stop that asks for it gives the devices back: an older client's upgrade restart sends no params.
        const release = body.params?.release === true;
        setTimeout(() => void shutdown(0, release), 50);
        return;
      }
      const header = req.headers[VERSION_HEADER];
      const done = engine.activity.begin(method, typeof header === 'string' ? header : undefined);
      let result: unknown;
      try {
        result = await engine.call(method, body.params ?? {});
      } finally {
        done();
      }
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
  // A stray rejection in one request must not take the stand down with it; it goes to the log instead.
  const stamp = () => new Date().toISOString();
  process.on('uncaughtException', e => process.stderr.write(`${stamp()} uncaught: ${e.stack ?? e}
`));
  process.on('unhandledRejection', e => process.stderr.write(`${stamp()} unhandled rejection: ${(e as Error)?.stack ?? e}
`));
  process.on('exit', code => process.stderr.write(`${stamp()} daemon exiting with ${code}
`));
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.stdout.write(`pitbox daemon ${process.pid} on 127.0.0.1:${address.port} for ${root}\n`);
};
