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

/** Device kind from an AVD's config: phone, foldable, tablet, desktop, tv, xr, glasses, wear, automotive. */
export const avdKind = (name: string): string => {
  try {
    return kindOfAvdConfig(fs.readFileSync(path.join(avdHome(), `${name}.avd`, 'config.ini'), 'utf8'));
  } catch {
    return 'unknown';
  }
};

export const kindOfAvdConfig = (ini: string): string => {
  const tag = /tag\.ids?\s*=\s*(.+)/.exec(ini)?.[1] ?? '';
  if (/android-tv|google-tv/.test(tag)) return 'tv';
  if (/ai-glasses/.test(tag)) return 'glasses';
  if (/xr/.test(tag)) return 'xr';
  if (/wear/.test(tag)) return 'wear';
  if (/automotive/.test(tag)) return 'automotive';
  if (/hw\.sensor\.hinge\s*=\s*yes/.test(ini)) return 'foldable';
  const device = /hw\.device\.name\s*=\s*(.+)/.exec(ini)?.[1]?.trim() ?? '';
  if (/^desktop/.test(device)) return 'desktop';
  // A tablet by size: the short side is at least 600 dp, the usual line between phone and tablet layouts.
  const px = (k: string) => Number(new RegExp(`hw\\.lcd\\.${k}\\s*=\\s*(\\d+)`).exec(ini)?.[1]);
  const shortDp = (Math.min(px('width'), px('height')) * 160) / (px('density') || 160);
  if (shortDp >= 600) return 'tablet';
  return 'phone';
};
