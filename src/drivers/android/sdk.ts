// Locating the Android SDK tools.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {which} from '../../util/proc.ts';

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

export const sdkRoots = (): string[] =>
  [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : undefined,
    process.platform === 'linux' ? path.join(os.homedir(), 'Android', 'Sdk') : undefined,
  ].filter((p): p is string => !!p && fs.existsSync(p));

const fromSdk = (sub: string, name: string) => {
  for (const root of sdkRoots()) {
    const candidate = path.join(root, sub, exe(name));
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
};

export const findAdb = () => fromSdk('platform-tools', 'adb') ?? which('adb');
export const findEmulator = () => fromSdk('emulator', 'emulator') ?? which('emulator');

export const avdHome = () => process.env.ANDROID_AVD_HOME ?? path.join(process.env.ANDROID_USER_HOME ?? path.join(os.homedir(), '.android'), 'avd');

/** AVD names from the AVD home, without starting the emulator binary. */
export const listAvds = (): string[] => {
  try {
    return fs
      .readdirSync(avdHome())
      .filter(f => f.endsWith('.ini'))
      .map(f => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
};

/** Device kind from an AVD's config: phone, tv, xr, wear, automotive. */
export const avdKind = (name: string): string => {
  try {
    const ini = fs.readFileSync(path.join(avdHome(), `${name}.avd`, 'config.ini'), 'utf8');
    const tag = /tag\.ids?\s*=\s*(.+)/.exec(ini)?.[1] ?? '';
    if (/android-tv|google-tv/.test(tag)) return 'tv';
    if (/xr/.test(tag)) return 'xr';
    if (/wear/.test(tag)) return 'wear';
    if (/automotive/.test(tag)) return 'automotive';
    if (/hw\.sensor\.hinge\s*=\s*yes/.test(ini)) return 'foldable';
    return 'phone';
  } catch {
    return 'unknown';
  }
};
