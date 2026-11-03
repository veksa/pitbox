// The JS runtime tools: source map lookups, the in-app helper (run in a vm), and evaluate + logpoints end to end
// against a fake inspector proxy that answers like a Hermes page.

import http from 'node:http';
import vm from 'node:vm';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {WebSocketServer} from 'ws';
import {pickPage, type CdpPage} from './devserver/cdp.ts';
import {checkExprs, conditionFor, JsDebugger, mapPathOf, parseAt} from './devserver/jsdebug.ts';
import type {DevProxy} from './devserver/proxy.ts';
import {summarizeProfile, type CpuProfile} from './devserver/jsprofile.ts';
import {bundlePosition, decodeSegment, displayPath, indexMap, sourceOf, type RawSourceMap} from './devserver/sourcemap.ts';
import {freePort} from './util/net.ts';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (n: number) => {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let d = v & 31;
    v >>>= 5;
    if (v) d |= 32;
    out += B64[d];
  } while (v);
  return out;
};

/** Mappings from absolute [genCol, src, line0, col] per generated line, encoded as a source map does. */
const encode = (lines: [number, number, number, number][][]) => {
  let src = 0;
  let ol = 0;
  let oc = 0;
  return lines
    .map(segs => {
      let gc = 0;
      return segs
        .map(([c, s, l, o]) => {
          const seg = vlq(c - gc) + vlq(s - src) + vlq(l - ol) + vlq(o - oc);
          gc = c;
          src = s;
          ol = l;
          oc = o;
          return seg;
        })
        .join(',');
    })
    .join(';');
};

// Two modules, as a bundler serves them: an indexed map with one section per module.
const map: RawSourceMap = {
  sections: [
    {offset: {line: 0, column: 0}, map: {sources: ['/[metro-project]/node_modules/lib/index.js'], mappings: encode([[[0, 0, 0, 0]]])}},
    {
      offset: {line: 10, column: 0},
      map: {
        sources: ['/[metro-project]/src/screens/Home.tsx', '/[metro-project]/src/other/Home.tsx'],
        // Line 3 of Home.tsx runs at bundle 10:4 and 10:12; line 4 has no code; line 6 at 12:2; the other Home at 13:0.
        mappings: encode([[[12, 0, 2, 8], [4, 0, 2, 2]], [], [[2, 0, 5, 0]], [[0, 1, 0, 0]]].map(l => [...l].sort((a, b) => a[0] - b[0]))),
      },
    },
  ],
};

describe('source maps', () => {
  it('decodes VLQ segments, negative values included', () => {
    expect(decodeSegment('AAgBC')).toEqual([0, 0, 16, 1]);
    expect(decodeSegment(vlq(-5) + vlq(1234))).toEqual([-5, 1234]);
  });

  it('finds the first bundle position of a source line in an indexed map', () => {
    expect(bundlePosition(map, 'src/screens/Home.tsx', 3)).toEqual({source: 'src/screens/Home.tsx', line: 3, at: {line: 10, column: 4}});
  });

  it('moves to the next line with code, and says when there is none', () => {
    expect(bundlePosition(map, 'screens/Home.tsx', 4)).toMatchObject({line: 6, at: {line: 12, column: 2}});
    expect(() => bundlePosition(map, 'screens/Home.tsx', 40)).toThrow(/no code at screens\/Home.tsx:40/);
  });

  it('asks for more of the path when a file name is ambiguous, and names a missing file', () => {
    expect(() => bundlePosition(map, 'Home.tsx', 3)).toThrow(/matches 2 files: src\/screens\/Home.tsx, src\/other\/Home.tsx/);
    expect(() => bundlePosition(map, 'Nope.tsx', 1)).toThrow(/is not in the bundle/);
  });

  it('maps a bundle position back to its source line, a function start before the first mapped token included', () => {
    const ix = indexMap(map);
    expect(sourceOf(ix, 10, 0)).toEqual({source: 'src/screens/Home.tsx', line: 3});
    expect(sourceOf(ix, 10, 99)).toEqual({source: 'src/screens/Home.tsx', line: 3});
    expect(sourceOf(ix, 11, 0)).toEqual({source: 'src/screens/Home.tsx', line: 6});
    expect(sourceOf(ix, 0, 0)).toEqual({source: 'node_modules/lib/index.js', line: 1});
    expect(sourceOf(ix, 500, 0)).toBeUndefined();
  });

  it('shows paths without the bundler root placeholder', () => {
    expect(displayPath('/[metro-project]/node_modules/%40scope/pkg/a.js')).toBe('node_modules/@scope/pkg/a.js');
    expect(displayPath('/[metro-project]/src/App.tsx')).toBe('src/App.tsx');
    expect(displayPath('C:\\app\\App.tsx')).toBe('C:/app/App.tsx');
  });
});

describe('logpoint inputs', () => {
  it('parses file:line, a drive letter included', () => {
    expect(parseAt('src/App.tsx:42')).toEqual({file: 'src/App.tsx', line: 42});
    expect(parseAt('C:\\app\\App.tsx:7')).toEqual({file: 'C:\\app\\App.tsx', line: 7});
    expect(() => parseAt('App.tsx')).toThrow(/<file>:<line>/);
  });

  it('rejects an expression that does not parse, since a broken condition fails without a word', () => {
    expect(() => checkExprs(['user.id', 'items.length > 2'])).not.toThrow();
    expect(() => checkExprs(['a +'])).toThrow(/cannot log "a \+"/);
  });

  it('turns a runtime script URL into the bundler path of its source map', () => {
    expect(mapPathOf('http://127.0.0.1:8081/index.bundle?platform=android&dev=true')).toBe('/index.map?platform=android&dev=true');
    expect(mapPathOf('http://10.0.2.2:8081/index.bundle//&platform=android&lazy=true')).toBe('/index.map?platform=android&lazy=true');
  });

  it('picks the page of a named device, or the only one for a serial it cannot see', () => {
    const page = (id: string, deviceName: string): CdpPage => ({id, title: `app (${deviceName})`, deviceName, webSocketDebuggerUrl: `ws://x/${id}`});
    const two = [page('a', 'Pixel 9 - API 36'), page('b', 'iPhone 17')];
    expect(pickPage(two)?.id).toBe('b');
    expect(pickPage(two, 'pixel')?.id).toBe('a');
    expect(pickPage(two, 'emulator-5554')).toBeUndefined();
    expect(pickPage([two[0]!], 'emulator-5554')?.id).toBe('a');
    // A relaunch: the old runtime of the same device is still listed next to the new one.
    expect(pickPage([page('old', 'Pixel 9 - API 36'), page('new', 'Pixel 9 - API 36')], 'emulator-5554')?.id).toBe('new');
  });
});

// A sampled call tree: a library function calls the app's `render`; a host function runs on its own; the rest
// is the thread waiting. One sample per millisecond.
const profileOf = (bundle: string): CpuProfile => ({
  startTime: 0,
  endTime: 7000,
  nodes: [
    {id: 1, callFrame: {functionName: '[root]', url: '[root]', lineNumber: 0, columnNumber: 0}, children: [2, 4]},
    {id: 2, callFrame: {functionName: 'dispatch', url: bundle, lineNumber: 0, columnNumber: 0}, children: [3]},
    {id: 3, callFrame: {functionName: 'render', url: bundle, lineNumber: 10, columnNumber: 0}},
    {id: 4, callFrame: {functionName: '[Host Function] setTimeout', url: '[host]', lineNumber: 0, columnNumber: 0}},
  ],
  samples: [1, 1, 3, 3, 3, 2, 4],
});

describe('js profiles', () => {
  it('adds up the lines of one function, under its first line', async () => {
    const {mergeByFunction} = await import('./devserver/jsdebug.ts');
    expect(mergeByFunction([{at: 'work  App.tsx:16', ms: 36}, {at: 'other  App.tsx:3', ms: 50}, {at: 'work  App.tsx:14', ms: 120}, {at: 'setTimeout (native)', ms: 5}])).toEqual([
      {at: 'work  App.tsx:14', ms: 156},
      {at: 'other  App.tsx:3', ms: 50},
      {at: 'setTimeout (native)', ms: 5},
    ]);
  });

  it('sums up busy time, self time and time with callees, leaving the waiting out', () => {
    const s = summarizeProfile(profileOf('http://x/index.bundle'));
    expect(s).toMatchObject({ms: 7, busyMs: 5, samples: 7});
    expect(s.self.map(x => [x.fn.name, x.ms])).toEqual([['render', 3], ['dispatch', 1], ['[Host Function] setTimeout', 1]]);
    expect(s.total.map(x => [x.fn.name, x.ms])).toEqual([['dispatch', 4], ['render', 3], ['[Host Function] setTimeout', 1]]);
  });
});

// ---- a fake Hermes page behind an inspector proxy ------------------------------------------------------------

type Fake = {port: number; origins: string[]; app: vm.Context; reparse: () => void; breakpoints: Map<string, {line: number; column: number; condition: string}>; runLine: (locals: Record<string, unknown>) => void; pauseLine: (locals: Record<string, unknown>) => Promise<void>; resumed: () => number; close: () => Promise<void>};

/** `allow`: which origins the inspector takes (a refused one gets 401, as React Native's verifyClient answers). */
const fakeInspector = async (allow?: (origin: string) => boolean): Promise<Fake> => {
  const port = await freePort();
  const app = vm.createContext({console});
  const breakpoints = new Map<string, {line: number; column: number; condition: string}>();
  const origins: string[] = [];
  const bundle = `http://127.0.0.1:${port}/index.bundle?platform=android&dev=true`;
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.end(JSON.stringify([{id: 'd-1', title: 'com.example.app (sdk_phone)', deviceName: 'sdk_phone', webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug?device=d&page=1`}]));
    } else if (req.url?.startsWith('/index.map')) {
      res.end(JSON.stringify(map));
    } else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({server, verifyClient: info => !allow || allow(info.origin)});
  let seq = 0;
  let resumed = 0;
  let frameLocals: Record<string, unknown> = {};
  const frameEval = (expression: string) => {
    const frame = vm.createContext(Object.assign(Object.create(null), frameLocals));
    Object.defineProperty(frame, 'globalThis', {value: vm.runInContext('globalThis', app)});
    return vm.runInContext(expression, frame);
  };
  wss.on('connection', (ws, req) => {
    origins.push(String(req.headers.origin));
    ws.on('message', raw => {
      const {id, method, params} = JSON.parse(String(raw));
      const reply = (result: unknown) => ws.send(JSON.stringify({id, result}));
      if (method === 'Runtime.evaluate') {
        try {
          const value = vm.runInContext(params.expression, app);
          reply({result: {type: typeof value, value: JSON.parse(JSON.stringify(value ?? null))}});
        } catch (e) {
          reply({result: {type: 'object'}, exceptionDetails: {text: 'Uncaught', exception: {description: String(e)}}});
        }
      } else if (method === 'Debugger.enable') {
        ws.send(JSON.stringify({method: 'Debugger.scriptParsed', params: {scriptId: '3', url: bundle}}));
        reply({});
      } else if (method === 'Debugger.setBreakpoint') {
        const breakpointId = String(++seq);
        breakpoints.set(breakpointId, {...params.location, condition: params.condition});
        reply({breakpointId, actualLocation: {scriptId: '3', lineNumber: params.location.lineNumber, columnNumber: params.location.columnNumber}});
      } else if (method === 'Profiler.stop') {
        reply({profile: profileOf(bundle)});
      } else if (method === 'Debugger.evaluateOnCallFrame') {
        reply({result: {type: 'boolean', value: frameEval(params.expression)}});
      } else if (method === 'Debugger.resume') {
        resumed++;
        reply({});
      } else if (method === 'Debugger.removeBreakpoint') {
        breakpoints.delete(params.breakpointId);
        reply({});
      } else reply({});
    });
  });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()));
  return {
    port,
    origins,
    app,
    // A reload: the runtime parses a new main bundle in the same session.
    reparse: () => {
      for (const c of wss.clients) c.send(JSON.stringify({method: 'Debugger.scriptParsed', params: {scriptId: String(++seq + 100), url: bundle}}));
    },
    breakpoints,
    // The runtime reaching the line: each condition is evaluated with the frame's locals in scope.
    runLine: locals => {
      for (const bp of breakpoints.values()) {
        const frame = vm.createContext(Object.assign(Object.create(null), locals));
        Object.defineProperty(frame, 'globalThis', {value: vm.runInContext('globalThis', app)});
        expect(vm.runInContext(bp.condition, frame)).toBe(false);
      }
    },
    // A runtime that ignores breakpoint conditions: it stops at each breakpoint of the line instead.
    pauseLine: async locals => {
      frameLocals = locals;
      for (const bp of breakpoints.values()) {
        const before = resumed;
        // Stored as the CDP location it was set at.
        const {lineNumber, columnNumber} = bp as unknown as {lineNumber: number; columnNumber: number};
        const callFrames = [{callFrameId: 'f1', functionName: 'Home', location: {scriptId: '3', lineNumber, columnNumber}}];
        for (const c of wss.clients) c.send(JSON.stringify({method: 'Debugger.paused', params: {reason: 'other', callFrames}}));
        for (const end = Date.now() + 2000; resumed === before && Date.now() < end; ) await new Promise(r => setTimeout(r, 10));
      }
    },
    resumed: () => resumed,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>(r => server.close(() => r()));
    },
  };
};

describe('the app runtime', () => {
  let fake: Fake;
  let js: JsDebugger;
  const proxy = {opts: {bytecode: {}}, servedKind: new Map(), debugSource: false, generation: 0} as unknown as DevProxy;

  beforeAll(async () => {
    fake = await fakeInspector();
    js = new JsDebugger(proxy, fake.port, async () => undefined);
  });
  afterAll(async () => {
    js.stop();
    await fake.close();
  });

  it('evaluates in the global scope with a local origin, and formats values compactly', async () => {
    expect(await js.evaluate('1 + 1')).toMatchObject({value: '2', app: 'sdk_phone', apps: 1});
    expect(fake.origins[0]).toBe(`http://localhost:${fake.port}`);
    const r = await js.evaluate('var a = {n: [1, "x"], f: function go() {}, m: new Map([[1, 2]]), long: Array.from({length: 30}, (_, i) => i)}; a.self = a; a');
    expect(r.value).toBe('{n: [1, "x"], f: ƒ go, m: Map(1) {1 => 2}, long: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, … 10 more], self: [Circular]}');
    expect(await js.evaluate('nope.x')).toMatchObject({error: expect.stringMatching(/ReferenceError: nope is not defined/)});
  });

  it('presents the origins it is given in order, moving on when one is refused', async () => {
    const strict = await fakeInspector(o => o === 'http://localhost:8081');
    const ok = new JsDebugger(proxy, strict.port, async () => undefined, ['http://192.0.2.1:8081', 'http://localhost:8081']);
    try {
      expect(await ok.evaluate('2 + 2')).toMatchObject({value: '4'});
      expect(strict.origins).toEqual(['http://localhost:8081']);
      const refused = new JsDebugger(proxy, strict.port, async () => undefined, ['http://192.0.2.1:8081']);
      await expect(refused.evaluate('1')).rejects.toThrow(/refused origin http:\/\/192\.0\.2\.1:8081 \(401\)/);
      refused.stop();
    } finally {
      ok.stop();
      await strict.close();
    }
  });

  it('awaits a promise the expression returns', async () => {
    expect(await js.evaluate('Promise.resolve().then(() => ({ok: true}))')).toMatchObject({value: '{ok: true}'});
    expect(await js.evaluate('Promise.reject(new TypeError("no"))')).toMatchObject({error: 'TypeError: no'});
    // `await` at the top, as an expression and in statements.
    expect(await js.evaluate('await Promise.resolve(3)')).toMatchObject({value: '3'});
    expect(await js.evaluate('const w = await Promise.resolve(4); globalThis.w4 = w')).toMatchObject({value: 'undefined'});
    expect(await js.evaluate('w4')).toMatchObject({value: '4'});
  });

  it('logs the values at a source line each time it runs, each expression on its own', async () => {
    const {logpoint} = await js.log('screens/Home.tsx:3', ['user.name', 'missing', 'items.length']);
    expect(logpoint).toMatchObject({id: 'lp1', source: 'src/screens/Home.tsx', codeLine: 3, at: {line: 10, column: 4}});
    expect(proxy.debugSource).toBe(true);
    fake.runLine({user: {name: 'Ann'}, items: [1, 2]});
    fake.runLine({user: {name: 'Bob'}, items: []});
    const {logpoints} = await js.hits();
    expect(logpoints[0]!.count).toBe(2);
    expect(logpoints[0]!.hits.map(h => h.v)).toEqual(['"Ann"  ! ReferenceError: missing is not defined  2', '"Bob"  ! ReferenceError: missing is not defined  0']);
  });

  it('records a logpoint from the paused frame when the runtime stops instead of evaluating the condition', async () => {
    const before = fake.resumed();
    await fake.pauseLine({user: {name: 'Cy'}, items: [1]});
    expect(fake.resumed()).toBe(before + 1);
    const {logpoints, paused} = await js.hits();
    expect(logpoints[0]!.count).toBe(3);
    expect(logpoints[0]!.hits.at(-1)!.v).toBe('"Cy"  ! ReferenceError: missing is not defined  1');
    // Not counted as a stop at someone else's breakpoint.
    expect(paused ?? 0).toBe(0);
  });

  it('removes the breakpoints and goes back to bytecode with no logpoints left', async () => {
    expect(await js.clear()).toEqual({cleared: ['lp1'], bytecodeBack: true});
    expect(fake.breakpoints.size).toBe(0);
    expect(proxy.debugSource).toBe(false);
    await expect(js.log('Nope.tsx:1', [])).rejects.toThrow(/is not in the bundle/);
    expect(proxy.debugSource).toBe(false);
  });

  it('reloads an app that says it runs bytecode, even when the proxy remembers nothing (a daemon restart)', async () => {
    vm.runInContext('globalThis.__pitbox = {fromSource: false}', fake.app);
    let reloads = 0;
    const fresh = new JsDebugger(proxy, fake.port, async () => {
      reloads++;
      vm.runInContext('globalThis.__pitbox.fromSource = true', fake.app);
      setTimeout(() => fake.reparse(), 50);
    });
    try {
      const r = await fresh.log('screens/Home.tsx:6', ['x']);
      expect(r.reloaded).toBe(true);
      expect(reloads).toBe(1);
      expect((await fresh.log('screens/Home.tsx:3', [])).reloaded).toBe(false);
    } finally {
      fresh.stop();
      vm.runInContext('delete globalThis.__pitbox', fake.app);
    }
  });

  it('profiles the JS thread and names the app code apart from libraries and native functions', async () => {
    expect(await js.profileStart()).toBe(true);
    const p = await js.profileStop();
    expect(p).toMatchObject({ms: 7, busyMs: 5});
    expect(p!.self).toEqual([
      {at: 'render  src/screens/Home.tsx:3', ms: 3},
      {at: 'dispatch  node_modules/lib/index.js:1', ms: 1},
      {at: '[Host Function] setTimeout (native)', ms: 1},
    ]);
    expect(p!.app).toEqual([{at: 'render  src/screens/Home.tsx:3', ms: 3}]);
    expect(await js.profileStop()).toBeUndefined();
  });

  it('records a hit without expressions', () => {
    const ctx = vm.createContext({});
    vm.runInContext(`globalThis.__pitboxJs = {hits: [], hit: function (id, fs) { this.hits.push([id, fs.length]); return false; }}`, ctx);
    expect(vm.runInContext(conditionFor('lp9', []), ctx)).toBe(false);
    expect(vm.runInContext('globalThis.__pitboxJs.hits', ctx)).toEqual([['lp9', 0]]);
  });
});

describe('eval answers', () => {
  it('name the app when several are debuggable, and ask for a device only when none was named', async () => {
    const {formatResult} = await import('./format.ts');
    expect(formatResult('jsEval', {value: '42', app: 'iPhone 18 Pro', apps: 2, ms: 3})).toBe('= 42  (in iPhone 18 Pro; 2 apps are debuggable — pick one with device)');
    expect(formatResult('jsEval', {value: '42', app: 'iPhone 18 Pro', apps: 2, picked: true, ms: 3})).toBe('= 42  (in iPhone 18 Pro)');
    expect(formatResult('jsEval', {value: '42', app: 'Pixel', apps: 1, ms: 3})).toBe('= 42');
  });
});
