import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {failed, parseArgs, toCall} from './cli.ts';
import {loadConfig} from './config/load.ts';
import {exposedPorts} from './config/schema.ts';
import {grep, headings, lineRange, section, toc} from './docs/docs.ts';
import {AndroidDriver, CONNECT_PREFS, mergeConnectPrefs} from './drivers/android/driver.ts';
import {instrumentCommand} from './drivers/android/runner.ts';
import {shownPath} from './format.ts';
import {parseProbe, probePort} from './stand/health.ts';
import {pickReply} from './stand/llmMock.ts';
import {orderServices, restartOrder, stopOrder} from './stand/services.ts';
import {quoteArg} from './util/proc.ts';
import {renderTemplate, tailLines, templateParams} from './util/text.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-test-'));

describe('config', () => {
  it('loads a TypeScript config from a package without "type": "module" with nothing on stderr', async () => {
    const {spawnSync} = await import('node:child_process');
    const {pathToFileURL} = await import('node:url');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name": "app"}');
    fs.writeFileSync(path.join(dir, 'pitbox.config.ts'), `export default {app: {android: 'com.example.app'}};`);
    const loader = pathToFileURL(path.resolve('src/config/load.ts')).href;
    const script = `const {loadConfig} = await import(${JSON.stringify(loader)}); const c = await loadConfig({cwd: ${JSON.stringify(dir)}}); console.log(c.config.app.android);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'});
    expect(r.stdout.trim()).toBe('com.example.app');
    expect(r.stderr).not.toMatch(/MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module/);
  });

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

  it("keeps the dev server off React DevTools' port", async () => {
    const {defaultInternalPort} = await import('./devserver/devserver.ts');
    expect(defaultInternalPort(8081)).toBe(8082);
    expect(defaultInternalPort(8096)).toBe(8098);
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({devserver: {port: 8097}}));
    await expect(loadConfig({cwd: dir})).rejects.toThrow(/devserver\.port: 8097 is React DevTools' port/);
  });

  it('picks its own ports from PITBOX_PORTS, past one that answers', async () => {
    const {freePort, portAnswers, portRange} = await import('./util/net.ts');
    const net = await import('node:net');
    const taken = net.createServer();
    await new Promise<void>(r => taken.listen(0, '::', () => r()));
    const p = (taken.address() as import('node:net').AddressInfo).port;
    try {
      // A range of two whose other port is free: the taken one is never given, wherever the pick starts.
      const other = p > 1024 ? p - 1 : p + 1;
      const range = other < p ? `${other}-${p}` : `${p}-${other}`;
      // The neighbour may be some other program's on a busy machine: then there is nothing to check here.
      if (await portAnswers(other)) return;
      for (let i = 0; i < 5; i++) {
        const got = await freePort({PITBOX_PORTS: range}).catch(() => undefined);
        // Test files run in parallel and take ephemeral ports too: a neighbour taken meanwhile proves nothing.
        if (got !== other && (await portAnswers(other))) return;
        expect(got).toBe(other);
      }
      await expect(freePort({PITBOX_PORTS: `${p}-${p}`})).rejects.toThrow(/no free port in PITBOX_PORTS/);
    } finally {
      taken.close();
    }
    expect(() => portRange({PITBOX_PORTS: '9000'})).toThrow(/expected a range/);
    expect(portRange({})).toBeUndefined();
  });

  it('takes the device placeholders as built in and refuses to declare them', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({tools: {fresh: {run: 'simctl install {apple_device} {app}; adb -s {android_device} shell true', params: {app: 'app path'}}}}));
    expect((await loadConfig({cwd: dir})).config.tools?.fresh?.params).toEqual({app: 'app path'});
    fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({tools: {fresh: {run: 'simctl install {apple_device}', params: {apple_device: 'udid'}}}}));
    await expect(loadConfig({cwd: dir})).rejects.toThrow(/tools\.fresh\.params: apple_device is built in/);
  });

  it('takes optional tool parameters and lists them marked as such', async () => {
    const {formatResult} = await import('./format.ts');
    const {describeTool} = await import('./stand/tools.ts');
    const dir = tmp();
    const tools = {todo: {description: 'open tasks', run: 'todo {area} {platforms}', params: {area: 'which area', platforms: {description: 'which platforms', default: 'all'}}}};
    fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({tools}));
    const {config} = await loadConfig({cwd: dir});
    const listed = Object.entries(config.tools ?? {}).map(([n, t]) => describeTool(n, t));
    expect(formatResult('tools', listed)).toBe('todo(area, platforms?) — open tasks');
  });

  it('collects exposed ports from services, extra reverses and the mock', () => {
    expect(exposedPorts({services: {a: {expose: [3000, 8080]}, b: {expose: 3000}}, android: {reverse: [8097]}, mocks: {llm: {port: 4010}}})).toEqual([3000, 4010, 8080, 8097]);
  });
});

describe('dev server pointer on android', () => {
  it("sets the dev server in the connect library's preferences and keeps the other hosts", () => {
    const xml = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <string name="api">10.0.2.2:3000</string>\n    <string name="devserver">localhost:8081</string>\n</map>\n`;
    expect(mergeConnectPrefs(xml, {devserver: 'localhost:8081'})).toBeUndefined();
    const next = mergeConnectPrefs(xml, {devserver: 'localhost:9090'})!;
    expect(next).toContain('<string name="api">10.0.2.2:3000</string>');
    expect(next).toContain('<string name="devserver">localhost:9090</string>');
    expect(mergeConnectPrefs('', {devserver: 'localhost:8081'})).toMatch(/^<\?xml[^]*<map>\n {4}<string name="devserver">localhost:8081<\/string>\n<\/map>\n$/);
  });

  it.skipIf(process.platform === 'win32')("writes the preferences through the device's shell as the app, once, and leaves a build run-as refuses alone", async () => {
    const {execFileSync} = await import('node:child_process');
    const dir = tmp();
    const data = path.join(dir, 'data');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(data);
    fs.mkdirSync(bin);
    // run-as as Android has it: the package, then a command run in the app's data directory.
    fs.writeFileSync(path.join(bin, 'run-as'), `#!/bin/sh\n[ -f "${dir}/refuse" ] && { echo "run-as: package not debuggable: $1" >&2; exit 1; }\nshift\ncd "${data}" && exec "$@"\n`, {mode: 0o755});
    const commands: string[] = [];
    const driver = Object.assign(Object.create(AndroidDriver.prototype) as AndroidDriver, {
      shell: async (_serial: string, command: string) => {
        commands.push(command);
        try {
          return execFileSync('/bin/sh', ['-c', command], {encoding: 'utf8', env: {...process.env, PATH: `${bin}:${process.env.PATH}`}, stdio: ['ignore', 'pipe', 'pipe']});
        } catch (e) {
          const out = String((e as {stdout?: string}).stdout ?? '');
          if (out) return out;
          throw e;
        }
      },
    });
    expect(await driver.saveConnectHosts('emulator-5554', 'com.example.app', {devserver: "localhost:8081"})).toBe(true);
    expect(fs.readFileSync(path.join(data, CONNECT_PREFS), 'utf8')).toContain('<string name="devserver">localhost:8081</string>');
    const writes = commands.length;
    expect(await driver.saveConnectHosts('emulator-5554', 'com.example.app', {devserver: 'localhost:8081'})).toBe(false);
    expect(commands.length).toBe(writes + 1);
    fs.writeFileSync(path.join(dir, 'refuse'), '');
    expect(await driver.saveConnectHosts('emulator-5554', 'com.example.app', {devserver: 'localhost:9090'})).toBeUndefined();
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
  it('restarts the dependents that were running, not the ones that were down', () => {
    expect(restartOrder(services, ['api'], new Set(['db', 'api', 'web']))).toEqual(['api', 'web']);
    expect(restartOrder(services, ['api'], new Set(['db', 'api']))).toEqual(['api']);
    expect(restartOrder(services, ['db'], new Set(['db', 'web']))).toEqual(['db', 'web']);
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
  it('exits non-zero on a failed verdict', () => {
    expect(failed('run', {ok: false, steps: 0, ms: 0})).toBe(true);
    expect(failed('run', {ok: true, steps: 3, ms: 10})).toBe(false);
    expect(failed('as', {ok: false})).toBe(true);
    expect(failed('matrix', {results: [{ok: true}, {ok: false}]})).toBe(true);
    expect(failed('matrix', {results: [{ok: true}]})).toBe(false);
    expect(failed('up', {services: [{status: 'failed'}]})).toBe(true);
    expect(failed('press', {})).toBe(false);
  });

  it('maps commands to daemon calls', () => {
    expect(toCall(parseArgs(['up', 'api', 'db']))).toEqual({method: 'up', params: {services: ['api', 'db']}});
    expect(toCall(parseArgs(['tool', 'sql', 'query=select 1']))).toEqual({method: 'tool', params: {name: 'sql', params: {query: 'select 1'}}});
    expect(toCall(parseArgs(['logs', 'api', '-n', '5', '--grep', 'err'])).params).toMatchObject({name: 'api', lines: '5', grep: 'err'});
    expect(toCall(parseArgs(['install', 'app.apk', '--replace', '--device', 'emulator-5554'])).params).toMatchObject({apk: 'app.apk', replace: true, device: 'emulator-5554'});
    expect(toCall(parseArgs(['settings', 'fontScale=1.3', 'dark=true'])).params).toMatchObject({fontScale: '1.3', dark: 'true'});
    expect(toCall(parseArgs(['wait', 'id=player', '30'])).params).toMatchObject({target: 'id=player', timeout: '30'});
    expect(toCall(parseArgs(['wait', 'gone', 'text=Loading', '5'])).params).toMatchObject({gone: true, target: 'text=Loading', timeout: '5'});
    expect(toCall(parseArgs(['wait', 'text=Page 2'])).params).toMatchObject({target: 'text=Page 2'});
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

describe('the android runner tree', () => {
  it('fetches nodes in batches the app does not cut short on a screen that keeps redrawing', () => {
    const kotlin = fs.readFileSync('runners/android/src/main/kotlin/dev/pitbox/runner/Commands.kt', 'utf8');
    // An interruptible batch stops whenever the app's UI thread has work waiting: with text streaming in, a tree
    // then costs one call into the app per node and takes longer than the host waits.
    expect(kotlin).toMatch(/val PREFETCH = [^\n]*FLAG_PREFETCH_UNINTERRUPTIBLE/);
    expect(kotlin).toMatch(/val CHILD_PREFETCH = [^\n]*FLAG_PREFETCH_UNINTERRUPTIBLE/);
    expect(kotlin).toMatch(/w\.getRoot\(PREFETCH\)/);
    expect(kotlin).toMatch(/n\.getChild\(i, CHILD_PREFETCH\)/);
  });

  it('reads a node gone before the app answered an uninterruptible fetch as no node, not as a failed tree', () => {
    const kotlin = fs.readFileSync('runners/android/src/main/kotlin/dev/pitbox/runner/Commands.kt', 'utf8');
    // Debuggable builds (emulators) check the answer's list and throw on the single-node "no node" answer.
    expect(kotlin).toMatch(/prefetched \{ w\.getRoot\(PREFETCH\) \}/);
    expect(kotlin).toMatch(/prefetched \{ n\.getChild\(i, CHILD_PREFETCH\) \}/);
    expect(kotlin).toMatch(/catch \(e: NullPointerException\) \{\s*if \(e\.stackTrace\.none \{ it\.methodName == "checkFindAccessibilityNodeInfoResultIntegrity" \}\) throw e\s*null/);
    expect(kotlin).not.toMatch(/getChild\(i, CHILD_PREFETCH\)\)? \?: continue/);
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
    const commands = ['up', 'down', 'restart', 'status', 'logs x', 'tools', 'tool x', 'actors', 'actor start a b', 'actor stop a', 'actor call a', 'devices', 'boot', 'shutdown', 'install a.apk', 'open', 'stop-app', 'clear-app', 'uninstall', 'apps', 'app-logs', 'settings', 'network full', 'screenshot', 'key back', 'reverse', 'info', 'doctor', 'docs', 'dev status', 'dev prewarm', 'dev reload', 'dev restart', 'snapshot', 'press a', 'longpress a', 'doubletap a', 'fill a b', 'type a', 'swipe up', 'scroll down until a', 'wait a', 'focus', 'shot', 'run f', 'goto r', 'as u', 'record start', 'record stop', 'fresh', 'app-log', 'net clear', 'media', 'touch up', 'focusmap', 'state list', 'state save a', 'state restore a', 'state rm a', 'perf', 'visual a', 'matrix f', 'app-tree', 'app-errors', 'downloads'];
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

describe('mcp tools', () => {
  it('route every tool and every action to an existing engine method, and stay small', async () => {
    const {registerTools} = await import('./mcp/server.ts');
    const {Engine} = await import('./daemon/engine.ts');
    const dir = tmp();
    const config = {app: {android: 'com.example.app'}, devserver: {}, actors: {peer: {start: 'x {name} {port}'}}, tools: {sql: {run: 'q {query}', params: {query: 'SQL'}}}};
    fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify(config));
    const engine = await Engine.create(path.join(dir, 'pitbox.config.json'));
    const methods = new Set(Object.keys(engine.methods));
    type Handler = (a: Record<string, unknown>) => Promise<unknown>;
    const tools: {name: string; schema: Record<string, {options?: string[]; def?: {values?: unknown}}>; handler: Handler; size: number}[] = [];
    registerTools({registerTool: (name, def, handler) => tools.push({name, schema: def.inputSchema as never, handler: handler as Handler, size: JSON.stringify(def).length})}, config as never, async () => ({
      call: async (method: string) => {
        called.push(method);
        throw new Error('stop');
      },
    }));
    const called: string[] = [];
    let checks = 0;
    for (const t of tools) {
      const enumKey = Object.keys(t.schema).find(k => k === 'action' || k === 'what');
      const values = enumKey ? ((t.schema[enumKey] as unknown as {options: string[]}).options ?? []) : [undefined];
      for (const v of values) {
        called.length = 0;
        await t.handler(enumKey ? {[enumKey]: v} : {});
        expect(called.length, `${t.name} ${v ?? ''}`).toBe(1);
        expect(methods.has(called[0]!), `${t.name} ${v ?? ''} → ${called[0]}`).toBe(true);
        checks++;
      }
    }
    // Every action of every tool was exercised, not skipped for want of enum options.
    expect(checks).toBeGreaterThan(50);
    expect(tools.length).toBeLessThanOrEqual(30);
  });

  it('tell the agent once what the client noted about the daemon (one of another version kept as it is)', async () => {
    const {registerTools} = await import('./mcp/server.ts');
    type Handler = (a: Record<string, unknown>) => Promise<{content: {text: string}[]}>;
    const tools = new Map<string, Handler>();
    const daemon = {note: 'pitbox: the project\'s daemon runs version 0.0.1', call: async () => ({docs: ['guide']})};
    registerTools({registerTool: (name, _def, handler) => tools.set(name, handler as Handler)}, {} as never, async () => daemon);
    const first = await tools.get('docs')!({});
    const second = await tools.get('docs')!({});
    expect(first.content[0]!.text).toMatch(/^pitbox: the project's daemon runs version 0\.0\.1\n/);
    expect(second.content[0]!.text).not.toMatch(/daemon runs version/);
  });
});

describe('swipe area', () => {
  it('runs inside the app scroller and above the keyboard, ignoring a keyboard window that spans the screen', async () => {
    const {buildSnapshot, swipeArea} = await import('./ui/snapshot.ts');
    const windows = [
      {type: 'app', title: '', pkg: 'com.example'},
      {type: 'ime', title: 'Keyboard', pkg: 'ime'},
      {type: 'system', title: 'Taskbar', pkg: 'launcher'},
    ];
    const snap = buildSnapshot(windows, [
      {p: -1, w: 0, c: 'ScrollView', b: [0, 200, 2000, 2000], f: 's'},
      {p: -1, w: 1, c: 'FrameLayout', b: [0, 0, 2000, 2100]},
      {p: 1, w: 1, c: 'KeyboardView', b: [0, 1100, 2000, 2000]},
      {p: -1, w: 2, c: 'View', b: [0, 2000, 2000, 2100], f: 's'},
    ]);
    expect(swipeArea(snap, 2000, 2100)).toEqual([0, 200, 2000, 1100]);
    expect(swipeArea(undefined, 1080, 2400)).toEqual([0, 0, 1080, 2400]);
  });
});

describe('avd kinds', () => {
  it('tells device kinds apart from an AVD config', async () => {
    const {kindOfAvdConfig} = await import('./drivers/android/sdk.ts');
    const ini = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n');
    const screen = (w: number, h: number, d: number) => ({'hw.lcd.width': String(w), 'hw.lcd.height': String(h), 'hw.lcd.density': String(d)});
    expect(kindOfAvdConfig(ini({'tag.id': 'google_apis_playstore', ...screen(1080, 2400, 420)}))).toBe('phone');
    expect(kindOfAvdConfig(ini({'tag.id': 'google_apis_playstore', 'hw.device.name': 'pixel_tablet', ...screen(2560, 1600, 320)}))).toBe('tablet');
    expect(kindOfAvdConfig(ini({'tag.id': 'google_apis_playstore', 'hw.sensor.hinge': 'yes', ...screen(2076, 2152, 390)}))).toBe('foldable');
    expect(kindOfAvdConfig(ini({'tag.id': 'google_apis_playstore', 'hw.device.name': 'desktop_medium', ...screen(1920, 1080, 160)}))).toBe('desktop');
    expect(kindOfAvdConfig(ini({'tag.id': 'android-wear', ...screen(454, 454, 320)}))).toBe('wear');
    expect(kindOfAvdConfig(ini({'tag.id': 'google-tv'}))).toBe('tv');
    expect(kindOfAvdConfig(ini({'tag.id': 'google-xr'}))).toBe('xr');
    expect(kindOfAvdConfig(ini({'tag.id': 'ai-glasses'}))).toBe('glasses');
    expect(kindOfAvdConfig(ini({'tag.id': 'android-automotive'}))).toBe('automotive');
  });
});

describe('form factors', () => {
  it('reads keys, combinations, letters and keycodes', async () => {
    const {keyOf} = await import('./drivers/android/formfactor.ts');
    const keys = {tab: 61, back: 4};
    expect(keyOf('back', keys)).toEqual({code: 4, meta: 0});
    expect(keyOf('ctrl+c', keys)).toEqual({code: 31, meta: 0x3000});
    expect(keyOf('ctrl+shift+tab', keys)).toEqual({code: 61, meta: 0x3041});
    expect(keyOf('7', keys)).toEqual({code: 14, meta: 0});
    expect(keyOf('264', keys)).toEqual({code: 264, meta: 0});
    expect(() => keyOf('hyper+x', keys)).toThrow(/unknown modifier/);
    expect(() => keyOf('nosuchkey', keys)).toThrow(/unknown key/);
  });

  it('reads fold states and finds the app task', async () => {
    const {parseDeviceStates, taskIdOf} = await import('./drivers/android/formfactor.ts');
    const states = "Supported states: [\n  DeviceState{identifier=0, name='CLOSED', app_accessible=true},\n  DeviceState{identifier=1, name='HALF_OPENED', app_accessible=true},\n]";
    expect(parseDeviceStates(states)).toEqual([{id: '0', name: 'CLOSED'}, {id: '1', name: 'HALF_OPENED'}]);
    const dump = '  * Task{1a2b #12 type=home A=10001:com.example.launcher}\n  * Task{3c4d #63 type=standard A=10222:com.example.app U=0 visible=true}\n';
    expect(taskIdOf(dump, 'com.example.app')).toBe('63');
    expect(taskIdOf(dump, 'com.example')).toBeUndefined();
  });

  it('folds to a state and dismisses the keyguard folding put up', async () => {
    const {posture} = await import('./drivers/android/formfactor.ts');
    const calls: string[] = [];
    const shell = async (_s: string, c: string) => {
      calls.push(c);
      return c.includes('print-states') ? "DeviceState{identifier=0, name='CLOSED'}\nDeviceState{identifier=3, name='OPENED'}" : '';
    };
    await posture(shell, 'emulator-5554', 'closed');
    expect(calls).toEqual(['cmd device_state print-states', 'cmd device_state state 0', 'input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard']);
  }, 10_000);
});

describe('watch and window helpers', () => {
  it('reads Wear OS debug broadcast results', async () => {
    const {parseBroadcast} = await import('./drivers/android/formfactor.ts');
    expect(parseBroadcast('Broadcast completed: result=1, data="Index=[0]"')).toEqual({ok: true, data: 'Index=[0]', code: 1});
    expect(parseBroadcast('Broadcast completed: result=2, data="set-watchface failed."')).toMatchObject({ok: false, code: 2});
    expect(parseBroadcast('Broadcast completed: result=0')).toMatchObject({ok: false, code: 0});
  });

  it('swipes in the topmost app window, not a larger scroller behind it', async () => {
    const {buildSnapshot, swipeArea} = await import('./ui/snapshot.ts');
    const windows = [
      {type: 'app', title: 'small app window', pkg: 'com.example.app'},
      {type: 'app', title: 'launcher', pkg: 'com.example.launcher'},
    ];
    const snap = buildSnapshot(windows, [
      {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 600, 900]},
      {p: 0, w: 0, c: 'ScrollView', b: [0, 200, 600, 900], f: 's'},
      {p: -1, w: 1, c: 'FrameLayout', b: [0, 0, 3840, 2160]},
      {p: 2, w: 1, c: 'RecyclerView', b: [0, 0, 3840, 2100], f: 's'},
    ]);
    expect(swipeArea(snap, 3840, 2160)).toEqual([0, 200, 600, 900]);
  });
});

describe('screens', () => {
  it('finds the lit screen of a foldable and the png after screencap warnings', async () => {
    const {physicalDisplays, pngFrom} = await import('./drivers/android/formfactor.ts');
    const dump = '  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:111", 1080 x 2364, state OFF, x}\n  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:222", 2076 x 2152, state ON, y}\n  DisplayDeviceInfo{"Overlay": uniqueId="overlay:1", state ON}';
    expect(physicalDisplays(dump)).toEqual([{id: '111', on: false}, {id: '222', on: true}]);
    const png = Buffer.concat([Buffer.from('[Warning] Multiple displays were found\n'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2])]);
    expect([...pngFrom(png)]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2]);
  });
});

describe('trace lookup', () => {
  it("finds an action's trace id in the stand's service logs, and says so when nothing logged it", async () => {
    const {Engine} = await import('./daemon/engine.ts');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({services: {api: {start: 'node api.js'}, db: {start: 'node db.js'}}}));
    const engine = await Engine.create(path.join(dir, 'pitbox.config.json'));
    const id = 'ab'.repeat(16);
    fs.mkdirSync(path.dirname(engine.services.logFile('api')), {recursive: true});
    fs.writeFileSync(engine.services.logFile('api'), `GET /health\nGET /feed trace=${id} 200 12ms\nPOST /like trace=${'cd'.repeat(16)}\nSELECT * FROM feed -- trace=${id}\n`);
    fs.writeFileSync(engine.services.logFile('db'), 'ready\n');
    const r = (await engine.methods.trace({id: id.toUpperCase()})) as {found: {name: string; lines: string[]}[]; searched: number};
    expect(r.searched).toBe(2);
    expect(r.found).toEqual([{name: 'api', lines: [`GET /feed trace=${id} 200 12ms`, `SELECT * FROM feed -- trace=${id}`]}]);
    await expect(engine.methods.trace({})).rejects.toThrow(/no action has carried a trace yet/);
    await expect(engine.methods.trace({id: 'nope'})).rejects.toThrow(/32 hex characters/);
  });
});

describe('android perf', () => {
  it('reports no frame times when nothing was drawn, not the empty histogram top bucket', async () => {
    const {AndroidDriver} = await import('./drivers/android/driver.ts');
    const {formatResult} = await import('./format.ts');
    const gfx = 'Total frames rendered: 0\nJanky frames: 0 (0.00%)\n50th percentile: 4950ms\n90th percentile: 4950ms\n99th percentile: 4950ms\n';
    const driver = Object.create(AndroidDriver.prototype) as InstanceType<typeof AndroidDriver>;
    driver.shell = async (_serial: string, command: string) => (command.includes('gfxinfo') ? gfx : '        TOTAL PSS:   724000');
    const r = await driver.perf('emulator-5554', 'com.example.app');
    expect(r).toMatchObject({frames: 0, p50: undefined, p90: undefined, p99: undefined, memoryMb: 707});
    const text = formatResult('perf', r);
    expect(text).toMatch(/^frames 0 — nothing drawn since the reset/);
    expect(text).not.toContain('4950');
  });
});

describe('xr emulator surroundings', () => {
  it('reads back the options it writes', async () => {
    const {decodeXrOptions, encode} = await import('./drivers/android/emulatorGrpc.ts');
    expect(decodeXrOptions(Buffer.alloc(0))).toEqual({environment: 0, passthrough: 0, dimming: 0});
    const o = decodeXrOptions(encode.xrOptions({environment: 1, passthrough: 1, dimming: 0.5}));
    expect(o).toEqual({environment: 1, passthrough: 1, dimming: 0.5});
    // What the emulator answered for night with full passthrough.
    expect(decodeXrOptions(Buffer.from('0801150000803f', 'hex'))).toEqual({environment: 1, passthrough: 1, dimming: 0});
  });
});

describe('answers of the stand and the forwards', () => {
  it('say which actor stopped and where the ports were forwarded', async () => {
    const {formatResult} = await import('./format.ts');
    expect(formatResult('actorStop', {name: 'p1', type: 'peer', port: 5, pid: 9})).toBe('stopped actor p1 (peer)');
    expect(formatResult('reverse', {applied: [{serial: 'emulator-5554', ports: [4100]}], ports: [4100]})).toBe('forwarded to devices: 4100 · set up on emulator-5554');
    expect(formatResult('reverse', {applied: [], ports: [4100], devices: 1})).toBe('forwarded to devices: 4100 · already in place');
    expect(formatResult('reverse', {applied: [], ports: [4100], devices: 0})).toBe('forwarded to devices: 4100 · no Android device online');
  });

  it('report an app that is not running instead of failing on pidof', async () => {
    const {AndroidDriver} = await import('./drivers/android/driver.ts');
    const d = new AndroidDriver();
    (d as unknown as {shell: () => Promise<string>}).shell = async () => {
      throw new Error('adb shell failed: pidof com.example.app');
    };
    expect(await d.logs('emulator-5554', {pkg: 'com.example.app'})).toEqual(['(com.example.app is not running)']);
  });
});

describe('network back online', () => {
  it('waits for the device to have a network again', async () => {
    const {AndroidDriver} = await import('./drivers/android/driver.ts');
    const d = new AndroidDriver();
    let polls = 0;
    (d as unknown as {shell: (s: string, c: string) => Promise<string>}).shell = async (_s, c) => (c.startsWith('dumpsys') ? (++polls < 3 ? 'Active default network: none' : 'Active default network: 108') : '');
    expect(await d.network('emulator-5554', 'online')).toMatch(/^airplane mode off · connected in \d/);
    expect(polls).toBe(3);
  }, 10_000);
});

describe('a cold start', () => {
  it("waits for the stopped app's window to go before it launches again", async () => {
    const {AndroidDriver} = await import('./drivers/android/driver.ts');
    const d = new AndroidDriver();
    const calls: string[] = [];
    let left = 2;
    (d as unknown as {shell: (s: string, c: string) => Promise<string>}).shell = async (_s, c) => {
      calls.push(c.split(' ').slice(0, 3).join(' '));
      if (c.startsWith('dumpsys window')) return String(left-- > 0 ? 1 : 0);
      if (c.startsWith('am start')) return 'TotalTime: 300';
      return '';
    };
    (d as unknown as {launcherActivity: () => Promise<string>}).launcherActivity = async () => 'com.example.app/.Main';
    expect(await d.open('emulator-5554', 'com.example.app', {relaunch: true})).toMatchObject({totalMs: 300});
    expect(calls.filter(c => c.startsWith('dumpsys window'))).toHaveLength(3);
    expect(calls.indexOf('am start -W')).toBeGreaterThan(calls.lastIndexOf('dumpsys window windows'));
  });
});

describe('the device list', () => {
  it('says why there are no simulators when they cannot be read', async () => {
    const {formatResult} = await import('./format.ts');
    expect(formatResult('devices', {devices: [], avds: [], simulators: [], simulatorsError: 'the Mac at http://mac.example.test:7700 refused the token'})).toBe('no devices online\n✗ simulators: the Mac at http://mac.example.test:7700 refused the token');
  });
});

describe('paths in answers', () => {
  it('shows a path under the project with forward slashes, on Windows too', () => {
    expect(shownPath('/p', '/p/.pitbox/downloads/demo/a.pdf', path.posix)).toBe('.pitbox/downloads/demo/a.pdf');
    expect(shownPath('C:\\work\\p', 'C:\\work\\p\\.pitbox\\downloads\\demo', path.win32)).toBe('.pitbox/downloads/demo');
  });
});

describe('the npm package', () => {
  it('ships every Apple runner source directory that pitbox builds on the Mac', () => {
    const files: string[] = JSON.parse(fs.readFileSync('package.json', 'utf8')).files;
    const shipped = (p: string) => files.some(f => f === p || f.startsWith(`${p}/`) || p.startsWith(`${f}/`));
    const missing = fs.readdirSync('runners/apple').filter(e => !e.startsWith('.')).map(e => `runners/apple/${e}`).filter(p => !shipped(p));
    expect(missing).toEqual([]);
  });
});

describe('android runner start', () => {
  it('passes --no-hidden-api-checks only where am takes it (API 28 and later)', () => {
    expect(instrumentCommand(26)).not.toContain('--no-hidden-api-checks');
    expect(instrumentCommand(27)).not.toContain('--no-hidden-api-checks');
    expect(instrumentCommand(28)).toContain('--no-hidden-api-checks');
    expect(instrumentCommand(36)).toContain('--no-hidden-api-checks');
    // An unreadable level keeps the option, as before.
    expect(instrumentCommand(Number.NaN)).toContain('--no-hidden-api-checks');
    expect(instrumentCommand(26)).toMatch(/^rm -f \S+; nohup am instrument -w -r -e port \d+ dev\.pitbox\.runner\/\.RunnerInstrumentation > \S+ 2>&1 &$/);
  });
});
