import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {sourceHash} from './drivers/apple/runner.ts';
import {AppleCrashWatcher, parseIps} from './drivers/apple/crashes.ts';
import {fmtDevices} from './format.ts';
import {buildSnapshot, onlyClosedKeyboard, swipeArea} from './ui/snapshot.ts';
import {AppleDriver, contentSize, foldState, isAppleBundle, parseDisplays, parseSimulators, pickSimulator, runtimeName, simKind, simulatorWindowApp} from './drivers/apple/driver.ts';

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
  });

  const ips = (o: {bundle?: string; udid?: string; bug?: string; exception?: boolean} = {}) =>
    `${JSON.stringify({bug_type: o.bug ?? '309', bundleID: o.bundle ?? 'com.example.app'})}\n${JSON.stringify({
      procPath: `/Users/u/Library/Developer/CoreSimulator/Devices/${o.udid ?? 'AAA'}/data/Containers/Bundle/Application/X/MyApp.app/MyApp`,
      captureTime: '2026-01-02 10:00:00.1234 +0200',
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
    AppleCrashWatcher.waitMs = {quick: 100, long: 3000};
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

  it('says when macOS has stopped writing crash reports of the app for the day', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-ips-'));
    const driver = {simctl: async () => ({stdout: '', stderr: '', code: 0, timedOut: false, ms: 0}), simulators: async () => [{udid: 'AAA', kind: 'phone'}]};
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (let i = 0; i < 25; i++) {
      const head = JSON.stringify({app_name: 'MyApp', timestamp: `${today} 10:00:${String(i).padStart(2, '0')}.00 +0200`, bundleID: 'com.example.app'});
      fs.writeFileSync(path.join(dir, `MyApp-${today}-1000${String(i).padStart(2, '0')}.ips`), `${head}\n{}`);
    }
    const saved = AppleCrashWatcher.waitMs;
    AppleCrashWatcher.waitMs = {quick: 100, long: 100};
    try {
      const w = new AppleCrashWatcher(driver as never, 'AAA', 'com.example.app', dir);
      const [e] = await w.since(Date.now(), undefined, true);
      expect(e?.summary).toContain('macOS keeps 25 a day per app and has 25 of it today');
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
    // No keyboard on screen (a hardware one), only the field's focus taken: the tap did not reach the control.
    const focused = buildSnapshot([app], [list, field, greet]);
    expect(onlyClosedKeyboard(focused, closed)).toBe(true);
    expect(onlyClosedKeyboard(focused, greeted)).toBe(false);
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
