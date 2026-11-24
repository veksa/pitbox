import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {AppleRunner, runnerNotice, sourceHash} from './drivers/apple/runner.ts';
import {AppleCrashWatcher, keptReports, parseIps} from './drivers/apple/crashes.ts';
import {fmtDevices} from './format.ts';
import {buildSnapshot, menuOutside, onlyClosedKeyboard, swipeArea} from './ui/snapshot.ts';
import {AppleDriver, appProcess, contentSize, foldState, isAppleBundle, parseDisplays, parseSimulatorBoots, parseSimulators, pickSimulator, runtimeName, simKind, simulatorWindowApp, listFailure} from './drivers/apple/driver.ts';

vi.mock('./drivers/apple/fold.ts', () => ({foldTool: async () => '/tmp/fold'}));

const list = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      {udid: 'AAA', name: 'iPhone 17', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17'},
      {udid: 'BBB', name: 'iPad Air', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air'},
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-27-1': [{udid: 'CCC', name: 'iPhone 17', state: 'Shutdown', isAvailable: true}],
    'com.apple.CoreSimulator.SimRuntime.tvOS-27-2': [{udid: 'DDD', name: 'Apple TV 4K', state: 'Shutdown', isAvailable: false}],
  },
});

describe('apple driver', () => {
  it('names runtimes and kinds', () => {
    expect(runtimeName('com.apple.CoreSimulator.SimRuntime.iOS-27-1')).toBe('iOS 27.1');
    expect(runtimeName('com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4')).toBe('iOS 27.2');
    expect(simKind('tvOS 27.2', 'Apple TV')).toBe('tv');
    expect(simKind('xrOS 3.0', 'Apple Vision Pro')).toBe('xr');
    expect(simKind('iOS 27.0', 'com.apple.CoreSimulator.SimDeviceType.iPad-Air')).toBe('tablet');
    expect(simKind('iOS 27.1', 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo')).toBe('foldable');
  });

  it('finds the lit screen of a foldable and whether it is folded', () => {
    const screen = (id: number, w: number, h: number, active: boolean) => ({displayId: id, name: `LCD-${id}`, active, backlightState: active ? 'activeOn' : 'off', primary: id === 1, nativeSize: [w, h]});
    const folded = parseDisplays({result: {displays: [screen(1, 1398, 2034, true), screen(3, 2007, 2853, false)]}});
    expect(folded.find(d => d.active)?.id).toBe(1);
    expect(foldState(folded)).toBe('folded: cover screen 1398x2034');
    const open = parseDisplays({result: {displays: [screen(1, 1398, 2034, false), screen(3, 2007, 2853, true)]}});
    expect(foldState(open)).toBe('open: inner screen 2007x2853');
    // A screen that says active but has its backlight off is not the one on show.
    expect(parseDisplays({result: {displays: [{...screen(1, 10, 10, true), backlightState: 'off'}]}})[0]?.active).toBe(false);
    expect(foldState(parseDisplays({result: {displays: [screen(1, 1179, 2556, true)]}}))).toBeUndefined();
  });

  it('parses simctl devices and picks by udid or name, newest runtime first', () => {
    const sims = parseSimulators(list);
    expect(sims).toHaveLength(4);
    expect(sims.find(s => s.udid === 'DDD')?.available).toBe(false);
    expect(pickSimulator(sims, 'bbb')?.name).toBe('iPad Air');
    expect(pickSimulator(sims, 'iPhone 17')?.udid).toBe('CCC');
    expect(pickSimulator(sims, 'iPhone 17 (iOS 27.0)')?.udid).toBe('AAA');
    expect(pickSimulator(sims, 'Pixel 8')).toBeUndefined();
  });

  it('prefers a booted simulator when names repeat', () => {
    const sims = parseSimulators(list).map(s => (s.udid === 'AAA' ? {...s, state: 'Booted'} : s));
    expect(pickSimulator(sims, 'iPhone 17')?.udid).toBe('AAA');
  });

  it('maps font scales to dynamic type categories', () => {
    expect(contentSize(1)).toBe('large');
    expect(contentSize(0.85)).toBe('small');
    expect(contentSize(1.3)).toBe('extra-extra-large');
    expect(contentSize(2)).toBe('accessibility-large');
    expect(contentSize(9)).toBe('accessibility-extra-extra-extra-large');
  });

  it('tells apple bundles from apks', () => {
    expect(isAppleBundle('build/MyApp.app')).toBe(true);
    expect(isAppleBundle('build/MyApp.app/')).toBe(true);
    expect(isAppleBundle('MyApp.ipa')).toBe(true);
    expect(isAppleBundle('app-debug.apk')).toBe(false);
  });

  it('rebuilds the runner when a source changes, not when xcuserdata does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-runner-'));
    fs.mkdirSync(path.join(dir, 'Runner'));
    fs.writeFileSync(path.join(dir, 'Runner', 'A.swift'), 'let a = 1');
    const first = sourceHash(dir);
    fs.mkdirSync(path.join(dir, 'xcuserdata'));
    fs.writeFileSync(path.join(dir, 'xcuserdata', 'state'), 'x');
    expect(sourceHash(dir)).toBe(first);
    fs.writeFileSync(path.join(dir, 'Runner', 'A.swift'), 'let a = 2');
    expect(sourceHash(dir)).not.toBe(first);
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5});
    // Synchronous from end to end, so a time limit could never stop it hanging: it would only fail it when the
    // machine stalls file writes for a while, as a loaded Windows runner does while other tests start processes.
  }, 60_000);

  const ips = (o: {bundle?: string; udid?: string; bug?: string; exception?: boolean; at?: string} = {}) =>
    `${JSON.stringify({bug_type: o.bug ?? '309', bundleID: o.bundle ?? 'com.example.app', name: 'MyApp', timestamp: `${o.at ?? '2026-01-02 10:00:00'}.00 +0200`})}\n${JSON.stringify({
      procPath: `/Users/u/Library/Developer/CoreSimulator/Devices/${o.udid ?? 'AAA'}/data/Containers/Bundle/Application/X/MyApp.app/MyApp`,
      captureTime: `${o.at ?? '2026-01-02 10:00:00'}.1234 +0200`,
      exception: {type: o.exception ? 'EXC_CRASH' : 'EXC_BREAKPOINT', signal: o.exception ? 'SIGABRT' : 'SIGTRAP'},
      asi: o.exception ? {CoreFoundation: ["*** Terminating app due to uncaught exception 'NSInvalidArgumentException'"]} : undefined,
      lastExceptionBacktrace: o.exception ? [{imageIndex: 0, symbol: 'MyApp.save()', sourceFile: '/src/Store.swift', sourceLine: 42}] : undefined,
      faultingThread: 0,
      threads: [{frames: [{imageIndex: 1, symbol: '_assertionFailure'}, {imageIndex: 0, symbol: 'MyApp.load()', sourceFile: '/src/Feed.swift', sourceLine: 7}]}],
      usedImages: [{name: 'MyApp'}, {name: 'libswiftCore.dylib'}],
    })}`;

  it('reads a simulator crash report of the app on that simulator only', () => {
    const e = parseIps(ips(), 'com.example.app', 'AAA', 0)!;
    expect(e).toMatchObject({kind: 'crash', summary: 'EXC_BREAKPOINT (SIGTRAP)', at: Date.parse('2026-01-02T10:00:00.123+02:00')});
    expect(e.lines).toEqual(['libswiftCore.dylib _assertionFailure', 'MyApp MyApp.load() (Feed.swift:7)']);
    expect(parseIps(ips({udid: 'BBB'}), 'com.example.app', 'AAA', 0)).toBeUndefined();
    expect(parseIps(ips({bundle: 'com.example.other'}), 'com.example.app', 'AAA', 0)).toBeUndefined();
    expect(parseIps(ips({bug: '288'}), 'com.example.app', 'AAA', 0)).toBeUndefined();
    expect(parseIps('not a report', 'com.example.app', 'AAA', 0)).toBeUndefined();
  });

  it('takes the stack of an uncaught exception and its reason', () => {
    const e = parseIps(ips({exception: true}), 'com.example.app', 'AAA', 0)!;
    expect(e.summary).toContain('NSInvalidArgumentException');
    expect(e.lines).toEqual(['MyApp MyApp.save() (Store.swift:42)']);
  });

  it('finds new reports in the reports directory without asking the simulator', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-ips-'));
    const driver = {simctl: async () => ({stdout: '', stderr: '', code: 0, timedOut: false, ms: 0})};
    const w = new AppleCrashWatcher(driver as never, 'AAA', 'com.example.app', dir);
    w.begin(['com.example.app']);
    fs.writeFileSync(path.join(dir, 'MyApp-2026-01-02-100001.ips'), ips());
    fs.writeFileSync(path.join(dir, 'Other-2026-01-02-100001.ips'), ips({bundle: 'com.example.other'}));
    const found = await w.since(Date.parse('2026-01-02T10:00:00+02:00'));
    expect(found.map(f => f.summary)).toEqual(['EXC_BREAKPOINT (SIGTRAP)']);
  });

  it('waits for a late report on visionOS when the window is gone though the process is still listed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-ips-'));
    // launchctl still lists the crashed app while its report is written.
    const driver = {
      simctl: async () => ({stdout: '123\t0\tUIKitApplication:com.example.app[ab12]\n', stderr: '', code: 0, timedOut: false, ms: 0}),
      simulators: async () => [{udid: 'AAA', kind: 'xr'}],
    };
    const w = new AppleCrashWatcher(driver as never, 'AAA', 'com.example.app', dir);
    w.begin(['com.example.app']);
    setTimeout(() => fs.writeFileSync(path.join(dir, 'MyApp-2026-01-02-100001.ips'), ips()), 600);
    const found = await w.since(Date.parse('2026-01-02T10:00:00+02:00'), ['com.apple.SurfBoard']);
    expect(found.map(f => f.summary)).toEqual(['EXC_BREAKPOINT (SIGTRAP)']);
    // With the app still on screen nothing is waited for.
    w.begin(['com.example.app']);
    expect(await w.since(Date.now(), ['com.example.app'])).toEqual([]);
  });

  it('asks whether the app runs even when the screen still shows it: a crashing app stays there while it is reported', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-ips-'));
    let asked = 0;
    const driver = {simctl: async () => (asked++, {stdout: '', stderr: '', code: 0, timedOut: false, ms: 0}), simulators: async () => [{udid: 'AAA', kind: 'phone'}]};
    const saved = AppleCrashWatcher.waitMs;
    AppleCrashWatcher.waitMs = {quick: 100, long: 100};
    try {
      const w = new AppleCrashWatcher(driver as never, 'AAA', 'com.example.app', dir);
      w.begin(['com.example.app']);
      const [e] = await w.since(Date.now(), ['com.example.app']);
      expect(asked).toBe(1);
      expect(e?.summary).toMatch(/stopped running during the action/);
    } finally {
      AppleCrashWatcher.waitMs = saved;
    }
  });

  it('tells a running app from the Mac process list, not its extensions or another install', async () => {
    const app = '/Users/me/Library/Developer/CoreSimulator/Devices/AAA/data/Containers/Bundle/Application/B1/MyApp.app';
    // The same app on another simulator runs from that simulator's own container.
    const ps = [`${app}/PlugIns/Widgets.appex/Widgets`, '/usr/libexec/other', `${app.replace('B1', 'B0')}/MyApp`, `${app.replace('/AAA/', '/BBB/')}/MyApp`].join('\n');
    expect(appProcess(ps, app)).toBe(false);
    expect(appProcess(`${ps}\n${app}/MyApp -AppleLanguages (en)`, app)).toBe(true);
    // The watcher asks the process list and not launchctl when the driver can.
    let spawned = 0;
    const driver = {simctl: async () => (spawned++, {stdout: '', stderr: '', code: 0, timedOut: false, ms: 0}), appRunning: async () => true, simulators: async () => [{udid: 'AAA', kind: 'phone'}]};
    const w = new AppleCrashWatcher(driver as never, 'AAA', 'com.example.app', fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-ips-')));
    w.begin(['com.example.app']);
    expect(await w.since(Date.now(), ['com.example.app'])).toEqual([]);
    expect(spawned).toBe(0);
  });

  it('waits for the report of a crash that came after the last action when a flow failed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-ips-'));
    const driver = {simctl: async () => ({stdout: '', stderr: '', code: 0, timedOut: false, ms: 0}), simulators: async () => [{udid: 'AAA', kind: 'phone'}]};
    const w = new AppleCrashWatcher(driver as never, 'AAA', 'com.example.app', dir);
    setTimeout(() => fs.writeFileSync(path.join(dir, 'MyApp-2026-01-02-100001.ips'), ips()), 600);
    const t = Date.parse('2026-01-02T10:00:00+02:00');
    expect(await w.since(t)).toEqual([]);
    expect((await w.since(t, undefined, true)).map(f => f.summary)).toEqual(['EXC_BREAKPOINT (SIGTRAP)']);
  });

  it('waits longer for the report when a flow failed than after an action', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-ips-'));
    const driver = {simctl: async () => ({stdout: '', stderr: '', code: 0, timedOut: false, ms: 0}), simulators: async () => [{udid: 'AAA', kind: 'phone'}]};
    const saved = AppleCrashWatcher.waitMs;
    AppleCrashWatcher.waitMs = {quick: 100, long: 3000, atLimit: 4000};
    try {
      const w = new AppleCrashWatcher(driver as never, 'AAA', 'com.example.app', dir);
      const t = Date.parse('2026-01-02T10:00:00+02:00');
      w.begin(['com.example.app']);
      setTimeout(() => fs.writeFileSync(path.join(dir, 'MyApp-2026-01-02-100001.ips'), ips()), 800);
      // A report that comes after the quick wait is still found by the check of a failed flow.
      expect((await w.since(t, undefined, true)).map(f => f.summary)).toEqual(['EXC_BREAKPOINT (SIGTRAP)']);
    } finally {
      AppleCrashWatcher.waitMs = saved;
    }
  });

  it('answers within a few seconds when macOS keeps as many reports of the app as it saves, whatever their dates', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-ips-'));
    const driver = {simctl: async () => ({stdout: '', stderr: '', code: 0, timedOut: false, ms: 0}), simulators: async () => [{udid: 'AAA', kind: 'phone'}]};
    // Reports of earlier days count; so does another app with the same process name, and nothing else does.
    for (let i = 0; i < 23; i++) fs.writeFileSync(path.join(dir, `MyApp-2026-01-${String(1 + (i % 9)).padStart(2, '0')}-1000${String(i).padStart(2, '0')}.ips`), ips({udid: 'BBB'}));
    fs.writeFileSync(path.join(dir, 'MyApp-2026-01-03-110000.ips'), ips({bundle: 'com.example.other'}));
    fs.writeFileSync(path.join(dir, 'Other-2026-01-03-110000.ips'), ips({bundle: 'com.example.other'}).replace('"name":"MyApp"', '"name":"Other"'));
    fs.writeFileSync(path.join(dir, 'MyApp-2026-01-03-120000.ips'), ips({bug: '288'}));
    expect(keptReports(dir, 'com.example.app')).toBe(24);
    fs.writeFileSync(path.join(dir, 'MyApp-2026-01-03-130000.ips'), ips({udid: 'CCC'}));
    expect(keptReports(dir, 'com.example.app')).toBe(25);
    const saved = AppleCrashWatcher.waitMs;
    AppleCrashWatcher.waitMs = {quick: 20_000, long: 20_000, atLimit: 1000};
    try {
      const w = new AppleCrashWatcher(driver as never, 'AAA', 'com.example.app', dir);
      const t = Date.now();
      const [e] = await w.since(Date.now(), undefined, true);
      expect(e?.summary).toContain('stopped running during the action (no crash report: macOS saves almost none while it keeps 25 of the app and it has 25');
      expect(Date.now() - t).toBeLessThan(3000);
      // Past the limit macOS still saves one now and then: a report that comes within the short wait is found.
      const w2 = new AppleCrashWatcher(driver as never, 'AAA', 'com.example.app', dir);
      const t2 = Date.now();
      setTimeout(() => fs.writeFileSync(path.join(dir, 'MyApp-new.ips'), ips({at: new Date(t2 + 1000 + 2 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)})), 300);
      expect((await w2.since(t2, undefined, true)).map(f => f.summary)).toEqual(['EXC_BREAKPOINT (SIGTRAP)']);
    } finally {
      AppleCrashWatcher.waitMs = saved;
    }
  });

  it('finds a crash written over an old report and never takes a touched old report for a new crash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-ips-'));
    const driver = {simctl: async () => ({stdout: '', stderr: '', code: 0, timedOut: false, ms: 0}), simulators: async () => [{udid: 'AAA', kind: 'phone'}]};
    const file = path.join(dir, 'MyApp-2026-01-02-100000.ips');
    fs.writeFileSync(file, ips());
    const w = new AppleCrashWatcher(driver as never, 'AAA', 'com.example.app', dir);
    const t = Date.parse('2026-01-02T11:00:00+02:00');
    // Touched an hour later with the old crash in it: not a crash of this action.
    fs.utimesSync(file, new Date(t + 500), new Date(t + 500));
    expect(await w.since(t)).toEqual([]);
    // The same file rewritten with a new crash: read again, by its content.
    fs.writeFileSync(file, ips({at: '2026-01-02 11:00:01'}));
    fs.utimesSync(file, new Date(t + 1500), new Date(t + 1500));
    expect((await w.since(t)).map(f => f.at)).toEqual([Date.parse('2026-01-02T11:00:01.123+02:00')]);
  });

  it('stops waiting soon when macOS touches an old report of the app instead of saving the new crash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-ips-'));
    const driver = {simctl: async () => ({stdout: '', stderr: '', code: 0, timedOut: false, ms: 0}), simulators: async () => [{udid: 'AAA', kind: 'phone'}]};
    // The old report is of another simulator: macOS matches the crash by its signature, not by the device.
    const file = path.join(dir, 'MyApp-2026-01-02-100000.ips');
    fs.writeFileSync(file, ips({udid: 'BBB'}));
    fs.utimesSync(file, new Date('2026-01-02T10:00:01+02:00'), new Date('2026-01-02T10:00:01+02:00'));
    const saved = AppleCrashWatcher.waitMs;
    AppleCrashWatcher.waitMs = {quick: 20_000, long: 20_000, atLimit: 4000};
    try {
      const w = new AppleCrashWatcher(driver as never, 'AAA', 'com.example.app', dir);
      w.begin(['com.example.app']);
      const t = Date.now();
      setTimeout(() => fs.utimesSync(file, new Date(), new Date()), 300);
      const [e] = await w.since(t, undefined, true);
      expect(e?.summary).toContain('stopped running during the action (no crash report: macOS saved none, it took the crash for one it has a report of)');
      expect(Date.now() - t).toBeLessThan(5000);
    } finally {
      AppleCrashWatcher.waitMs = saved;
    }
  });

  it('lists booted simulators as online devices and idle ones by name', () => {
    const sims = [
      {udid: 'AAA', name: 'iPhone 17', os: 'iOS 27.0', kind: 'phone', state: 'Booted'},
      {udid: 'BBB', name: 'Apple TV 4K', os: 'tvOS 27.2', kind: 'tv', state: 'Shutdown'},
      {udid: 'CCC', name: 'Apple TV 4K', os: 'tvOS 27.1', kind: 'tv', state: 'Shutdown'},
    ];
    expect(fmtDevices([], [], sims)).toEqual(['✓ iPhone 17  iOS 27.0  AAA', 'simulators: Apple TV 4K']);
    expect(fmtDevices([], [], [])).toEqual(['no devices online']);
  });

  it('keeps swipes above the keyboard the runner reports as its own window', () => {
    // The runner's shape: the app, then one Keyboard node in an `ime` window (its keys are left out).
    const snap = buildSnapshot(
      [
        {type: 'app', title: 'MyApp', pkg: 'com.example.app'},
        {type: 'ime', title: 'keyboard', pkg: 'com.apple.keyboard'},
      ],
      [
        {p: -1, w: 0, c: 'ScrollView', b: [0, 0, 402, 874], f: 's', id: 'content_list'},
        {p: 0, w: 0, c: 'TextField', b: [16, 80, 386, 110], f: 'e'},
        {p: -1, w: 1, c: 'Keyboard', b: [0, 583, 402, 874]},
      ],
    );
    expect(swipeArea(snap, 402, 874)).toEqual([0, 0, 402, 583]);
  });

  it('finds a spot outside a context menu that is all the app shows', () => {
    const app = {type: 'app', title: 'MyApp', pkg: 'com.example.app'};
    const list = {p: -1, w: 0, c: 'CollectionView', b: [16, 452, 266, 1326], f: 's'} as const;
    const copy = {p: 0, w: 0, c: 'Button', b: [16, 462, 266, 504], f: 'c', t: 'Copy'} as const;
    const bar = {p: 0, w: 0, c: 'Other', b: [233, 481, 263, 485], t: 'Vertical scroll bar, 1 page'} as const;
    const preview = {p: -1, w: 0, c: 'Other', b: [16, 530, 109, 554], t: 'Preview'} as const;
    expect(menuOutside(buildSnapshot([app], [list, copy, bar, preview]), 402, 874)).toEqual({x: 201, y: 105});
    // A screen of the app's own: a full-width list of rows, or a form.
    const rows = {p: -1, w: 0, c: 'CollectionView', b: [0, 0, 402, 874], f: 's'} as const;
    expect(menuOutside(buildSnapshot([app], [rows, {...copy, b: [0, 100, 402, 140]}]), 402, 874)).toBeUndefined();
    const form = {p: -1, w: 0, c: 'Other', b: [0, 0, 402, 874]} as const;
    expect(menuOutside(buildSnapshot([app], [form, {p: 0, w: 0, c: 'TextField', b: [16, 80, 386, 110], f: 'e'}, {...copy, p: 0}]), 402, 874)).toBeUndefined();
  });

  it('keeps a swipe on the screen when the list runs past it', () => {
    // An iOS context menu's list reaches below the screen: a swipe from its lower part would start at the bottom
    // edge and go to the Home Screen.
    const app = {type: 'app', title: 'MyApp', pkg: 'com.example.app'};
    const snap = buildSnapshot([app], [{p: -1, w: 0, c: 'Window', b: [0, 0, 402, 874]}, {p: 0, w: 0, c: 'CollectionView', b: [16, 452, 266, 1326], f: 's'}]);
    expect(swipeArea(snap, 402, 874)).toEqual([16, 452, 266, 874]);
  });

  it('tells a tap that only closed the keyboard from one that reached the control', () => {
    const app = {type: 'app', title: 'MyApp', pkg: 'com.example.app'};
    const field = {p: 0, w: 0, c: 'TextField', b: [16, 80, 386, 110], f: 'eF', t: 'Ada'} as const;
    const list = {p: -1, w: 0, c: 'ScrollView', b: [0, 0, 402, 874], f: 's'} as const;
    const greet = {p: 0, w: 0, c: 'Button', b: [16, 120, 386, 150], f: 'c', id: 'greet'} as const;
    const up = buildSnapshot([app, {type: 'ime', title: 'keyboard', pkg: 'com.apple.keyboard'}], [list, field, greet, {p: -1, w: 1, c: 'Keyboard', b: [0, 583, 402, 874]}]);
    const closed = buildSnapshot([app], [list, {...field, f: 'e'}, greet]);
    const greeted = buildSnapshot([app], [list, {...field, f: 'e'}, greet, {p: 0, w: 0, c: 'Text', b: [16, 160, 386, 180], t: 'Hello, Ada'}]);
    expect(onlyClosedKeyboard(up, closed)).toBe(true);
    expect(onlyClosedKeyboard(up, greeted)).toBe(false);
    expect(onlyClosedKeyboard(closed, closed)).toBe(false);
    // The window grows back where the keyboard was and shows more rows: still only the keyboard.
    const grown = buildSnapshot([app], [list, {...field, f: 'e'}, greet, {p: 0, w: 0, c: 'Text', b: [16, 700, 386, 740], t: 'Row 12'}]);
    expect(onlyClosedKeyboard(up, grown)).toBe(true);
    // Something new where the keyboard was, outside any list (a note under the pressed control): the tap's doing.
    const form = {p: -1, w: 0, c: 'View', b: [0, 0, 402, 874]} as const;
    const save = {p: 0, w: 0, c: 'Button', b: [16, 540, 386, 580], f: 'c', id: 'save'} as const;
    const editing = buildSnapshot([app, {type: 'ime', title: 'keyboard', pkg: 'com.apple.keyboard'}], [form, {...field, p: 0}, save, {p: -1, w: 1, c: 'Keyboard', b: [0, 583, 402, 874]}]);
    const noted = buildSnapshot([app], [form, {...field, p: 0, f: 'e'}, save, {p: 0, w: 0, c: 'Text', b: [16, 600, 386, 620], t: 'Saved just now'}]);
    expect(onlyClosedKeyboard(editing, noted)).toBe(false);
    // An input method whose window spans the whole screen, its keys at its foot (Android's Gboard): the keys mark
    // where the keyboard was, so a note under the pressed control is still the tap's doing.
    const gboard = buildSnapshot(
      [app, {type: 'ime', title: 'keyboard', pkg: 'com.google.android.inputmethod.latin'}],
      [list, {...field, p: 0}, {...save, p: 0}, {p: -1, w: 1, c: 'FrameLayout', b: [0, 40, 402, 874]}, {p: 3, w: 1, c: 'Key', b: [0, 650, 402, 874], t: 'return', f: 'c'}],
    );
    const saved = buildSnapshot([app], [list, {...field, p: 0, f: 'e'}, {...save, p: 0}, {p: 0, w: 0, c: 'Text', b: [16, 590, 386, 610], t: 'Saved just now'}]);
    expect(onlyClosedKeyboard(gboard, saved)).toBe(false);
    // No keyboard on screen (a hardware one), only the field's focus taken: the tap did not reach the control.
    const focused = buildSnapshot([app], [list, field, greet]);
    expect(onlyClosedKeyboard(focused, closed)).toBe(true);
    expect(onlyClosedKeyboard(focused, greeted)).toBe(false);
    // The field lost its focus and the keyboard is still on its way down: the same.
    const leaving = buildSnapshot([app, {type: 'ime', title: 'keyboard', pkg: 'com.apple.keyboard'}], [list, {...field, f: 'e'}, greet, {p: -1, w: 1, c: 'Keyboard', b: [0, 583, 402, 874]}]);
    expect(onlyClosedKeyboard(up, leaving)).toBe(true);
  });

  it('folds a foldable only to a posture it has, and says when the screens did not change', async () => {
    let lit = 1;
    const spawned: string[][] = [];
    const screens = () => [
      {id: 1, name: 'LCD', active: lit === 1, primary: true, width: 1398, height: 2034},
      {id: 3, name: 'LCD-1', active: lit === 3, primary: false, width: 2007, height: 2853},
    ];
    const make = (obeys: boolean) =>
      Object.assign(Object.create(AppleDriver.prototype) as AppleDriver, {
        simulators: async () => [{udid: 'AAA', name: 'Foldable', kind: 'foldable'}, {udid: 'BBB', name: 'Phone', kind: 'phone'}],
        displays: async () => screens(),
        simctl: async (args: string[]) => {
          spawned.push(args.slice(3));
          if (obeys) lit = lit === 1 ? 3 : 1;
          return {stdout: 'done\n', stderr: '', code: 0, timedOut: false, ms: 0};
        },
      });
    const d = make(true);
    await expect(d.fold('BBB', 'open')).rejects.toThrow('has no hinge');
    await expect(d.fold('AAA', 'rear')).rejects.toThrow('closed, half, open, swap');
    await expect(d.fold('AAA', '200')).rejects.toThrow('0-180');
    expect(await d.fold('AAA', 'open slow')).toMatchObject({posture: 'open', angle: 180, screen: 'open: inner screen 2007x2853'});
    expect(lit).toBe(3);
    expect(await d.fold('AAA', 'swap')).toMatchObject({posture: 'swap'});
    // A swing in between leaves the lit screen to the system.
    expect(await d.fold('AAA', '90')).toMatchObject({angle: 90});
    expect(spawned).toEqual([['hinge', '180', '0', '3'], ['swap', '0.5'], ['hinge', '90', '0', '0.8']]);
    lit = 1;
    await expect(make(false).fold('AAA', 'open')).rejects.toThrow('stayed folded');
  }, 15_000);

  it('keeps the simulator list for a moment and drops it when one boots or shuts down', async () => {
    let lists = 0;
    const d = Object.assign(Object.create(AppleDriver.prototype) as AppleDriver, {
      simctl: async (args: string[]) => {
        if (args[0] === 'list') lists++;
        return {stdout: JSON.stringify({devices: {'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [{udid: 'AAA', name: 'Phone', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro'}]}}), stderr: '', code: 0, timedOut: false, ms: 0};
      },
    });
    expect(await d.resolve()).toBe('AAA');
    await d.booted();
    await d.simulators();
    expect(lists).toBe(1);
    await d.shutdown('AAA');
    await d.simulators();
    expect(lists).toBe(2);
  });

  it('keeps the simulator list past the moment while no simulator boots, shuts down, comes or goes', async () => {
    const set = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-set-'));
    const plist = (udid: string) => {
      fs.mkdirSync(path.join(set, udid), {recursive: true});
      fs.writeFileSync(path.join(set, udid, 'device.plist'), `<plist>${Math.random()}</plist>`);
    };
    plist('AAA');
    let lists = 0;
    const d = Object.assign(Object.create(AppleDriver.prototype) as AppleDriver, {
      deviceSet: set,
      simctl: async (args: string[]) => {
        if (args[0] === 'list') lists++;
        return {stdout: JSON.stringify({devices: {'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [{udid: 'AAA', name: 'Phone', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro'}]}}), stderr: '', code: 0, timedOut: false, ms: 0};
      },
    });
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await d.simulators();
      now += 5000;
      await d.simulators();
      expect(lists).toBe(1);
      // Booted or shut down from another process: its device.plist is written again.
      const file = path.join(set, 'AAA', 'device.plist');
      fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
      await d.simulators();
      expect(lists).toBe(2);
      now += 5000;
      plist('BBB');
      await d.simulators();
      expect(lists).toBe(3);
      // Never longer than half a minute.
      now += 31_000;
      await d.simulators();
      expect(lists).toBe(4);
    } finally {
      clock.mockRestore();
    }
  });

  it.skipIf(process.platform !== 'darwin')('copies the app data with the app stopped and says whether it was running', async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-container-'));
    const dataDir = path.join(container, 'Containers', 'Data', 'Application', 'X');
    fs.mkdirSync(path.join(dataDir, 'Library'), {recursive: true});
    fs.writeFileSync(path.join(dataDir, 'Library', 'token'), 't');
    const calls: string[] = [];
    // A real instance: the state directory is a private method. Its copies go under a udid no simulator has.
    const udid = 'pitbox-test-udid';
    const make = (running: boolean) =>
      Object.assign(new AppleDriver(), {
        simctl: async (args: string[]) => {
          calls.push(args[0] === 'spawn' ? args.slice(2).join(' ') : args[0]!);
          if (args[0] === 'get_app_container') return {stdout: `${dataDir}\n`, stderr: '', code: 0, timedOut: false, ms: 0};
          const list = running ? '321\t0\tUIKitApplication:com.example.app[ab12]\n' : '';
          return {stdout: args[0] === 'spawn' ? list : '', stderr: '', code: 0, timedOut: false, ms: 0};
        },
      });
    try {
      expect(await make(true).appStateSave(udid, 'com.example.app', 'signed-in')).toEqual({wasRunning: true});
      // Asked before the stop: after it the app is never running.
      expect(calls.slice(0, 2)).toEqual(['launchctl list', 'terminate']);
      expect(await make(false).appStateSave(udid, 'com.example.app', 'signed-out')).toEqual({wasRunning: false});
    } finally {
      fs.rmSync(container, {recursive: true, force: true});
      fs.rmSync(path.join(os.homedir(), 'Library', 'Caches', 'pitbox', 'app-states', udid), {recursive: true, force: true});
    }
  });

  it('builds a snapshot from a window without a package', () => {
    const snap = buildSnapshot([{type: 'ime', title: 'keyboard'} as never], [{p: -1, w: 0, c: 'Keyboard', b: [0, 500, 400, 800]}]);
    expect(snap.nodes).toHaveLength(1);
  });

  it('finds the window app of old and new Xcode layouts', () => {
    const xcode = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-xcode-'));
    const dev = path.join(xcode, 'Contents', 'Developer');
    fs.mkdirSync(dev, {recursive: true});
    expect(simulatorWindowApp(dev)).toBeUndefined();
    fs.mkdirSync(path.join(xcode, 'Contents', 'Applications', 'DeviceHub.app'), {recursive: true});
    expect(simulatorWindowApp(dev)).toBe(path.join(xcode, 'Contents', 'Applications', 'DeviceHub.app'));
    fs.mkdirSync(path.join(dev, 'Applications', 'Simulator.app'), {recursive: true});
    expect(simulatorWindowApp(dev)).toBe(path.join(dev, 'Applications', 'Simulator.app'));
    fs.rmSync(xcode, {recursive: true, force: true});
  });
});

describe('simctl list', () => {
  it('says CoreSimulator is busy when the list timed out, not that Xcode is missing', () => {
    expect(listFailure({code: 0, stderr: '', timedOut: false})).toBeUndefined();
    const busy = listFailure({code: null, stderr: '', timedOut: true});
    expect(busy?.message).toMatch(/did not answer/);
    expect(busy?.hint).toMatch(/CoreSimulator is busy/);
    expect(listFailure({code: 1, stderr: 'xcrun: error: unable to find utility "simctl"', timedOut: false})?.hint).toMatch(/license/);
  });
});

describe('simulator boots', () => {
  const ps = [
    '  501 Mon Nov 16 01:27:52 2026     /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/bin/launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/A62D3DC8-F1DA-47C5-99A8-825D1B6489A2/data/var/run/launchd_bootstrap.plist',
    '  502 Fri Nov  6 09:05:01 2026     /Applications/Xcode.app/x/RuntimeRoot/sbin/launchd_sim /tmp/My Sets/Devices/01c4869d-b553-4509-9b71-08dde320b398/data/var/run/launchd_bootstrap.plist',
    '  503 Mon Nov 16 01:27:50 2026     /usr/bin/vim /Users/me/Library/Developer/CoreSimulator/Devices/17D22098-D9F5-484B-84B9-DE405362765D/device.plist',
    '  504 Mon Nov 16 01:27:50 2026     launchd_sim_helper /Users/me/Library/Developer/CoreSimulator/Devices/1207AB9B-E44F-4942-84A9-20CF61963AE1/data',
  ].join('\n');
  const at = (y: number, mo: number, d: number, h: number, mi: number, s: number) => Math.floor(new Date(y, mo, d, h, mi, s).getTime() / 1000);

  it("reads each running simulator's boot from its launchd_sim process, and nothing else", () => {
    expect(parseSimulatorBoots(ps)).toEqual(
      new Map([
        ['A62D3DC8-F1DA-47C5-99A8-825D1B6489A2', `launchd_sim:501@${at(2026, 10, 16, 1, 27, 52)}`],
        ['01C4869D-B553-4509-9B71-08DDE320B398', `launchd_sim:502@${at(2026, 10, 6, 9, 5, 1)}`],
      ]),
    );
  });

  it('reads the same boot however late the process list is read, as on a machine too loaded to answer at once', () => {
    vi.useFakeTimers({toFake: ['Date']});
    try {
      const early = parseSimulatorBoots(ps);
      // A boot mark read while the machine is busy, and the check on release a minute later on an idle one.
      vi.setSystemTime(Date.now() + 65_000);
      expect(parseSimulatorBoots(ps)).toEqual(early);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('apple runner notice', () => {
  it('says when a visionOS runner cannot skip the animation wait that hangs presses into menus', () => {
    expect(runnerNotice({platform: 'visionos', animationWaitOff: false})).toMatch(/system menu/);
  });

  it('says nothing when the wait is off, on other platforms, or from an older runner', () => {
    expect(runnerNotice({platform: 'visionos', animationWaitOff: true})).toBeUndefined();
    expect(runnerNotice({platform: 'ios', animationWaitOff: false})).toBeUndefined();
    expect(runnerNotice({platform: 'visionos'})).toBeUndefined();
  });
});

describe('apple runner start', () => {
  it('ends an earlier xcodebuild and terminates a runner app still on the simulator before a new one starts', async () => {
    const {spawn} = await import('node:child_process');
    const {RUNNER_BUNDLE_ID, clearStaleRunner} = await import('./drivers/apple/runner.ts');
    const order: string[] = [];
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    child.on('exit', () => order.push('xcodebuild ended'));
    await clearStaleRunner({stop: async (udid: string, bundle: string) => void order.push(`terminate ${bundle} on ${udid}`)}, 'SIM-1', child);
    expect(order).toEqual(['xcodebuild ended', `terminate ${RUNNER_BUNDLE_ID} on SIM-1`]);
  });

  it('terminates a runner app left by a daemon that is gone, with no xcodebuild of its own', async () => {
    const {RUNNER_BUNDLE_ID, clearStaleRunner} = await import('./drivers/apple/runner.ts');
    const stopped: string[] = [];
    await clearStaleRunner({stop: async (_: string, bundle: string) => void stopped.push(bundle)}, 'SIM-1');
    expect(stopped).toEqual([RUNNER_BUNDLE_ID]);
  });
});

describe('apple hardware keys', () => {
  it('names keys as USB HID usages, modifiers first', async () => {
    const {hidChord} = await import('./drivers/apple/hid.ts');
    expect(hidChord(62)).toBe('2c');
    expect(hidChord(34)).toBe('09');
    expect(hidChord(19)).toBe('52');
    expect(hidChord(111)).toBe('29');
    expect(hidChord(8)).toBe('1e');
    expect(hidChord(7)).toBe('27');
    expect(hidChord(34, 0x10000 | 0x30000)).toBe('e3+09');
    expect(hidChord(31, 0x3000 | 0x41)).toBe('e0+e1+06');
  });

  it('has no usage for the device buttons a keyboard does not have', async () => {
    const {hidChord} = await import('./drivers/apple/hid.ts');
    expect(hidChord(3)).toBeUndefined();
    expect(hidChord(4)).toBeUndefined();
  });
});

describe('ui runner start', () => {
  it('a runner given back while it starts (started at boot) never starts xcodebuild, which would boot the simulator again', async () => {
    let listed!: () => void;
    const gate = new Promise<void>(r => (listed = r));
    const driver = {simulators: async () => (await gate, [{udid: 'U1', name: 'iPhone 17', state: 'Shutdown', kind: 'phone'}])};
    const runner = new AppleRunner(driver as never, 'U1', 'com.example.app');
    const started = runner.start();
    await runner.stop();
    listed();
    await expect(started).rejects.toThrow(/stopped while it started/);
  });
});

describe('apple runner start without xcodebuild', () => {
  it('takes the runner app and its test environment from the .xctestrun, placeholders filled in', async () => {
    const {directPlan} = await import('./drivers/apple/runner.ts');
    const doc = {
      __xctestrun_metadata__: {FormatVersion: 1},
      PitboxRunner: {
        TestHostPath: '__TESTROOT__/Debug-iphonesimulator/PitboxRunner-Runner.app',
        TestingEnvironmentVariables: {DYLD_FRAMEWORK_PATH: '__TESTROOT__/Debug-iphonesimulator:__PLATFORMS__/iPhoneSimulator.platform/Developer/Library/Frameworks', XCODE_SCHEME_NAME: 'PitboxRunner'},
      },
    };
    expect(directPlan(doc, '/cache/Products', '/Xcode/Developer')).toEqual({
      app: '/cache/Products/Debug-iphonesimulator/PitboxRunner-Runner.app',
      env: {DYLD_FRAMEWORK_PATH: '/cache/Products/Debug-iphonesimulator:/Xcode/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/Frameworks', XCODE_SCHEME_NAME: 'PitboxRunner'},
    });
    expect(directPlan({__xctestrun_metadata__: {}}, '/r', '/d')).toBeUndefined();
  });

  it('starts without xcodebuild on iOS and iPadOS 17 and later only', async () => {
    const {startsDirect} = await import('./drivers/apple/runner.ts');
    expect(startsDirect({kind: 'phone', os: 'iOS 27.2'})).toBe(true);
    expect(startsDirect({kind: 'tablet', os: 'iOS 17.0'})).toBe(true);
    expect(startsDirect({kind: 'foldable', os: 'iOS 27.2'})).toBe(true);
    expect(startsDirect({kind: 'phone', os: 'iOS 16.4'})).toBe(false);
    expect(startsDirect({kind: 'tv', os: 'tvOS 27.2'})).toBe(false);
    expect(startsDirect({kind: 'xr', os: 'visionOS 27.2'})).toBe(false);
    expect(startsDirect({kind: 'watch', os: 'watchOS 27.2'})).toBe(false);
  });

  it('installs the runner again only when the simulator holds other code of it', async () => {
    const {sameRunner} = await import('./drivers/apple/runner.ts');
    const app = (dir: string, code: string) => {
      const a = path.join(dir, 'PitboxRunner-Runner.app');
      fs.mkdirSync(path.join(a, 'PlugIns', 'PitboxRunner.xctest'), {recursive: true});
      fs.writeFileSync(path.join(a, 'PitboxRunner-Runner'), 'host');
      fs.writeFileSync(path.join(a, 'Info.plist'), 'plist');
      fs.writeFileSync(path.join(a, 'PlugIns', 'PitboxRunner.xctest', 'PitboxRunner'), code);
      return a;
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-runner-'));
    const a = app(path.join(root, 'a'), 'v1');
    expect(sameRunner(a, app(path.join(root, 'b'), 'v1'))).toBe(true);
    expect(sameRunner(a, app(path.join(root, 'c'), 'v2'))).toBe(false);
    expect(sameRunner(a, path.join(root, 'missing.app'))).toBe(false);
    fs.rmSync(root, {recursive: true, force: true});
  });
});

describe('apple runner kept for the next daemon', () => {
  it('leaves a record per simulator that the next start takes once', async () => {
    const {keepRunner, keptRunnerFile, takeKeptRunner} = await import('./drivers/apple/runner.ts');
    keepRunner('SIM-K', {port: 4321, xctestrun: '/cache/Runner.xctestrun', version: 1, at: 1});
    expect(fs.existsSync(keptRunnerFile('SIM-K'))).toBe(true);
    expect(takeKeptRunner('SIM-K')).toMatchObject({port: 4321, xctestrun: '/cache/Runner.xctestrun'});
    // Taken: a second daemon finds nothing, and a broken record is dropped.
    expect(takeKeptRunner('SIM-K')).toBeUndefined();
    fs.writeFileSync(keptRunnerFile('SIM-K'), '{');
    expect(takeKeptRunner('SIM-K')).toBeUndefined();
    expect(fs.existsSync(keptRunnerFile('SIM-K'))).toBe(false);
  });

  it('a runner that is not running leaves nothing behind when the daemon stops', async () => {
    const {keptRunnerFile} = await import('./drivers/apple/runner.ts');
    const runner = new AppleRunner({simulators: async () => []} as never, 'SIM-N', 'com.example.app');
    await runner.detach();
    expect(fs.existsSync(keptRunnerFile('SIM-N'))).toBe(false);
  });
});
