// Network probes and free-port lookup.

import fs from 'node:fs';
import net from 'node:net';
import {run} from './proc.ts';

export const tcpOpen = (port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> =>
  new Promise(resolve => {
    const socket = net.connect({port, host});
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

/**
 * Whether something already accepts connections on the port over loopback, IPv4 or IPv6. On macOS and the BSDs a
 * listener on 127.0.0.1 binds beside another process's on the wildcard address (`::`, `0.0.0.0`) with no
 * EADDRINUSE, and from then on takes every loopback connection meant for it: a successful bind proves nothing.
 */
export const portAnswers = async (port: number): Promise<boolean> => (await tcpOpen(port, '127.0.0.1', 500)) || (await tcpOpen(port, '::1', 500));

/** Throws EADDRINUSE when something answers on the port: called before a listen, which would not say so. */
export const assertPortFree = async (port: number): Promise<void> => {
  if (port && (await portAnswers(port))) throw Object.assign(new Error(`listen EADDRINUSE: port ${port} already answers`), {code: 'EADDRINUSE'});
};

/** The process listening on a TCP port and its working folder, where the system can tell (lsof). */
export const portListener = async (port: number): Promise<{pid: number; cwd?: string} | undefined> => {
  if (process.platform === 'win32') return undefined;
  const r = await run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {timeoutMs: 10_000});
  const pid = Number(r.stdout.split('\n')[0]?.trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const c = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {timeoutMs: 10_000});
  const cwd = c.stdout.split('\n').find(l => l.startsWith('n'))?.slice(1);
  return {pid, cwd: cwd ? realOrSame(cwd) : undefined};
};

const realOrSame = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** Whether a folder is `root` or inside it, both resolved through symlinks. */
export const withinFolder = (dir: string, root: string): boolean => {
  const d = realOrSame(dir);
  const r = realOrSame(root);
  return d === r || d.startsWith(r.endsWith('/') ? r : `${r}/`);
};

export type HttpProbe = {ok: boolean; status?: number; error?: string};

/** Any HTTP answer below 500 counts as alive: a 404 still proves the server is up. */
export const httpAlive = async (url: string, timeoutMs = 1500): Promise<HttpProbe> => {
  try {
    const res = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
    await res.arrayBuffer().catch(() => undefined);
    return {ok: res.status < 500, status: res.status};
  } catch (e) {
    return {ok: false, error: (e as Error).message};
  }
};

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
