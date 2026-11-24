// The CLI's calls to its daemon: an answer that takes long still arrives, and only the call's own timeout ends one.

import fs from 'node:fs';
import http from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {DaemonClient, DaemonError} from './daemon/client.ts';

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const {method, params} = JSON.parse(body) as {method: string; params: {ms?: number}};
      const answer = method === 'fail' ? {ok: false, error: 'no such app'} : {ok: true, result: {method, token: req.headers['x-pitbox-token']}};
      setTimeout(() => res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(answer)), params.ms ?? 0);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as {port: number}).port;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const client = () => new DaemonClient({pid: process.pid, port, token: 't0k', config: '', root: '', startedAt: 0, version: '0'});

describe('the daemon client', () => {
  it('sends the token and reads the answer, a slow one too', async () => {
    expect(await client().call('ping', {ms: 300})).toEqual({method: 'ping', token: 't0k'});
  });

  it("throws the daemon's own error", async () => {
    await expect(client().call('fail')).rejects.toThrow(DaemonError);
  });

  it('ends a call at its own timeout and says so', async () => {
    await expect(client().call('ping', {ms: 2000}, 200)).rejects.toThrow(/did not answer within/);
  });

  it('does not go through fetch, which drops any answer slower than five minutes as "fetch failed"', () => {
    expect(fs.readFileSync(new URL('./daemon/client.ts', import.meta.url), 'utf8')).not.toMatch(/\bfetch\(/);
  });
});
