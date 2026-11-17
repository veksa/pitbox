// The helper that sends a Mac keyboard's keys to a simulator (runners/apple/Hid), as Xcode's device window sends
// them. A small Swift tool for the Mac, built with swiftc on first use and cached per source hash and Xcode under
// ~/Library/Caches/pitbox. XCUITest's `typeKey` does not reach the GameController framework, where a visionOS app
// reads keys for its 3D content (an immersive space has no focused view).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gcVersions, markInUse, withBuildLock} from '../../util/cache.ts';
import {run} from '../../util/proc.ts';
import {AppleError} from './driver.ts';
import {runnerSources, sourceHash} from './runner.ts';

let built: Promise<string> | undefined;

/** The helper's path, built if this source and Xcode have none yet. */
export const hidTool = (): Promise<string> => {
  built ??= build().catch(e => {
    built = undefined;
    throw e;
  });
  return built;
};

const build = async (): Promise<string> => {
  const src = path.join(runnerSources(), 'Hid');
  if (!fs.existsSync(path.join(src, 'hid.swift'))) throw new AppleError(`hid helper sources missing: ${src}`);
  const xcode = (await run('xcodebuild', ['-version'], {timeoutMs: 20_000})).stdout.match(/Build version (\S+)/)?.[1] ?? 'unknown';
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'pitbox', 'apple-hid');
  const version = `${sourceHash(src)}-${xcode}`;
  const bin = path.join(cache, version, 'hid');
  markInUse(path.dirname(bin));
  gcVersions(cache, version);
  return withBuildLock(cache, version, async () => (fs.existsSync(bin) ? bin : compile(src, bin)));
};

const compile = async (src: string, bin: string): Promise<string> => {
  const partial = `${bin}.partial`;
  const swift = await run('xcrun', ['-sdk', 'macosx', 'swiftc', '-O', path.join(src, 'hid.swift'), '-o', partial], {timeoutMs: 300_000});
  if (swift.code !== 0) throw new AppleError(`hid helper build failed: ${swift.stderr.trim().split('\n').filter(l => /error:/.test(l)).slice(0, 2).join(' ') || swift.stderr.trim().split('\n').pop()}`);
  fs.renameSync(partial, bin);
  return bin;
};

/** USB HID keyboard usages (page 7) for Android key codes, which is how pitbox names keys on every platform. */
const USAGES: Record<number, number> = {
  66: 0x28, // enter
  111: 0x29, // escape
  67: 0x2a, // del (backspace)
  61: 0x2b, // tab
  62: 0x2c, // space
  92: 0x4b, // page up
  93: 0x4e, // page down
  122: 0x4a, // home (of a line)
  123: 0x4d, // end
  112: 0x4c, // forward delete
  22: 0x4f, // right
  21: 0x50, // left
  20: 0x51, // down
  19: 0x52, // up
};

/** Android meta flags as the modifier keys' usages: control, shift, option, command. */
const MODIFIERS: [number, number][] = [
  [0x3000, 0xe0],
  [0x41, 0xe1],
  [0x12, 0xe2],
  [0x30000, 0xe3],
];

/**
 * A key as a chord of HID usages for the helper (`e3+09` is ⌘F), or undefined when the keyboard has no such key
 * (home, back: the device's own buttons).
 */
export const hidChord = (code: number, meta = 0): string | undefined => {
  const usage = code >= 29 && code <= 54 ? 0x04 + code - 29 : code >= 8 && code <= 16 ? 0x1e + code - 8 : code === 7 ? 0x27 : USAGES[code];
  if (usage === undefined) return undefined;
  const mods = MODIFIERS.filter(([flag]) => (meta & flag) === flag).map(([, u]) => u);
  return [...mods, usage].map(u => u.toString(16).padStart(2, '0')).join('+');
};

export const hid = async (udid: string, args: string[]): Promise<void> => {
  const developer = (await run('xcode-select', ['-p'], {timeoutMs: 10_000})).stdout.trim();
  const r = await run(await hidTool(), [udid, ...args], {timeoutMs: 30_000, env: {...process.env, ...(developer ? {DEVELOPER_DIR: developer} : {})}});
  if (r.code !== 0) throw new AppleError(`hardware input failed: ${r.stderr.trim().split('\n').pop()}`);
};
