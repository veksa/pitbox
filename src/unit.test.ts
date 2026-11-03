import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {failed, parseArgs, toCall} from './cli.ts';
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
    const commands = ['up', 'down', 'restart', 'status', 'logs x', 'tools', 'tool x', 'actors', 'actor start a b', 'actor stop a', 'actor call a', 'devices', 'boot', 'shutdown', 'install a.apk', 'open', 'stop-app', 'clear-app', 'uninstall', 'apps', 'app-logs', 'settings', 'network full', 'screenshot', 'key back', 'reverse', 'info', 'doctor', 'docs', 'dev status', 'dev prewarm', 'dev reload', 'dev restart', 'snapshot', 'press a', 'longpress a', 'doubletap a', 'fill a b', 'type a', 'swipe up', 'scroll down until a', 'wait a', 'focus', 'shot', 'run f', 'goto r', 'as u', 'record start', 'record stop', 'fresh', 'app-log', 'net clear', 'media', 'touch up', 'focusmap', 'state list', 'state save a', 'state restore a', 'state rm a', 'perf', 'visual a', 'matrix f', 'app-tree', 'app-errors'];
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
