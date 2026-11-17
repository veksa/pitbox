import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {forgetTemplate, isTemplate, modelName, parseProcs, recordTemplate, simCpu, templateName, templateOf, waitQuiet} from './drivers/apple/templates.ts';

const UDID = '00000000-0000-0000-0000-0000000000AA';
let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.PITBOX_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-tpl-'));
  process.env.PITBOX_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PITBOX_HOME;
  else process.env.PITBOX_HOME = saved;
  fs.rmSync(home, {recursive: true, force: true});
});

const PHONE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
const IOS = 'com.apple.CoreSimulator.SimRuntime.iOS-27-2';

describe('simulator templates', () => {
  it('one template per model and runtime, found by both', () => {
    recordTemplate({udid: 'A', name: 't', deviceType: PHONE, runtime: IOS, at: 1, pid: 1});
    recordTemplate({udid: 'B', name: 't', deviceType: PHONE, runtime: IOS, at: 2, ready: true});
    expect(templateOf(PHONE, IOS)?.udid).toBe('B');
    expect(isTemplate('A')).toBe(false);
    expect(templateOf(PHONE, 'com.apple.CoreSimulator.SimRuntime.iOS-26-0')).toBeUndefined();
    forgetTemplate('B');
    expect(isTemplate('B')).toBe(false);
  });

  it('is named so that no session asks for it by name', () => {
    expect(modelName(PHONE)).toBe('iPhone 17 Pro');
    expect(templateName(PHONE, 'iOS 27.2')).toBe('pitbox template · iPhone 17 Pro · iOS 27.2');
  });

  it("counts a simulator's CPU over its launchd_sim's process tree only", () => {
    const ps = [
      `  100     1   1:00.00 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/bin/launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/${UDID}/data/var/run/launchd_bootstrap.plist`,
      '  101   100   0:02.50 /Runtime/usr/libexec/searchd',
      '  102   101   0:00.50 /Runtime/usr/libexec/helper',
      '  200     1   5:00.00 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/bin/launchd_sim /Users/x/Devices/OTHER/data',
      '  201   200   9:00.00 /Runtime/usr/libexec/searchd',
    ].join('\n');
    expect(simCpu(parseProcs(ps), UDID)).toBe(63);
  });

  it('waits for quiet: not before the minimum, then once a window stays under the cores', async () => {
    let t = 0;
    const cpu = [0, 20, 40, 42, 43];
    let i = 0;
    const r = await waitQuiet(() => cpu[Math.min(i++, cpu.length - 1)]!, {windowMs: 10_000, minMs: 20_000, cores: 0.3, sleep: async ms => void (t += ms), now: () => t});
    // 2 cores, 2 cores, then 0.2: quiet at the third window.
    expect(r).toEqual({quiet: true, ms: 30_000});
  });

  it('gives up at the maximum on a simulator that never goes quiet', async () => {
    let t = 0;
    let c = 0;
    const r = await waitQuiet(() => (c += 20), {windowMs: 10_000, minMs: 0, maxMs: 40_000, sleep: async ms => void (t += ms), now: () => t});
    expect(r).toEqual({quiet: false, ms: 40_000});
  });
});
