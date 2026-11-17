// Warm simulator templates. A new simulator's first boot keeps the Mac busy for a minute or more: the runtime fills
// its data (caches, databases, the app registry), indexes and migrates it. pitbox creates a simulator whenever a
// session needs one of a model another session holds, and would pay that every time. A template — one simulator per
// model and runtime, booted once, left until it is quiet, then shut down — is cloned instead (`simctl clone`, a
// copy-on-write copy on APFS): the clone boots into data that has settled already.
//
// Templates are the Mac's, not a project's: any project's session clones them. They are written down in
// `~/.pitbox/sim-templates.json`; a simulator the file does not name is never taken for one.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pitboxHome, withLock} from '../../lease/lease.ts';

export type Template = {
  udid: string;
  name: string;
  deviceType: string;
  runtime: string;
  /** When it was made. */
  at: number;
  /** Booted, settled and shut down: ready to clone. Missing while it is being made. */
  ready?: boolean;
  /** The pid of the daemon making it (a template never made ready by a live pid is a leftover). */
  pid?: number;
};

const file = () => path.join(pitboxHome(), 'sim-templates.json');

const read = (): Template[] => {
  try {
    const list = JSON.parse(fs.readFileSync(file(), 'utf8')) as Template[];
    return Array.isArray(list) ? list.filter(t => t && typeof t.udid === 'string' && typeof t.deviceType === 'string') : [];
  } catch {
    return [];
  }
};

const write = (list: Template[]) => {
  fs.mkdirSync(path.dirname(file()), {recursive: true});
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, file());
};

export const listTemplates = (): Template[] => read();

/** The template of a model and runtime, ready or being made. */
export const templateOf = (deviceType: string, runtime: string): Template | undefined => read().find(t => t.deviceType === deviceType && t.runtime === runtime);

export const isTemplate = (udid: string): boolean => read().some(t => t.udid === udid);

/** Writes a template down, replacing the one of its model and runtime. */
export const recordTemplate = (t: Template) => withLock(file(), () => write([...read().filter(x => !(x.deviceType === t.deviceType && x.runtime === t.runtime) && x.udid !== t.udid), t]));

export const forgetTemplate = (udid: string) => withLock(file(), () => write(read().filter(t => t.udid !== udid)));

/** `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro` → `iPhone 17 Pro`. */
export const modelName = (deviceType: string): string => (deviceType.split('.').pop() ?? deviceType).replace(/-/g, ' ');

/** The name a template shows in Xcode's device list: recognisable, and never the name a session asks for. */
export const templateName = (deviceType: string, os: string): string => `pitbox template · ${modelName(deviceType)} · ${os}`;

/** One `ps -axo pid=,ppid=,time=,command=` line. */
type Proc = {pid: number; ppid: number; cpu: number; command: string};

const seconds = (t: string): number => {
  const p = t.split(':').map(Number);
  return p.length === 3 ? p[0]! * 3600 + p[1]! * 60 + p[2]! : p.length === 2 ? p[0]! * 60 + p[1]! : Number(t) || 0;
};

export const parseProcs = (ps: string): Proc[] =>
  ps
    .split('\n')
    .map(l => l.trim().split(/\s+/))
    .filter(f => f.length >= 4 && /^\d+$/.test(f[0]!))
    .map(f => ({pid: Number(f[0]), ppid: Number(f[1]), cpu: seconds(f[2]!), command: f.slice(3).join(' ')}));

/** CPU seconds a simulator has used: its launchd_sim (whose command line names the udid) and every process under it. */
export const simCpu = (procs: Proc[], udid: string): number => {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const stack = procs.filter(p => p.command.includes('launchd_sim') && p.command.includes(udid));
  let total = 0;
  while (stack.length) {
    const p = stack.pop()!;
    total += p.cpu;
    stack.push(...(kids.get(p.pid) ?? []));
  }
  return total;
};

export const readSimCpu = (udid: string): number => simCpu(parseProcs(execFileSync('ps', ['-axo', 'pid=,ppid=,time=,command='], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024})), udid);

/**
 * Waits until a just-booted simulator is quiet: under `cores` of CPU over a `window`, once `min` has passed, or
 * `max` at the latest. Answers whether it went quiet and how long that took.
 */
export const waitQuiet = async (
  cpu: () => number,
  opts: {cores?: number; windowMs?: number; minMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number} = {},
): Promise<{quiet: boolean; ms: number}> => {
  const {cores = 0.3, windowMs = 10_000, minMs = 30_000, maxMs = 240_000} = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const t0 = now();
  let prev = cpu();
  for (;;) {
    await sleep(windowMs);
    const next = cpu();
    const elapsed = now() - t0;
    if (elapsed >= minMs && (next - prev) / (windowMs / 1000) < cores) return {quiet: true, ms: elapsed};
    if (elapsed >= maxMs) return {quiet: false, ms: elapsed};
    prev = next;
  }
};
