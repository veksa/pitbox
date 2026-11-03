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

afterAll(async () => {
  for (const m of managers) await m.killAll();
});

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

  it('keeps waiting for the probe when the start command exits 0 after launching in the background', async () => {
    const port = await freePort();
    const bg = path.join(dir, 'bg.cjs');
    fs.writeFileSync(bg, `const {spawn} = require('child_process'); const c = spawn(process.execPath, ['-e', "setTimeout(() => require('http').createServer((q,s)=>s.end()).listen(${port}), 700)"], {detached: true, stdio: 'ignore'}); c.unref(); fs = require('fs'); fs.writeFileSync(${JSON.stringify(path.join(dir, 'bg.pid').replace(/\\/g, '/'))}, String(c.pid));`);
    const m = new ServiceManager(ctx, {bg: {start: `${node} ${JSON.stringify(bg.replace(/\\/g, '/'))}`, health: `tcp:${port}`, startTimeout: 20}});
    const [s] = await m.up();
    expect(s?.status).toBe('up');
    expect((await m.status())[0]?.status).toBe('up');
    process.kill(Number(fs.readFileSync(path.join(dir, 'bg.pid'), 'utf8')));
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

  it('forces replies, errors and delays by rule, uses up a once rule, and logs every request', async () => {
    const port = await freePort();
    const fixtures = path.join(dir, 'fixtures-rules.json');
    fs.writeFileSync(fixtures, JSON.stringify([{match: 'summar', reply: 'a summary'}]));
    const mock = new LlmMock(port, fixtures);
    await mock.start();
    const ask = async (content: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {method: 'POST', body: JSON.stringify({model: 'm', messages: [{role: 'user', content}]})});
      return {status: res.status, body: (await res.json()) as {choices?: {message: {content: string}}[]; error?: {type: string}}};
    };
    mock.addRule({action: 'fail', match: 'translate', status: 429, once: true});
    mock.addRule({action: 'reply', match: 'summar', text: 'forced'});
    mock.addRule({action: 'delay', ms: 150});
    expect((await ask('translate this')).body.error?.type).toBe('rate_limit_exceeded');
    expect((await ask('translate this')).body.choices?.[0]?.message.content).toBe('mock reply to: translate this');
    const t0 = Date.now();
    expect((await ask('summarize it')).body.choices?.[0]?.message.content).toBe('forced');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    mock.clearRules();
    expect((await ask('summarize it')).body.choices?.[0]?.message.content).toBe('a summary');
    expect(mock.log.map(r => [r.status, r.source])).toEqual([
      [429, 'rule m1'],
      [200, 'default, delayed 150 ms'],
      [200, 'rule m2, delayed 150 ms'],
      [200, 'fixture /summar/'],
    ]);
    // The newest of a forced error and a forced reply decides.
    mock.addRule({action: 'fail', status: 503});
    mock.addRule({action: 'reply', match: 'hello', text: 'newer'});
    expect((await ask('hello')).body.choices?.[0]?.message.content).toBe('newer');
    expect((await ask('other')).status).toBe(503);
    expect(() => mock.addRule({action: 'reply', match: '(', text: 'x'})).toThrow();
    await mock.stop();
  });
});

describe('a failed emulator snapshot', () => {
  it('says the emulator is gone instead of an empty reason', async () => {
    const {snapshotFailure} = await import('./stand/states.ts');
    const gone = {devices: async () => []};
    expect(await snapshotFailure(gone as never, 'emulator-5554', {stdout: '', stderr: '', code: 1})).toMatch(/emulator-5554 is gone .*boot it again/);
    const there = {devices: async () => [{serial: 'emulator-5554', state: 'device'}]};
    expect(await snapshotFailure(there as never, 'emulator-5554', {stdout: '', stderr: '', code: 1})).toBe('adb exited with 1 and said nothing');
    expect(await snapshotFailure(there as never, 'emulator-5554', {stdout: 'KO: no space', stderr: ''})).toBe('KO: no space');
  });
});

describe('a restored emulator', () => {
  const store = async (dir: string) => {
    const {StateStore} = await import('./stand/states.ts');
    const s = new StateStore({root: dir, stateDir: dir});
    fs.mkdirSync(path.join(dir, 'states'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'states', 's1.json'), JSON.stringify({name: 's1', savedAt: 0, device: 'emulator-5554', avd: 'Pixel', backend: false}));
    return s;
  };

  it('is a restore only once adb reaches it again, and an offline one is reported', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-state-'));
    const calls: string[] = [];
    let state = 'offline';
    const android = {
      adb: async (args: string[]) => {
        calls.push(args.join(' '));
        return {stdout: args[0] === 'emu' ? 'OK' : '', stderr: '', code: 0};
      },
      devices: async () => [{serial: 'emulator-5554', state}],
    };
    const s = await store(dir);
    const {emulatorSnapshot} = await import('./stand/states.ts');
    const emulator = emulatorSnapshot(android as never, 'emulator-5554', 'Pixel', 300);
    await expect(s.restore('s1', emulator)).rejects.toThrow(/stayed offline in adb .* boot it again/);
    expect(calls).toContain('reconnect offline');
    state = 'device';
    await expect(s.restore('s1', emulator)).resolves.toMatchObject({name: 's1'});
  });
});

describe('named states', () => {
  it("save and bring back the backend and the device's side, backend first", async () => {
    const {StateStore} = await import('./stand/states.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-states-'));
    const order: string[] = [];
    const store = new StateStore(
      {root, stateDir: path.join(root, '.pitbox')},
      {save: `node -e "require('fs').writeFileSync('{file}', '7')"`, restore: `node -e "require('fs').writeFileSync('restored', require('fs').readFileSync('{file}'))"`},
    );
    const device = {
      id: 'AAA',
      label: 'iPhone',
      kind: 'app-data' as const,
      save: async (n: string) => void order.push(`save ${n}`),
      load: async (n: string) => void order.push(`load ${n}`),
      remove: async (n: string) => void order.push(`remove ${n}`),
    };
    const info = await store.save('signed-in', device);
    expect(info).toMatchObject({name: 'signed-in', device: 'AAA', avd: 'iPhone', backend: true, kind: 'app-data'});
    await store.restore('signed-in', device);
    expect(fs.readFileSync(path.join(root, 'restored'), 'utf8')).toBe('7');
    await expect(store.restore('signed-in', {...device, id: 'BBB'})).rejects.toThrow(/boot that simulator first/);
    await store.remove('signed-in', device);
    expect(order).toEqual(['save pitbox-signed-in', 'load pitbox-signed-in', 'remove pitbox-signed-in']);
    expect(store.list()).toEqual([]);
  });
});
