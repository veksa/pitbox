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

/** React DevTools' port: apps in development connect to it, so pitbox never takes it for itself. */
export const REACT_DEVTOOLS_PORT = 8097;

/**
 * The range pitbox picks its own ports from (actors, the Apple runner): `PITBOX_PORTS=lo-hi`, for machines that
 * keep local servers to set ranges. Unset: any port the system gives out.
 */
export const portRange = (env: NodeJS.ProcessEnv = process.env): [number, number] | undefined => {
  const raw = env.PITBOX_PORTS?.trim();
  if (!raw) return undefined;
  const m = /^(\d+)-(\d+)$/.exec(raw);
  const [lo, hi] = m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
  if (!(lo >= 1 && hi <= 65535 && lo <= hi)) throw new Error(`PITBOX_PORTS=${raw}: expected a range such as 4200-4299`);
  return [lo, hi];
};

const bindFree = (port: number): Promise<number | undefined> =>
  new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(undefined));
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address && typeof address === 'object' ? address.port : undefined));
    });
  });

/**
 * A port nobody listens on: from `PITBOX_PORTS` when set (starting at a random place in it, so two daemons rarely
 * try the same one first), else one the system gives out. Never React DevTools' port, never one that answers.
 */
export const freePort = async (env: NodeJS.ProcessEnv = process.env): Promise<number> => {
  const range = portRange(env);
  if (!range) {
    for (let i = 0; i < 5; i++) {
      const p = await bindFree(0);
      if (p && p !== REACT_DEVTOOLS_PORT && !(await portAnswers(p))) return p;
    }
    throw new Error('no free port');
  }
  const [lo, hi] = range;
  const size = hi - lo + 1;
  const first = Math.floor(Math.random() * size);
  for (let i = 0; i < size; i++) {
    const p = lo + ((first + i) % size);
    if (p === REACT_DEVTOOLS_PORT || (await portAnswers(p))) continue;
    if ((await bindFree(p)) === p) return p;
  }
  throw new Error(`no free port in PITBOX_PORTS=${lo}-${hi}: every one answers or is React DevTools' (${REACT_DEVTOOLS_PORT})`);
};
