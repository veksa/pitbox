import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {configSchema} from './config/schema.ts';
import {AppleCrashWatcher, parseIps} from './drivers/apple/crashes.ts';
import {MacRunner, macDevice, macKey} from './drivers/mac/runner.ts';
import {keyOf} from './drivers/android/formfactor.ts';
import {KEYS} from './drivers/android/driver.ts';
import {macPermissions} from './doctor/rules.ts';
import type {DoctorContext} from './doctor/types.ts';
import {buildSnapshot, type UiNode, type UiWindow} from './ui/snapshot.ts';
import {formatResult} from './format.ts';
import {DeviceUi} from './ui/device.ts';

describe('mac apps', () => {
  it('lists the windows of a Mac app and the one it drives, not an Android freeform window', () => {
    const windows = [{title: 'MyApp', size: [800, 600], main: true}, {title: 'Settings', minimized: true}];
    expect(formatResult('window', {serial: 'mac:main', selected: 'front', windows})).toBe('mac:main: driving the window in front\n  #1 "MyApp" 800x600 main\n  #2 "Settings" minimized');
    expect(formatResult('window', {serial: 'mac:main', selected: 'Settings', windows: []})).toBe('mac:main: driving "Settings"\n  no windows');
    expect(formatResult('window', {serial: 'mac:main', window: 'Settings', size: '400x300'})).toBe('mac:main: driving Settings (400x300)');
    expect(formatResult('window', {serial: 'emulator-5554', mode: 'freeform'})).toBe('emulator-5554: app in a freeform window');
  });

  it('names a Mac app as a device: mac:<name>, or mac with one app', () => {
    expect(macDevice('mac:main', ['main', 'admin'])).toBe('main');
    expect(macDevice('mac', ['main'])).toBe('main');
    expect(macDevice('Pixel_8', ['main'])).toBeUndefined();
    expect(macDevice(undefined, ['main'])).toBeUndefined();
    expect(() => macDevice('mac', ['main', 'admin'])).toThrow(/known: mac:main, mac:admin/);
    expect(() => macDevice('mac:other', ['main'])).toThrow(/no Mac app "other"/);
    expect(() => macDevice('mac', [])).toThrow(/no Mac apps in the config/);
  });

  it('takes a mac section in the config', () => {
    const ok = configSchema.safeParse({mac: {main: {app: 'com.example.app', path: './build/MyApp.app', window: 'MyApp'}}});
    expect(ok.success).toBe(true);
    expect(configSchema.safeParse({mac: {main: {path: './build/MyApp.app'}}}).success).toBe(false);
    expect(configSchema.safeParse({mac: {'my app': {app: 'com.example.app'}}}).success).toBe(false);
  });

  it('presses keys by their place on the keyboard, not by character', () => {
    const k = (name: string) => {
      const {code, meta} = keyOf(name, KEYS);
      return macKey(code, meta);
    };
    // ⌘K, ⌘V and ⌃⇧Tab on any layout: key codes of the ANSI keyboard, flags as CGEventFlags.
    expect(k('meta+k')).toEqual({vk: 40, flags: 0x100000});
    expect(k('meta+v')).toEqual({vk: 9, flags: 0x100000});
    expect(k('ctrl+shift+tab')).toEqual({vk: 48, flags: 0x40000 | 0x20000});
    expect(k('alt+a')).toEqual({vk: 0, flags: 0x80000});
    expect(k('enter')).toEqual({vk: 36, flags: 0});
    expect(k('del')).toEqual({vk: 51, flags: 0});
    expect(k('back')).toEqual({vk: 53, flags: 0});
    expect(k('up')).toEqual({vk: 126, flags: 0});
    expect(k('5')).toEqual({vk: 23, flags: 0});
    expect(k('z')).toEqual({vk: 6, flags: 0});
    expect(macKey(142)).toEqual({vk: 111, flags: 0});
    expect(() => k('home')).toThrow(/no key on a Mac keyboard/);
  });

  const ips = (procPath: string, bundle = 'com.example.app') =>
    `${JSON.stringify({bug_type: '309', bundleID: bundle})}\n${JSON.stringify({
      procPath,
      captureTime: '2026-01-02 10:00:00.1234 +0200',
      exception: {type: 'EXC_BREAKPOINT', signal: 'SIGTRAP'},
      faultingThread: 0,
      threads: [{frames: [{imageIndex: 0, symbol: 'AppDelegate.crashTapped()', sourceFile: '/src/main.swift', sourceLine: 9}]}],
      usedImages: [{name: 'MyApp'}],
    })}`;

  it('reads crash reports of the Mac app and not of simulator apps', () => {
    const e = parseIps(ips('/Applications/MyApp.app/Contents/MacOS/MyApp'), 'com.example.app', '', 0)!;
    expect(e).toMatchObject({kind: 'crash', summary: 'EXC_BREAKPOINT (SIGTRAP)'});
    expect(e.lines).toEqual(['MyApp AppDelegate.crashTapped() (main.swift:9)']);
    expect(parseIps(ips('/Users/u/Library/Developer/CoreSimulator/Devices/AAA/data/MyApp.app/MyApp'), 'com.example.app', '', 0)).toBeUndefined();
    expect(parseIps(ips('/Applications/Other.app/Contents/MacOS/Other', 'com.example.other'), 'com.example.app', '', 0)).toBeUndefined();
  });

  it('attaches a Mac app crash to the action, asking the app itself whether it runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-mac-ips-'));
    let running = true;
    const w = new AppleCrashWatcher({running: async () => running, slow: async () => false}, '', 'com.example.app', dir);
    w.begin(['com.example.app']);
    running = false;
    setTimeout(() => fs.writeFileSync(path.join(dir, 'MyApp-2026-01-02-100001.ips'), ips('/Applications/MyApp.app/Contents/MacOS/MyApp')), 300);
    const found = await w.since(Date.parse('2026-01-02T10:00:00+02:00'));
    expect(found.map(f => f.summary)).toEqual(['EXC_BREAKPOINT (SIGTRAP)']);
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('shows the window, an open menu, the menu bar item and the other windows of the app', () => {
    const windows: UiWindow[] = [
      {type: 'app', title: 'MyApp', pkg: 'com.example.app'},
      {type: 'menu bar', title: '', pkg: 'com.example.app'},
      {type: 'other windows', title: '', pkg: 'windows'},
    ];
    const nodes: UiNode[] = [
      {p: -1, w: 0, c: 'Button', b: [20, 40, 120, 70], id: 'greet', t: 'Greet', f: 'cf'},
      {p: -1, w: 0, c: 'WebView', b: [0, 80, 400, 400]},
      {p: 1, w: 0, c: 'TextField', b: [20, 100, 300, 130], id: 'web_name', h: 'Your name', f: 'fe'},
      {p: -1, w: 1, c: 'MenuItem', b: [800, -300, 830, -278], id: 'status_item', t: 'PX', f: 'cf'},
      {p: -1, w: 2, c: 'Window', b: [460, 0, 920, 420], t: 'Web page', f: 'c'},
    ];
    const snap = buildSnapshot(windows, nodes, {height: 420});
    expect(snap.lines).toEqual(['@e1 button "Greet" #greet', '@e2 field hint "Your name" #web_name', '— menu bar', '@e3 button "PX" #status_item', '— other windows', '@e4 button "Web page"']);
  });

  it('says which app needs which permission', async () => {
    const ctx = (p: {accessibility: boolean; screen: boolean}) => ({macPermissions: async () => ({...p, host: 'MyTerminal'})}) as unknown as DoctorContext;
    expect(await macPermissions.check(ctx({accessibility: true, screen: true}))).toEqual([]);
    const off = await macPermissions.check(ctx({accessibility: false, screen: false}));
    expect(off.map(f => f.severity)).toEqual(['error', 'warn']);
    expect(off[0]!.message).toBe('Accessibility is off for MyTerminal: pitbox cannot read or drive Mac apps');
    expect(off[0]!.hint).toContain('Privacy & Security › Accessibility → turn on MyTerminal');
    expect(off[1]!.hint).toContain('Screen & System Audio Recording → turn on MyTerminal');
    expect(await macPermissions.check({} as DoctorContext)).toEqual([]);
  });

  // The stand-in runner is a shebang script, which Windows cannot start; the Mac runner exists only on macOS.
  it.skipIf(process.platform === 'win32')('talks to the runner in JSON lines: the app, the selected window and Mac key codes in every request', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-mac-runner-'));
    // A stand-in runner that answers with what it was asked.
    const fake = path.join(dir, 'runner.mjs');
    fs.writeFileSync(
      fake,
      `#!${process.execPath}\nimport readline from 'node:readline';\nfor await (const line of readline.createInterface({input: process.stdin})) { const r = JSON.parse(line); process.stdout.write(JSON.stringify(r.cmd === 'fail' ? {id: r.id, ok: false, error: 'nope'} : {id: r.id, ok: true, echo: r}) + '\\n'); if (r.cmd === 'shutdown') process.exit(0); }\n`,
    );
    fs.chmodSync(fake, 0o755);
    const runner = new MacRunner('main', {app: 'com.example.app', window: 'Settings'}, dir, async () => fake);
    try {
      const tree = await runner.call<{echo: Record<string, unknown>}>('tree');
      expect(tree.echo).toMatchObject({cmd: 'tree', app: 'com.example.app', win: 'Settings'});
      runner.window = undefined;
      const key = await runner.call<{echo: Record<string, unknown>}>('key', {code: 39, meta: 0x30000});
      expect(key.echo).toMatchObject({cmd: 'key', vk: 40, flags: 0x100000});
      expect(key.echo.win).toBeUndefined();
      await expect(runner.call('fail')).rejects.toThrow('nope');
    } finally {
      await runner.stop();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it.skipIf(process.platform === 'win32')('follows the window in front once an action closes the window it followed, and says so', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-mac-runner-'));
    // A stand-in runner for an app with two windows, where ⌘W closes the selected one.
    const fake = path.join(dir, 'runner.mjs');
    fs.writeFileSync(
      fake,
      `#!${process.execPath}
import readline from 'node:readline';
const open = ['MyApp', 'Settings'];
const answer = (r, body) => process.stdout.write(JSON.stringify({id: r.id, ...body}) + '\\n');
for await (const line of readline.createInterface({input: process.stdin})) {
  const r = JSON.parse(line);
  if (r.cmd === 'shutdown') process.exit(0);
  if (r.win && !open.includes(r.win)) { answer(r, {ok: false, error: 'no window "' + r.win + '" in MyApp\\nhint: its windows: ' + open.map(w => '"' + w + '"').join(', ')}); continue; }
  const win = r.win ?? open[0];
  if (r.cmd === 'key' && r.flags) open.splice(open.indexOf(win), 1);
  if (r.cmd === 'tree') answer(r, {ok: true, windows: [{type: 'app', title: win, pkg: 'com.example.app'}], nodes: [{p: -1, w: 0, c: 'button', b: [0, 0, 100, 40], t: win}], size: [400, 300]});
  else if (r.cmd === 'info') answer(r, {ok: true, width: 400, height: 300, window: win});
  else if (r.cmd === 'idle') answer(r, {ok: true, idle: true});
  else answer(r, {ok: true});
}
`,
    );
    fs.chmodSync(fake, 0o755);
    const runner = new MacRunner('main', {app: 'com.example.app'}, dir, async () => fake);
    const ui = new DeviceUi('mac:main', runner);
    try {
      // A window that was never there still fails.
      runner.window = 'Nope';
      await expect(runner.call('tree')).rejects.toThrow(/no window "Nope"/);
      runner.window = 'Settings';
      expect((await ui.snapshot()).lines).toEqual(['@e1 button "Settings"']);
      const closed = await ui.key(['meta+w']);
      expect(closed.note).toBe('the window "Settings" closed: following the window in front now');
      expect(runner.window).toBeUndefined();
      expect((await ui.snapshot()).lines).toEqual(['@e1 button "MyApp"']);
      expect((await ui.key(['enter'])).note).toBeUndefined();
    } finally {
      await runner.stop();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
