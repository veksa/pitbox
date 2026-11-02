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
import {orderServices} from './stand/services.ts';
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
