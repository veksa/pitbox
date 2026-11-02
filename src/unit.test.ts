import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseArgs, toCall} from './cli.ts';
import {loadConfig} from './config/load.ts';
import {exposedPorts} from './config/schema.ts';
import {grep, headings, lineRange, section, toc} from './docs/docs.ts';
import {parseProbe, probePort} from './stand/health.ts';
import {pickReply} from './stand/llmMock.ts';
import {orderServices, stopOrder} from './stand/services.ts';
import {quoteArg} from './util/proc.ts';
import {renderTemplate, tailLines, templateParams} from './util/text.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-test-'));

describe('config', () => {
  it('loads a TypeScript config and resolves the state dir next to it', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'pitbox.config.ts'), `export default {app: {android: 'com.example.app'}, services: {api: {start: 'node api.js', health: 'tcp:3000', expose: 3000}}};`);
    const loaded = await loadConfig({cwd: dir});
    expect(loaded.config.app?.android).toBe('com.example.app');
    expect(loaded.stateDir).toBe(path.join(dir, '.pitbox'));
  });

  it('rejects a bad probe with the path of the field', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({services: {api: {health: 'localhost:3000'}}}));
    await expect(loadConfig({cwd: dir})).rejects.toThrow(/services\.api\.health/);
  });

  it('rejects a tool placeholder that is not declared', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({tools: {sql: {run: 'psql -c {query}'}}}));
    await expect(loadConfig({cwd: dir})).rejects.toThrow(/missing query/);
  });

  it('collects exposed ports from services, extra reverses and the mock', () => {
    expect(exposedPorts({services: {a: {expose: [3000, 8080]}, b: {expose: 3000}}, android: {reverse: [8097]}, mocks: {llm: {port: 4010}}})).toEqual([3000, 4010, 8080, 8097]);
  });
});

describe('services order', () => {
  const services = {db: {}, api: {dependsOn: ['db']}, web: {dependsOn: ['api']}};
  it('puts dependencies first', () => {
    expect(orderServices(services, ['web'])).toEqual(['db', 'api', 'web']);
  });
  it('stops dependents first and leaves dependencies running', () => {
    expect(stopOrder(services, ['api'])).toEqual(['web', 'api']);
    expect(stopOrder(services, ['web'])).toEqual(['web']);
  });
  it('reports cycles and unknown names', () => {
    expect(() => orderServices({a: {dependsOn: ['b']}, b: {dependsOn: ['a']}}, ['a'])).toThrow(/cycle/);
    expect(() => orderServices(services, ['nope'])).toThrow(/unknown service/);
  });
});

describe('probes', () => {
  it('parses every kind and finds the port', () => {
    expect(parseProbe('tcp:3000')).toEqual({kind: 'tcp', host: '127.0.0.1', port: 3000});
    expect(parseProbe('tcp:10.0.0.2:5432')).toEqual({kind: 'tcp', host: '10.0.0.2', port: 5432});
    expect(parseProbe('docker:db')).toEqual({kind: 'docker', container: 'db'});
    expect(probePort('http://localhost:8081/status')).toBe(8081);
    expect(probePort('docker:db')).toBeUndefined();
  });
});

describe('templates and quoting', () => {
  it('quotes values for bash and cmd', () => {
    expect(quoteArg('plain-value_1', 'bash')).toBe('plain-value_1');
    expect(quoteArg(`it's {"a": 1}`, 'bash')).toBe(`'it'\\''s {"a": 1}'`);
    expect(quoteArg('a b', 'cmd')).toBe('"a b"');
  });
  it('fills placeholders and refuses missing ones', () => {
    expect(renderTemplate('call {req} {json}', {req: 'Ping', json: '{}'}, v => `<${v}>`)).toBe('call <Ping> <{}>');
    expect(() => renderTemplate('x {y}', {}, v => v)).toThrow(/missing parameter/);
    expect(templateParams('a {x} {y} {x}')).toEqual(['x', 'y']);
  });
  it('tails and filters lines', () => {
    expect(tailLines('a\nb\nERROR c\nd\n', 2)).toEqual(['ERROR c', 'd']);
    expect(tailLines('a\nERROR b\nc\nerror d', 5, 'error')).toEqual(['ERROR b', 'error d']);
  });
});

describe('docs', () => {
  const doc = ['# Plan', 'intro', '## Setup', 'install it', '### Windows', 'use bash', '## Run', 'start it', '```', '# not a heading', '```'].join('\n');
  it('lists headings outside code fences', () => {
    expect(headings(doc).map(h => h.text)).toEqual(['Plan', 'Setup', 'Windows', 'Run']);
    expect(toc(doc, 2)).toHaveLength(3);
  });
  it('returns a section with its subsections', () => {
    expect(section(doc, 'setup')).toEqual(['## Setup', 'install it', '### Windows', 'use bash']);
    expect(() => section(doc, 'deploy')).toThrow(/no heading/);
  });
  it('greps with line numbers and context', () => {
    expect(grep(doc, 'bash')).toEqual(['    6: use bash']);
    expect(grep(doc, 'bash', 1)).toEqual(['    5- ### Windows', '    6: use bash', '    7- ## Run']);
    expect(lineRange(doc, 2, 3)).toEqual(['    2  intro', '    3  ## Setup']);
  });
});

describe('llm mock', () => {
  it('answers from the first matching fixture, else echoes', () => {
    const fixtures = [{match: 'translate', reply: 'bonjour'}];
    expect(pickReply(fixtures, [{role: 'system', content: 'x'}, {role: 'user', content: 'Translate hello'}])).toBe('bonjour');
    expect(pickReply(fixtures, [{role: 'user', content: [{type: 'text', text: 'hi'}]}])).toBe('mock reply to: hi');
  });
});

describe('cli', () => {
  it('maps commands to daemon calls', () => {
    expect(toCall(parseArgs(['up', 'api', 'db']))).toEqual({method: 'up', params: {services: ['api', 'db']}});
    expect(toCall(parseArgs(['tool', 'sql', 'query=select 1']))).toEqual({method: 'tool', params: {name: 'sql', params: {query: 'select 1'}}});
    expect(toCall(parseArgs(['logs', 'api', '-n', '5', '--grep', 'err'])).params).toMatchObject({name: 'api', lines: '5', grep: 'err'});
    expect(toCall(parseArgs(['install', 'app.apk', '--replace', '--device', 'emulator-5554'])).params).toMatchObject({apk: 'app.apk', replace: true, device: 'emulator-5554'});
    expect(toCall(parseArgs(['settings', 'fontScale=1.3', 'dark=true'])).params).toMatchObject({fontScale: '1.3', dark: 'true'});
  });
});

describe('runner version', () => {
  it('is the same in the host, the Gradle build and the runner code', async () => {
    const {RUNNER_VERSION} = await import('./drivers/android/runner.ts');
    const gradle = fs.readFileSync('runners/android/build.gradle.kts', 'utf8');
    const kotlin = fs.readFileSync('runners/android/src/main/kotlin/dev/pitbox/runner/Commands.kt', 'utf8');
    expect(Number(/versionCode = (\d+)/.exec(gradle)?.[1])).toBe(RUNNER_VERSION);
    expect(Number(/const val VERSION = (\d+)/.exec(kotlin)?.[1])).toBe(RUNNER_VERSION);
  });
});

describe('cli and engine agree', () => {
  it('maps every command to an engine method, never to the daemon stop rpc', async () => {
    const {Engine} = await import('./daemon/engine.ts');
    const {DAEMON_STOP} = await import('./daemon/server.ts');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'pitbox.config.json'), '{}');
    const engine = await Engine.create(path.join(dir, 'pitbox.config.json'));
    const methods = new Set(Object.keys(engine.methods));
    const commands = ['up', 'down', 'restart', 'status', 'logs x', 'tools', 'tool x', 'actors', 'actor start a b', 'actor stop a', 'actor call a', 'devices', 'boot', 'shutdown', 'install a.apk', 'open', 'stop-app', 'clear-app', 'uninstall', 'apps', 'app-logs', 'settings', 'network full', 'screenshot', 'key back', 'reverse', 'info', 'doctor', 'docs', 'dev status', 'dev prewarm', 'dev reload', 'dev restart', 'snapshot', 'press a', 'longpress a', 'doubletap a', 'fill a b', 'type a', 'swipe up', 'scroll down until a', 'wait a', 'focus', 'shot', 'run f', 'goto r', 'as u', 'record start', 'record stop', 'fresh', 'app-log', 'net clear', 'media', 'touch up', 'focusmap', 'state list', 'state save a', 'state restore a', 'state rm a'];
    for (const c of commands) {
      const {method} = toCall(parseArgs(c.split(' ')));
      expect(method, c).not.toBe(DAEMON_STOP);
      expect(methods.has(method), `${c} → ${method}`).toBe(true);
    }
  });
});

describe('crash events', () => {
  it('collects crashes and ANRs of the app with their stack, ignoring other apps', async () => {
    const {CrashParser} = await import('./drivers/android/events.ts');
    const p = new CrashParser('com.example.app');
    const t = 1_800_000_000;
    [
      `${t}.100  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main`,
      `${t}.101  4242  4242 E AndroidRuntime: Process: com.example.app, PID: 4242`,
      `${t}.102  4242  4242 E AndroidRuntime: java.lang.IllegalStateException: boom`,
      `${t}.103  4242  4242 E AndroidRuntime: \tat com.example.app.Main.onCreate(Main.kt:12)`,
      `${t}.200   700   720 I ActivityManager: Start proc 4300:com.other/u0a1`,
      `${t}.300   700   720 E ActivityManager: ANR in com.example.app (com.example.app/.MainActivity)`,
      `${t}.400   700   720 E ActivityManager: ANR in com.other.app`,
      `${t}.500  5000  5000 E AndroidRuntime: FATAL EXCEPTION: main`,
      `${t}.501  5000  5000 E AndroidRuntime: Process: com.other, PID: 5000`,
    ].forEach(l => p.feed(l));
    const events = p.since(t * 1000);
    expect(events.map(e => e.kind)).toEqual(['crash', 'anr']);
    expect(events[0]?.summary).toBe('java.lang.IllegalStateException: boom');
    expect(events[0]?.lines[0]).toBe('Process: com.example.app, PID: 4242');
  });
});
