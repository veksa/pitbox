import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {encodeStore, keepsOverrides, notDisabled, parseStore, SIM_SLIM_LABELS, SIM_WIDGET_LABELS, simSlimList, slimSimulator, storeDir, unslimSimulator} from './drivers/apple/slim.ts';

const UDID = '00000000-0000-0000-0000-000000000001';
let root: string;
const store = () => parseStore(fs.readFileSync(path.join(storeDir(UDID, root), 'disabled.plist'), 'utf8'));
const seed = (entries: Record<string, boolean>) => {
  fs.mkdirSync(storeDir(UDID, root), {recursive: true});
  fs.writeFileSync(path.join(storeDir(UDID, root), 'disabled.plist'), encodeStore(entries));
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-simslim-'));
});
afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true});
});

describe('simulator slim', () => {
  it('starts with the runtimes that keep launchd overrides', () => {
    expect(keepsOverrides('com.apple.CoreSimulator.SimRuntime.iOS-27-2')).toBe(true);
    expect(keepsOverrides('com.apple.CoreSimulator.SimRuntime.iOS-18-5')).toBe(true);
    expect(keepsOverrides('com.apple.CoreSimulator.SimRuntime.iOS-18-4')).toBe(false);
    expect(keepsOverrides('com.apple.CoreSimulator.SimRuntime.iOS-17-5')).toBe(false);
    expect(keepsOverrides('com.apple.CoreSimulator.SimRuntime.tvOS-26-0')).toBe(false);
  });

  it('keeps what pitbox features and apps under test lean on', () => {
    for (const label of ['com.apple.SpringBoard', 'com.apple.chronod', 'com.apple.liveactivitiesd', 'com.apple.apsd', 'com.apple.usernotificationsd', 'com.apple.locationd', 'com.apple.tccd', 'com.apple.assetsd', 'com.apple.AccessibilityUIServer', 'com.apple.swcd', 'com.apple.healthd', 'com.apple.passd', 'com.apple.appstored', 'com.apple.remindd', 'com.apple.calaccessd'])
      expect(SIM_SLIM_LABELS).not.toContain(label);
  });

  it('never disables a daemon others spin on while it is off, even when asked', () => {
    expect(SIM_SLIM_LABELS).not.toContain('com.apple.sleepd');
    expect(simSlimList({disable: ['com.apple.sleepd', 'com.apple.SpringBoard']})).not.toContain('com.apple.sleepd');
    expect(simSlimList({disable: ['com.apple.SpringBoard']})).not.toContain('com.apple.SpringBoard');
  });

  it('never disables game center: a test runner launched by xcodebuild waits about 10 s for it on every start', () => {
    expect(SIM_SLIM_LABELS).not.toContain('com.apple.gamed');
    expect(simSlimList({disable: ['com.apple.gamed']})).not.toContain('com.apple.gamed');
  });

  it('gives back a daemon an older list disabled once the list no longer names it', () => {
    // As an older pitbox left it: gamed disabled, with no entry before.
    fs.mkdirSync(storeDir(UDID, root), {recursive: true});
    fs.writeFileSync(path.join(storeDir(UDID, root), 'disabled.plist'), encodeStore({'com.apple.gamed': true}));
    fs.writeFileSync(path.join(storeDir(UDID, root), 'pitbox-slim.json'), JSON.stringify({'com.apple.gamed': null}));
    expect(slimSimulator(UDID, {}, root).restored).toBe(1);
    expect('com.apple.gamed' in store()).toBe(false);
  });

  it('turns widgets off only on request, as a group', () => {
    for (const l of SIM_WIDGET_LABELS) expect(simSlimList()).not.toContain(l);
    expect(simSlimList({disable: ['widgets']})).toEqual(expect.arrayContaining(SIM_WIDGET_LABELS));
    expect(simSlimList({disable: ['widgets'], keep: ['widgets']})).not.toContain('com.apple.chronod');
  });

  it('reads and writes the store as launchd_sim does', () => {
    const xml = encodeStore({'b.x': false, 'a.y': true});
    expect(xml.indexOf('a.y')).toBeLessThan(xml.indexOf('b.x'));
    expect(parseStore(xml)).toEqual({'a.y': true, 'b.x': false});
  });

  it('disables the list on a never-booted simulator (no store yet)', () => {
    const r = slimSimulator(UDID, {}, root);
    expect(r.changed).toBe(SIM_SLIM_LABELS.length);
    expect(Object.values(store()).filter(Boolean)).toHaveLength(SIM_SLIM_LABELS.length);
    // A second boot changes nothing and writes nothing.
    expect(slimSimulator(UDID, {}, root).changed).toBe(0);
  });

  it('puts back exactly the earlier values, leaving the runtime\'s own entries alone', () => {
    seed({'com.apple.homed': false, 'com.apple.companionappd': false, 'com.example.by-hand': true});
    slimSimulator(UDID, {}, root);
    expect(store()['com.apple.homed']).toBe(true);
    expect(unslimSimulator(UDID, root)).toBe(SIM_SLIM_LABELS.length);
    expect(store()).toEqual({'com.apple.homed': false, 'com.apple.companionappd': false, 'com.example.by-hand': true});
    expect(unslimSimulator(UDID, root)).toBe(0);
  });

  it('a label taken out of the list (keep) gets its earlier value back', () => {
    seed({'com.apple.weatherd': false});
    slimSimulator(UDID, {}, root);
    const r = slimSimulator(UDID, {keep: ['com.apple.weatherd', 'com.apple.newsd']}, root);
    expect(r.restored).toBe(2);
    expect(store()['com.apple.weatherd']).toBe(false);
    expect('com.apple.newsd' in store()).toBe(false);
  });

  it('takes extra labels, never one that is not a label', () => {
    expect(simSlimList({disable: ['com.example.daemon', '</key><true/>']})).toContain('com.example.daemon');
    expect(simSlimList({disable: ['</key><true/>']}).some(l => l.includes('<'))).toBe(false);
  });

  it('reads launchd back: what it does not report disabled', () => {
    const printed = 'disabled services = {\n\t"com.apple.newsd" => disabled\n\t"com.apple.gamed" => enabled\n}\n';
    expect(notDisabled(printed, ['com.apple.newsd', 'com.apple.gamed', 'com.apple.weatherd'])).toEqual(['com.apple.gamed', 'com.apple.weatherd']);
    expect(notDisabled('"com.apple.newsd" => true', ['com.apple.newsd'])).toEqual([]);
  });
});
