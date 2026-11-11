// A rough look at the machine before another emulator or simulator starts: parallel sessions each get a device of
// their own, and the machine should say when that is one too many. A warning, never a refusal: the numbers are
// estimates, and a slow device is better than an agent stuck without one.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

/** What a booted device takes, roughly: an emulator its guest RAM and more, a simulator its share of the Mac. */
export const DEVICE_MB = {android: 3072, apple: 1536} as const;
/** Kept free for everything else (builds, the IDE, the dev server). */
const HEADROOM_MB = 2048;

/** `vm_stat` → memory the system can hand out without swapping: free, inactive, speculative and purgeable pages. */
export const availableFromVmStat = (out: string): number | undefined => {
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
  const pages = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
  const total = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable');
  return total ? Math.round((total * page) / 1048576) : undefined;
};

/** `/proc/meminfo` → MemAvailable in MB. */
export const availableFromMeminfo = (text: string): number | undefined => {
  const kb = Number(/MemAvailable:\s+(\d+)\s+kB/.exec(text)?.[1]);
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : undefined;
};

/** Memory available for a new device, in MB. */
export const availableMb = (): number => {
  try {
    if (process.platform === 'darwin') {
      const mb = availableFromVmStat(execFileSync('vm_stat', {encoding: 'utf8', timeout: 5000}));
      if (mb) return mb;
    }
    if (process.platform === 'linux') {
      const mb = availableFromMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (mb) return mb;
    }
  } catch {
    // the plain number below
  }
  return Math.round(os.freemem() / 1048576);
};

export type Machine = {availableMb: number; cpus: number; load1: number};

export const machine = (): Machine => ({availableMb: availableMb(), cpus: os.cpus().length || 1, load1: os.loadavg()[0] ?? 0});

/**
 * A warning when one more device is likely to make the machine swap or crawl; undefined when it should be fine.
 * `running` is how many emulators and simulators are booted already, whoever's they are.
 */
export const bootWarning = (platform: 'android' | 'apple', running: number, m: Machine = machine()): string | undefined => {
  const need = DEVICE_MB[platform];
  const problems: string[] = [];
  if (m.availableMb < need + HEADROOM_MB) problems.push(`${(m.availableMb / 1024).toFixed(1)} GB of memory available, ${platform === 'android' ? 'an emulator' : 'a simulator'} takes ~${(need / 1024).toFixed(1)} GB`);
  // Windows reports no load average (always 0).
  if (m.load1 > m.cpus * 1.5) problems.push(`load ${m.load1.toFixed(1)} on ${m.cpus} cores`);
  if (!problems.length) return undefined;
  return `${problems.join('; ')} with ${running} device${running === 1 ? '' : 's'} already running — another may swap and slow every session down; shut down a device of yours you no longer need`;
};
