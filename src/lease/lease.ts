// Device leases: which pitbox session drives which emulator, simulator or phone. Several agents on one machine
// share its devices; a lease says whose a device is, so nobody shuts down, wipes or drives another's.
//
// One JSON file per device under ~/.pitbox/leases (PITBOX_HOME moves it). Every change to a lease file — take,
// renew, heartbeat, take over, release — happens under that device's lock file, and the file itself is replaced
// whole (written aside, renamed in), so a reader never sees half of it.
//
// A lease with a holder process lives as long as that process: the same pid *and* the same start time (a pid the
// system reused for another program does not count). It is stale once the process is gone, after a short grace in
// which a restarted daemon picks its devices up. Only a lease with no process (a shell lease) expires by time.
// An Android serial is reused by the next emulator on that port, so an Android lease also names the boot it was
// taken on (`instance`): a device booted again is a different device.

import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isAlive} from '../util/proc.ts';

export type Platform = 'android' | 'apple';

/** Who asks: a daemon (`daemon:<root>`) or a shell lease (`as:<label>@<root>`). */
export type Holder = {owner: string; label: string; pid?: number; pidStart?: string; root?: string};

export type Lease = Holder & {
  platform: Platform;
  /** Serial or udid. */
  device: string;
  /** What a person calls it: the AVD, the simulator's name. */
  name?: string;
  /** The boot of the device the lease was taken on (Android: the kernel's boot id). */
  instance?: string;
  purpose?: string;
  since: number;
  heartbeat: number;
  /** How long a lease with no holder process lives without being renewed. */
  ttlMs: number;
  /** pitbox booted this device for the holder: it goes down with the lease. */
  booted?: boolean;
  /** pitbox created this simulator for the holder: it is deleted with the lease. */
  created?: boolean;
};

/** A daemon's lease does not expire while it runs; this is only what it says about itself. */
export const DAEMON_TTL_MS = 10 * 60_000;
/** A holder whose process ended keeps its devices this long: a daemon restarted after an upgrade picks them up. */
export const DEAD_GRACE_MS = 60_000;
/** A lock held longer than this, or by a process that is gone, was left behind. */
const LOCK_STALE_MS = 60_000;

export const pitboxHome = () => process.env.PITBOX_HOME ?? path.join(os.homedir(), '.pitbox');
export const leaseDir = () => path.join(pitboxHome(), 'leases');

export const leaseKey = (platform: Platform, device: string) => `${platform}-${device.replace(/[^\w.-]/g, '_')}`;
const leaseFile = (platform: Platform, device: string) => path.join(leaseDir(), `${leaseKey(platform, device)}.json`);

const startCache = new Map<number, {at: number; start?: string}>();

/** When a process started, as the system says (`ps -o lstart=`); undefined when it cannot tell (Windows, gone). */
export const processStart = (pid: number): string | undefined => {
  const hit = startCache.get(pid);
  if (hit && Date.now() - hit.at < 5000) return hit.start;
  let start: string | undefined;
  if (process.platform !== 'win32') {
    try {
      start = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']}).trim() || undefined;
    } catch {
      start = undefined;
    }
  }
  startCache.set(pid, {at: Date.now(), start});
  return start;
};

/** How a holder's process is checked; tests stand in for it. */
export const probe = {alive: isAlive, start: processStart};

export class LeaseError extends Error {
  readonly lease: Lease;

  constructor(message: string, lease: Lease) {
    super(message);
    this.lease = lease;
  }
}

const parse = (file: string): Lease | undefined => {
  try {
    const l = JSON.parse(fs.readFileSync(file, 'utf8')) as Lease;
    return l && typeof l.owner === 'string' && typeof l.device === 'string' ? l : undefined;
  } catch {
    return undefined;
  }
};

/** Whether the lease's holder process still runs: the same pid started at the same moment. */
const holderRuns = (l: Lease): boolean => {
  if (!l.pid || !probe.alive(l.pid)) return false;
  if (!l.pidStart) return true;
  const now = probe.start(l.pid);
  return now === undefined || now === l.pidStart;
};

/**
 * Why a lease no longer counts, or undefined while it does. `instance` is the device's current boot, when known:
 * a lease taken on another boot is not this device's.
 */
export const staleReason = (l: Lease, now = Date.now(), instance?: string): string | undefined => {
  if (instance && l.instance && instance !== l.instance) return 'taken on an earlier boot of a device that now has its serial';
  const quiet = now - l.heartbeat;
  if (l.pid) {
    if (holderRuns(l)) return undefined;
    return quiet > DEAD_GRACE_MS ? `its holder (pid ${l.pid}) is gone` : undefined;
  }
  return quiet > l.ttlMs ? `not renewed for ${Math.round(quiet / 60_000)} min` : undefined;
};

const ago = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);

/** `"shop · checkout pass" (pid 4242, /work/shop, for 12 min)` — enough for an agent to know whom to ask. */
export const describeHolder = (l: Lease, now = Date.now()) =>
  `"${l.label}" (${[l.pid ? `pid ${l.pid}` : undefined, l.root, `for ${ago(now - l.since)}`, l.purpose].filter(Boolean).join(', ')})`;

export const readLease = (platform: Platform, device: string): Lease | undefined => parse(leaseFile(platform, device));

/** Every lease file, live and stale. */
export const listLeases = (): (Lease & {stale?: string})[] => {
  let names: string[] = [];
  try {
    names = fs.readdirSync(leaseDir()).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const now = Date.now();
  return names.flatMap(f => {
    const l = parse(path.join(leaseDir(), f));
    if (!l) return [];
    const stale = staleReason(l, now);
    return [stale ? {...l, stale} : l];
  });
};

const aside = (file: string) => `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;

/** Replaces a file whole: written aside and renamed in. */
const writeWhole = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${aside(file)}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
};

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

type LockBody = {pid: number; start?: string; at: number};

const readLock = (lock: string): LockBody | undefined => {
  try {
    return JSON.parse(fs.readFileSync(lock, 'utf8')) as LockBody;
  } catch {
    return undefined;
  }
};

const lockLeft = (b: LockBody | undefined, lock: string): boolean => {
  if (!b) {
    // Unreadable: a lock is placed whole by a link, so this is debris; only old debris is cleared.
    try {
      return Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
  if (Date.now() - b.at > LOCK_STALE_MS) return true;
  if (!probe.alive(b.pid)) return true;
  const start = probe.start(b.pid);
  return !!b.start && !!start && start !== b.start;
};

const lockBody = (): string => JSON.stringify({pid: process.pid, start: probe.start(process.pid), at: Date.now()} satisfies LockBody);

/** Takes a lock file: placed whole with a link, which fails while another holds it. */
const tryLock = (lock: string): boolean => {
  fs.mkdirSync(path.dirname(lock), {recursive: true});
  const tmp = `${aside(lock)}.tmp`;
  fs.writeFileSync(tmp, lockBody());
  try {
    fs.linkSync(tmp, lock);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  } finally {
    fs.rmSync(tmp, {force: true});
  }
  // A lock left behind is moved aside under a name of its own (one process wins the rename) and removed only if
  // it is the very lock judged left behind; a fresh lock moved by mistake goes back.
  const seen = readLock(lock);
  if (!lockLeft(seen, lock)) return false;
  const moved = `${aside(lock)}.old`;
  try {
    fs.renameSync(lock, moved);
  } catch {
    return false;
  }
  const got = readLock(moved);
  if (seen && (!got || got.pid !== seen.pid || got.at !== seen.at)) {
    try {
      fs.linkSync(moved, lock);
    } catch {
      // a newer lock was placed meanwhile; it stands
    }
  }
  fs.rmSync(moved, {force: true});
  return false;
};

const unlock = (lock: string) => {
  if (readLock(lock)?.pid === process.pid) fs.rmSync(lock, {force: true});
};

/** Runs `fn` with `<file>.lock` held; waits up to `waitMs` for another holder. */
export const withLock = <T>(file: string, fn: () => T, waitMs = 10_000): T => {
  const lock = `${file}.lock`;
  const end = Date.now() + waitMs;
  while (!tryLock(lock)) {
    if (Date.now() > end) throw new Error(`${path.basename(file)} stays locked by pid ${readLock(lock)?.pid ?? '?'}`);
    sleepSync(5 + Math.random() * 20);
  }
  try {
    return fn();
  } finally {
    unlock(lock);
  }
};

/** The async form, for work that waits (creating a simulator); the lock is refreshed while it runs. */
export const withLockAsync = async <T>(file: string, fn: () => Promise<T>, waitMs = 180_000): Promise<T> => {
  const lock = `${file}.lock`;
  const end = Date.now() + waitMs;
  while (!tryLock(lock)) {
    if (Date.now() > end) throw new Error(`${path.basename(file)} stays locked by pid ${readLock(lock)?.pid ?? '?'}`);
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
  }
  const keep = setInterval(() => writeWhole(lock, lockBody()), LOCK_STALE_MS / 3);
  keep.unref();
  try {
    return await fn();
  } finally {
    clearInterval(keep);
    unlock(lock);
  }
};

/** A machine-wide lock under the lease folder, for work no two sessions may do at once (naming a new simulator). */
export const machineLock = <T>(name: string, fn: () => Promise<T>) => withLockAsync(path.join(leaseDir(), name), fn);

export type AcquireOptions = {name?: string; purpose?: string; booted?: boolean; created?: boolean; ttlMs?: number; instance?: string; now?: number};

export type Acquired =
  | {ok: true; lease: Lease; renewed: boolean; replaced?: {lease: Lease; why: string}}
  | {ok: false; lease: Lease};

/**
 * Takes the device for `holder`, or renews the holder's own lease. Fails with the current lease when someone else
 * holds it. `sameHolder` says which leases count as the holder's own (by default: the same owner).
 */
export const acquire = (platform: Platform, device: string, holder: Holder, opts: AcquireOptions = {}, sameHolder: (l: Lease) => boolean = l => l.owner === holder.owner): Acquired => {
  const file = leaseFile(platform, device);
  return withLock(file, () => {
    const now = opts.now ?? Date.now();
    const current = parse(file);
    const otherBoot = !!(opts.instance && current?.instance && opts.instance !== current.instance);
    if (current && sameHolder(current) && !otherBoot) {
      const own = current.owner === holder.owner;
      const renewed: Lease = {
        ...current,
        heartbeat: now,
        ...(own ? {pid: holder.pid, pidStart: holder.pidStart, label: holder.label} : {}),
        name: opts.name ?? current.name,
        purpose: opts.purpose ?? current.purpose,
        instance: current.instance ?? opts.instance,
        ttlMs: own ? (opts.ttlMs ?? current.ttlMs) : current.ttlMs,
        booted: current.booted || opts.booted || undefined,
        created: current.created || opts.created || undefined,
      };
      writeWhole(file, JSON.stringify(renewed, null, 1));
      return {ok: true as const, lease: renewed, renewed: true};
    }
    const why = current ? staleReason(current, now, opts.instance) : undefined;
    if (current && !why) return {ok: false as const, lease: current};
    const fresh: Lease = {
      ...holder,
      platform,
      device,
      name: opts.name,
      instance: opts.instance,
      purpose: opts.purpose,
      since: now,
      heartbeat: now,
      ttlMs: opts.ttlMs ?? DAEMON_TTL_MS,
      booted: opts.booted || undefined,
      created: opts.created || undefined,
    };
    writeWhole(file, JSON.stringify(fresh, null, 1));
    return {ok: true as const, lease: fresh, renewed: false, ...(current && why ? {replaced: {lease: current, why}} : {})};
  });
};

/** Refreshes the heartbeat of the holder's own lease; false when it is no longer theirs. */
export const heartbeat = (platform: Platform, device: string, owner: string, patch: Partial<Pick<Lease, 'pid' | 'pidStart' | 'label'>> = {}, now = Date.now()): boolean => {
  const file = leaseFile(platform, device);
  return withLock(file, () => {
    const current = parse(file);
    if (!current || current.owner !== owner) return false;
    writeWhole(file, JSON.stringify({...current, ...patch, heartbeat: now}, null, 1));
    return true;
  });
};

/**
 * Gives the device back. Only the holder may, unless `force` (the caller says whose it was); a stale lease anyone
 * may clear. Returns the lease that was there.
 */
export const release = (platform: Platform, device: string, isMine: (l: Lease) => boolean, opts: {force?: boolean; instance?: string} = {}): {released: boolean; lease?: Lease} => {
  const file = leaseFile(platform, device);
  return withLock(file, () => {
    const current = parse(file);
    if (!current) return {released: false};
    if (!isMine(current) && !opts.force && !staleReason(current, Date.now(), opts.instance)) throw new LeaseError(`${current.name ?? device} is held by ${describeHolder(current)}, not by you`, current);
    fs.rmSync(file, {force: true});
    return {released: true, lease: current};
  });
};

/** The refusal an agent sees when it reaches for someone else's device. */
export const refusal = (l: Lease, what = l.name ?? l.device) =>
  `${what} is held by ${describeHolder(l)}: pitbox does not touch another session's device\n` +
  'hint: `device boot` gives you one of your own (a free one of the same model, or a new instance), or pass a free device; `device list` shows who holds what';

/** `30m`, `2h`, `90s`, `45` (minutes) → milliseconds. */
export const parseDuration = (v: string): number => {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|min|h)?$/i.exec(v.trim());
  if (!m) throw new Error(`not a duration: "${v}" (30m, 2h, 90s)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  return Math.round(n * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'h' ? 3_600_000 : 60_000));
};
