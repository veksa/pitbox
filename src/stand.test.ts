// Stand behaviour with real processes: start, adopt, fail with the log, stop, actors, tools, the mock.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {ActorManager} from './stand/actors.ts';
import {LlmMock} from './stand/llmMock.ts';
import {ServiceManager} from './stand/services.ts';
import {runTool} from './stand/tools.ts';
import {freePort, tcpOpen} from './util/net.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-stand-'));
const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));
const server = (port: number) => `${node} -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port});console.log('listening ${port}')"`;
const ctx = {root: dir, stateDir: path.join(dir, '.pitbox')};
const managers: ServiceManager[] = [];

afterAll(() => managers.forEach(m => m.killAll()));

describe('services', () => {
  it('starts in dependency order, waits for health, logs, and stops', async () => {
    const [a, b] = [await freePort(), await freePort()];
    const m = new ServiceManager(ctx, {
      first: {start: server(a), health: `tcp:${a}`},
      second: {start: server(b), health: `http://127.0.0.1:${b}/`, dependsOn: ['first'], expose: b},
    });
    managers.push(m);
    const up = await m.up(['second']);
    expect(up.map(s => [s.name, s.status])).toEqual([['first', 'up'], ['second', 'up']]);
    expect(m.logTail('first').join('\n')).toContain(`listening ${a}`);
    const down = await m.down();
    expect(down.every(s => s.status === 'stopped')).toBe(true);
    await new Promise(r => setTimeout(r, 800));
    expect(await tcpOpen(a)).toBe(false);
  }, 30_000);

  it('adopts a service that already answers instead of starting a second one', async () => {
    const port = await freePort();
    const outside = new ServiceManager(ctx, {x: {start: server(port), health: `tcp:${port}`}});
    managers.push(outside);
    await outside.up();
    const m = new ServiceManager({...ctx, stateDir: path.join(dir, '.other')}, {x: {start: 'exit 1', health: `tcp:${port}`}});
    const [s] = await m.up();
    expect(s?.status).toBe('external');
    const [d] = await m.down();
    expect(d?.detail).toMatch(/left running/);
    await outside.down();
  }, 30_000);

  it('fails fast with the log tail when the process exits before it is healthy', async () => {
    const port = await freePort();
    const m = new ServiceManager(ctx, {bad: {start: `${node} -e "console.error('boom: no config'); process.exit(3)"`, health: `tcp:${port}`, startTimeout: 20}});
    const t0 = Date.now();
    const [s] = await m.up();
    expect(s?.status).toBe('failed');
    expect(s?.detail).toContain('boom: no config');
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it('fails without a start command when nothing answers', async () => {
    const port = await freePort();
    const m = new ServiceManager(ctx, {ext: {health: `tcp:${port}`}});
    const [s] = await m.up();
    expect(s?.status).toBe('failed');
    expect(s?.detail).toMatch(/no start command/);
  });
});

describe('actors', () => {
  it('starts an instance on a free port and relays a call', async () => {
    const script = path.join(dir, 'actor.cjs');
    fs.writeFileSync(script, `const [name, port] = process.argv.slice(2); require('http').createServer((q, s) => { let b = ''; q.on('data', d => b += d); q.on('end', () => s.end(JSON.stringify({name, got: JSON.parse(b)}))); }).listen(Number(port));`);
    const actors = new ActorManager(ctx, {peer: {start: `${node} ${JSON.stringify(script.replace(/\\/g, '/'))} {name} {port}`}});
    const a = await actors.start('peer', 'alice');
    expect(a.status).toBe('up');
    const r = await actors.call('alice', {hello: 1});
    expect(JSON.parse(r.body)).toEqual({name: 'alice', got: {hello: 1}});
    actors.stopAll();
  }, 30_000);
});

describe('tools', () => {
  it('quotes parameters and keeps output short', async () => {
    const r = await runTool(ctx, 'echo', {run: `${node} -e "console.log(process.argv[1])" {text}`}, {text: `it's a "test"`}, 200);
    expect(r.code).toBe(0);
    expect(r.output).toBe(`it's a "test"`);
  }, 30_000);
});

describe('llm mock', () => {
  it('serves chat completions, plain and streamed', async () => {
    const port = await freePort();
    const fixtures = path.join(dir, 'fixtures.json');
    fs.writeFileSync(fixtures, JSON.stringify([{match: 'moderate', reply: '{"verdict":"ok"}'}]));
    const mock = new LlmMock(port, fixtures);
    await mock.start();
    const body = {model: 'm', messages: [{role: 'user', content: 'moderate this'}]};
    const plain = await (await fetch(`http://127.0.0.1:${port}/api/v1/chat/completions`, {method: 'POST', body: JSON.stringify(body)})).json();
    expect(plain.choices[0].message.content).toBe('{"verdict":"ok"}');
    const streamed = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {method: 'POST', body: JSON.stringify({...body, stream: true})})).text();
    expect(streamed).toContain('"content":"{\\"verdict\\":\\"ok\\"}"');
    expect(streamed.trim().endsWith('data: [DONE]')).toBe(true);
    await mock.stop();
  });
});
