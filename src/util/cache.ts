// Versioned build caches shared by every pitbox process on the machine (~/Library/Caches/pitbox/<tool>/<version>):
// the Apple runner, the fold helper, the Mac runner. Several daemons use them at once, from different projects and
// different pitbox versions, so a version is never deleted while someone uses it or builds it.
//
// - A process that uses a version leaves `<version>/.in-use-<pid>` for its life (gone on exit; a dead pid's marker
//   does not count) and touches `<version>/.last-used`.
// - A build holds `<version>.lock` (its pid inside); a second process building the same version waits for it.
// - GC removes a version only when nobody uses or builds it, it is not among the newest few, and it was last used
//   long ago.

import fs from 'node:fs';
import path from 'node:path';
import {isAlive} from './proc.ts';

export const GC_KEEP = 3;
export const GC_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** A build that takes longer than this is wedged: its lock no longer holds others back. */
const BUILD_LOCK_MAX_MS = 30 * 60_000;

const IN_USE = '.in-use-';
const LAST_USED = '.last-used';

/** Pids whose in-use markers this process placed, to be removed when it exits. */
const placed = new Set<string>();
let exitHook = false;

/** Marks a version directory as used by this process for its lifetime, and stamps its last use. */
export const markInUse = (versionDir: string, pid = process.pid) => {
  fs.mkdirSync(versionDir, {recursive: true});
  const marker = path.join(versionDir, `${IN_USE}${pid}`);
  fs.writeFileSync(marker, String(Date.now()));
  fs.writeFileSync(path.join(versionDir, LAST_USED), String(Date.now()));
  if (pid !== process.pid) return;
  placed.add(marker);
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      for (const m of placed) fs.rmSync(m, {force: true});
    });
  }
};

/** Live users of a version: pids with a marker whose process still runs. */
export const usersOf = (versionDir: string, alive: (pid: number) => boolean = isAlive): number[] => {
  let names: string[] = [];
  try {
    names = fs.readdirSync(versionDir);
  } catch {
    return [];
  }
  return names
    .filter(n => n.startsWith(IN_USE))
    .map(n => Number(n.slice(IN_USE.length)))
    .filter(pid => Number.isInteger(pid) && pid > 0 && alive(pid));
};

const lockFile = (cache: string, version: string) => path.join(cache, `${version}.lock`);

/** The pid building a version now, or undefined. */
export const builder = (cache: string, version: string, alive: (pid: number) => boolean = isAlive, now = Date.now()): number | undefined => {
  const file = lockFile(cache, version);
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return undefined;
    if (now - fs.statSync(file).mtimeMs > BUILD_LOCK_MAX_MS) return undefined;
    return pid;
  } catch {
    return undefined;
  }
};

/**
 * Runs a build of `version` with its lock held. Another process building the same version is waited for (up to
 * `waitMs`), after which `fn` runs and usually finds the build done. A dead builder's lock is taken over.
 */
export const withBuildLock = async <T>(cache: string, version: string, fn: () => Promise<T>, opts: {waitMs?: number; pollMs?: number} = {}): Promise<T> => {
  fs.mkdirSync(cache, {recursive: true});
  const file = lockFile(cache, version);
  const deadline = Date.now() + (opts.waitMs ?? BUILD_LOCK_MAX_MS);
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), {flag: 'wx'});
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (builder(cache, version) === undefined) {
      // Left by a process that died or wedged: remove it only if it is still the same file.
      try {
        const before = fs.readFileSync(file, 'utf8');
        if (builder(cache, version) === undefined && fs.readFileSync(file, 'utf8') === before) fs.rmSync(file, {force: true});
      } catch {
        // gone already
      }
      continue;
    }
    if (Date.now() > deadline) throw new Error(`another pitbox (pid ${builder(cache, version)}) has been building ${path.basename(cache)} ${version} for too long`);
    await new Promise(r => setTimeout(r, opts.pollMs ?? 1000));
  }
  try {
    return await fn();
  } finally {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, {force: true});
    } catch {
      // gone already
    }
  }
};

const lastUsed = (versionDir: string): number => {
  for (const f of [path.join(versionDir, LAST_USED), versionDir]) {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      // next
    }
  }
  return 0;
};

export type GcOptions = {keep?: number; maxAgeMs?: number; now?: number; alive?: (pid: number) => boolean};

/**
 * Removes old versions from a cache: never `current`, never one in use or being built, never the `keep` most
 * recently used, and only those unused for `maxAgeMs`. Returns the versions removed.
 */
export const gcVersions = (cache: string, current: string, opts: GcOptions = {}): string[] => {
  const keep = opts.keep ?? GC_KEEP;
  const maxAgeMs = opts.maxAgeMs ?? GC_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  const alive = opts.alive ?? isAlive;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(cache, {withFileTypes: true});
  } catch {
    return [];
  }
  const versions = entries
    .filter(e => e.isDirectory() && e.name !== current)
    .map(e => ({name: e.name, dir: path.join(cache, e.name), used: lastUsed(path.join(cache, e.name))}))
    .sort((a, b) => b.used - a.used);
  const removed: string[] = [];
  for (const [i, v] of versions.entries()) {
    if (i < keep - 1) continue; // `current` is one of the kept
    if (now - v.used < maxAgeMs) continue;
    if (usersOf(v.dir, alive).length) continue;
    if (builder(cache, v.name, alive, now) !== undefined) continue;
    fs.rmSync(v.dir, {recursive: true, force: true});
    removed.push(v.name);
  }
  return removed;
};
