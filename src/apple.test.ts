import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {sourceHash} from './drivers/apple/runner.ts';
import {AppleCrashWatcher, parseIps} from './drivers/apple/crashes.ts';
import {fmtDevices} from './format.ts';
import {contentSize, isAppleBundle, parseSimulators, pickSimulator, runtimeName, simKind} from './drivers/apple/driver.ts';

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
    expect(simKind('tvOS 27.2', 'Apple TV')).toBe('tv');
    expect(simKind('xrOS 3.0', 'Apple Vision Pro')).toBe('xr');
    expect(simKind('iOS 27.0', 'com.apple.CoreSimulator.SimDeviceType.iPad-Air')).toBe('tablet');
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

  it('lists booted simulators as online devices and idle ones by name', () => {
    const sims = [
      {udid: 'AAA', name: 'iPhone 17', os: 'iOS 27.0', kind: 'phone', state: 'Booted'},
      {udid: 'BBB', name: 'Apple TV 4K', os: 'tvOS 27.2', kind: 'tv', state: 'Shutdown'},
      {udid: 'CCC', name: 'Apple TV 4K', os: 'tvOS 27.1', kind: 'tv', state: 'Shutdown'},
    ];
    expect(fmtDevices([], [], sims)).toEqual(['✓ iPhone 17  iOS 27.0  AAA', 'simulators: Apple TV 4K']);
    expect(fmtDevices([], [], [])).toEqual(['no devices online']);
  });
});
