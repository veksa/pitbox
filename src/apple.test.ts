import {describe, expect, it} from 'vitest';
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
});
