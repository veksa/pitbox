// Network probes and free-port lookup.

import net from 'node:net';

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
