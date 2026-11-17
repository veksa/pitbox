import {describe, expect, it} from 'vitest';
import {builtinRules} from './doctor/rules.ts';
import type {DoctorContext} from './doctor/types.ts';
import {describeSlim, packageNames, SLIM_PACKAGES, SLIM_RECORD, slim, slimList, unslim} from './drivers/android/slim.ts';

/** A device's package manager and record file, driven through the shell commands slim sends. */
const fakeDevice = (installed: string[], disabled: string[] = [], record: string[] = [], refuse: string[] = []) => {
  const off = new Set(disabled);
  let rec = [...record];
  const calls: string[] = [];
  const shell = async (cmd: string) => {
    calls.push(cmd);
    // adb shell fails a command that exits non-zero with nothing on stdout: `cat` of a missing record does.
    if (!rec.length && cmd.includes(`cat ${SLIM_RECORD}`) && !cmd.includes(`cat ${SLIM_RECORD} 2>/dev/null; true`)) throw new Error('adb shell failed');
    if (cmd.startsWith('pm list packages -e')) {
      const on = installed.filter(p => !off.has(p)).map(p => `package:${p}`).join('\n');
      const dis = installed.filter(p => off.has(p)).map(p => `package:${p}`).join('\n');
      return `${on}\n---\n${dis}\n---\n${rec.join('\n')}${rec.length ? '\n' : ''}`;
    }
    if (cmd === `cat ${SLIM_RECORD} 2>/dev/null; true`) return rec.join('\n');
    const out: string[] = [];
    for (const part of cmd.split('; ')) {
      let m = /pm disable-user --user 0 (\S+)/.exec(part);
      if (m && part.startsWith('if')) {
        const p = m[1]!;
        if (refuse.includes(p)) out.push(`-${p}`);
        else {
          off.add(p);
          rec.push(p);
          out.push(`+${p}`);
        }
        continue;
      }
      m = /pm enable --user 0 (\S+)/.exec(part);
      if (m) {
        off.delete(m[1]!);
        out.push(part.includes('echo =') ? `=${m[1]}` : m[1]!);
        continue;
      }
      if (part.startsWith('grep -v -x')) {
        const drop = [...part.matchAll(/-e (\S+)/g)].map(x => x[1]!);
        rec = rec.filter(p => !drop.includes(p));
      }
      if (part.startsWith('rm -f')) rec = [];
    }
    return out.join('\n');
  };
  return {shell, calls, off, record: () => rec};
};

describe('slim', () => {
  it('lists the defaults, plus disable, less keep', () => {
    expect(slimList()).toEqual(SLIM_PACKAGES);
    const l = slimList({keep: ['com.google.android.apps.maps'], disable: ['com.example.extra']});
    expect(l).not.toContain('com.google.android.apps.maps');
    expect(l).toContain('com.example.extra');
  });

  it('reads pm output', () => {
    expect(packageNames('package:a.b\npackage:c.d\n\njunk')).toEqual(['a.b', 'c.d']);
  });

  it('disables installed apps of the list and records only those', async () => {
    const d = fakeDevice(['com.google.android.youtube', 'com.google.android.gm', 'com.google.android.gms', 'com.google.android.apps.maps'], ['com.google.android.apps.maps']);
    const r = await slim(d.shell);
    expect(r.disabled.sort()).toEqual(['com.google.android.gm', 'com.google.android.youtube']);
    expect(r.already).toBe(1);
    expect(d.off.has('com.google.android.gms')).toBe(false);
    // An app the user disabled by hand is never in the record: a stock boot leaves it off.
    expect(d.record().sort()).toEqual(['com.google.android.gm', 'com.google.android.youtube']);
    expect(describeSlim(r)).toBe('3 background apps off (2 now)');
  });

  it('a second boot finds everything off in one shell call', async () => {
    const d = fakeDevice(['com.google.android.youtube'], ['com.google.android.youtube'], ['com.google.android.youtube']);
    const r = await slim(d.shell);
    expect(r).toEqual({disabled: [], already: 1, failed: [], enabled: []});
    expect(d.calls).toHaveLength(1);
  });

  it('says what pm refused', async () => {
    const d = fakeDevice(['com.google.android.youtube', 'com.google.android.gm'], [], [], ['com.google.android.gm']);
    const r = await slim(d.shell);
    expect(r.failed).toEqual(['com.google.android.gm']);
    expect(d.record()).toEqual(['com.google.android.youtube']);
    expect(describeSlim(r)).toContain('not disabled: com.google.android.gm');
  });

  it('enables again what keep now names', async () => {
    const d = fakeDevice(['com.google.android.youtube', 'com.google.android.gm'], ['com.google.android.youtube', 'com.google.android.gm'], ['com.google.android.youtube', 'com.google.android.gm']);
    const r = await slim(d.shell, {keep: ['com.google.android.gm']});
    expect(r.enabled).toEqual(['com.google.android.gm']);
    expect(d.off.has('com.google.android.gm')).toBe(false);
    expect(d.record()).toEqual(['com.google.android.youtube']);
  });

  it('a device pitbox never slimmed has no record, and that is no failure', async () => {
    const d = fakeDevice(['com.google.android.youtube']);
    expect(await unslim(d.shell)).toEqual([]);
    expect((await slim(d.shell)).disabled).toEqual(['com.google.android.youtube']);
  });

  it('a stock boot enables exactly what pitbox disabled', async () => {
    const d = fakeDevice(['com.google.android.youtube', 'com.google.android.gm'], ['com.google.android.youtube', 'com.google.android.gm'], ['com.google.android.youtube']);
    expect(await unslim(d.shell)).toEqual(['com.google.android.youtube']);
    expect(d.off.has('com.google.android.gm')).toBe(true);
    expect(d.record()).toEqual([]);
  });

  it('never puts a name that is not a package into the shell', async () => {
    const d = fakeDevice(['x'], [], []);
    await slim(d.shell, {disable: ['a; rm -rf /', 'ok.pkg']});
    expect(d.calls.join('\n')).not.toContain('rm -rf');
  });
});

describe('doctor emulator-slim', () => {
  const rule = builtinRules.find(r => r.id === 'emulator-slim')!;
  const android = (enabled: string[]) =>
    ({
      devices: async () => [
        {serial: 'emulator-5554', state: 'device', avd: 'Pixel', emulator: true},
        {serial: 'R5CT', state: 'device', emulator: false},
      ],
      shell: async (_s: string, cmd: string) => (cmd === 'pm list packages -e' ? enabled.map(p => `package:${p}`).join('\n') : ''),
    }) as unknown as DoctorContext['android'];

  it('finds an emulator that runs the background apps, never a phone', async () => {
    const f = await rule.check({config: {}, android: android(['com.google.android.youtube', 'com.google.android.gms'])} as unknown as DoctorContext);
    expect(f.map(x => x.message)).toEqual(['Pixel: 1 background apps on (com.google.android.youtube)']);
    expect(f[0]!.fix).toBeDefined();
  });

  it('says nothing for a slim emulator, nor when slim is off', async () => {
    expect(await rule.check({config: {}, android: android(['com.google.android.gms'])} as unknown as DoctorContext)).toEqual([]);
    expect(await rule.check({config: {android: {slim: false}}, android: android(['com.google.android.youtube'])} as unknown as DoctorContext)).toEqual([]);
  });

  it('respects keep', async () => {
    expect(await rule.check({config: {android: {slim: {keep: ['com.google.android.youtube']}}}, android: android(['com.google.android.youtube'])} as unknown as DoctorContext)).toEqual([]);
  });
});
