// Device leases: which pitbox session drives which emulator, simulator or phone. Several agents on one machine
// share its devices; a lease says whose a device is, so nobody shuts down, wipes or drives another's.
//
// One JSON file per device under ~/.pitbox/leases (PITBOX_HOME moves it), written whole and placed with a hard
// link, which fails when the file exists: two sessions racing for a device cannot both get it. A lease is stale
// when its holder's process is gone (after a short grace, so a restarting daemon keeps its devices) or when its
// heartbeat is older than its time to live; a stale lease is taken over under a lock of its own.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isAlive} from '../util/proc.ts';

export type Platform = 'android' | 'apple';

/** Who asks: a daemon (`daemon:<root>`) or a shell lease (`as:<label>`). */
export type Holder = {owner: string; label: string; pid?: number; root?: string};

export type Lease = Holder & {
  platform: Platform;
  /** Serial or udid. */
  device: string;
  /** What a person calls it: the AVD, the simulator's name. */
  name?: string;
  purpose?: string;
  since: number;
  heartbeat: number;
  /** How long the lease lives without a heartbeat. */
  ttlMs: number;
  /** pitbox booted this device for the holder: it goes down with the lease. */
  booted?: boolean;
};

/** A daemon heartbeats every half minute; ten minutes without one is a daemon that hangs or is gone. */
export const DAEMON_TTL_MS = 10 * 60_000;
/** A holder whose process ended keeps its devices this long: a daemon restarted after an upgrade picks them up. */
export const DEAD_GRACE_MS = 60_000;
/** A takeover lock older than this was left by a process that died while holding it. */
const TAKEOVER_STALE_MS = 10_000;

export const pitboxHome = () => process.env.PITBOX_HOME ?? path.join(os.homedir(), '.pitbox');
export const leaseDir = () => path.join(pitboxHome(), 'leases');

export const leaseKey = (platform: Platform, device: string) => `${platform}-${device.replace(/[^\w.-]/g, '_')}`;
const leaseFile = (platform: Platform, device: string) => path.join(leaseDir(), `${leaseKey(platform, device)}.json`);

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

/** Why a lease no longer counts, or undefined while it does. */
export const staleReason = (l: Lease, now = Date.now(), alive: (pid: number) => boolean = isAlive): string | undefined => {
  const quiet = now - l.heartbeat;
  if (l.pid && !alive(l.pid) && quiet > DEAD_GRACE_MS) return `its holder (pid ${l.pid}) is gone`;
  if (quiet > l.ttlMs) return `no heartbeat for ${Math.round(quiet / 60_000)} min`;
  return undefined;
};

const ago = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);

/** `"shop · checkout pass" (pid 4242, /work/shop, for 12 min)` — enough for an agent to know whom to ask. */
export const describeHolder = (l: Lease, now = Date.now()) =>
  `"${l.label}" (${[l.pid ? `pid ${l.pid}` : undefined, l.root, `for ${ago(now - l.since)}`, l.purpose].filter(Boolean).join(', ')})`;

export const readLease = (platform: Platform, device: string): Lease | undefined => parse(leaseFile(platform, device));

/** The lease when it is live; a stale one counts as none. */
export const liveLease = (platform: Platform, device: string, now = Date.now()): Lease | undefined => {
  const l = readLease(platform, device);
  return l && !staleReason(l, now) ? l : undefined;
};

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

const tmpFile = (file: string) => `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;

/** Writes the lease where none is: false when one already is there. */
const place = (file: string, l: Lease): boolean => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = tmpFile(file);
  fs.writeFileSync(tmp, JSON.stringify(l, null, 1));
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    fs.rmSync(tmp, {force: true});
  }
};

/** Replaces the lease file whole: a reader never sees half of it. */
const overwrite = (file: string, l: Lease) => {
  const tmp = tmpFile(file);
  fs.writeFileSync(tmp, JSON.stringify(l, null, 1));
  fs.renameSync(tmp, file);
};

/** Runs `fn` under the device's takeover lock; undefined when another process holds the lock right now. */
const underTakeover = <T>(file: string, fn: () => T): T | undefined => {
  const lock = `${file}.takeover`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > TAKEOVER_STALE_MS) fs.rmSync(lock, {force: true});
      } catch {
        // gone already
      }
      continue;
    }
    try {
      fs.writeSync(fd, String(process.pid));
      return fn();
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, {force: true});
    }
  }
  return undefined;
};

export type AcquireOptions = {name?: string; purpose?: string; booted?: boolean; ttlMs?: number; now?: number};

export type Acquired =
  | {ok: true; lease: Lease; renewed: boolean; replaced?: {lease: Lease; why: string}}
  | {ok: false; lease: Lease};

/**
 * Takes the device for `holder`, or renews the holder's own lease. Fails with the current lease when someone else
 * holds it. `sameHolder` says which leases count as the holder's own (by default: the same owner).
 */
export const acquire = (platform: Platform, device: string, holder: Holder, opts: AcquireOptions = {}, sameHolder: (l: Lease) => boolean = l => l.owner === holder.owner): Acquired => {
  const file = leaseFile(platform, device);
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = opts.now ?? Date.now();
    const fresh: Lease = {...holder, platform, device, name: opts.name, purpose: opts.purpose, since: now, heartbeat: now, ttlMs: opts.ttlMs ?? DAEMON_TTL_MS, booted: opts.booted || undefined};
    if (place(file, fresh)) return {ok: true, lease: fresh, renewed: false};
    const current = parse(file);
    if (!current) {
      // Half a moment between another writer's link and its content is impossible (the file is linked whole);
      // an unreadable file is debris: taken over below like a stale lease.
    } else if (sameHolder(current)) {
      const renewed: Lease = {
        ...current,
        heartbeat: now,
        pid: current.owner === holder.owner ? (holder.pid ?? current.pid) : current.pid,
        name: opts.name ?? current.name,
        purpose: opts.purpose ?? current.purpose,
        ttlMs: current.owner === holder.owner ? (opts.ttlMs ?? current.ttlMs) : current.ttlMs,
        booted: current.booted || opts.booted || undefined,
      };
      overwrite(file, renewed);
      return {ok: true, lease: renewed, renewed: true};
    } else if (!staleReason(current, now)) {
      return {ok: false, lease: current};
    }
    const taken = underTakeover(file, () => {
      const again = parse(file);
      // Re-read under the lock: someone may have taken it over a moment ago.
      const why = again ? staleReason(again, now) : 'unreadable';
      if (again && !why) return undefined;
      fs.rmSync(file, {force: true});
      return place(file, fresh) ? {lease: fresh, replaced: again && why ? {lease: again, why} : undefined} : undefined;
    });
    if (taken) return {ok: true, lease: taken.lease, renewed: false, ...(taken.replaced ? {replaced: taken.replaced} : {})};
  }
  const current = parse(file);
  if (current) return {ok: false, lease: current};
  throw new Error(`could not lease ${platform} ${device}: its lease file keeps changing`);
};

/** Refreshes the heartbeat of the holder's own lease; false when it is no longer theirs. */
export const heartbeat = (platform: Platform, device: string, owner: string, patch: Partial<Pick<Lease, 'pid' | 'booted' | 'owner' | 'label'>> = {}, now = Date.now()): boolean => {
  const file = leaseFile(platform, device);
  const current = parse(file);
  if (!current || current.owner !== owner) return false;
  overwrite(file, {...current, ...patch, heartbeat: now});
  return true;
};

/**
 * Gives the device back. Only the holder may, unless `force` (which says whose it was); a stale lease anyone may
 * clear. Returns the lease that was there.
 */
export const release = (platform: Platform, device: string, isMine: (l: Lease) => boolean, opts: {force?: boolean} = {}): {released: boolean; lease?: Lease} => {
  const file = leaseFile(platform, device);
  const current = parse(file);
  if (!current) return {released: false};
  if (!isMine(current) && !opts.force && !staleReason(current)) throw new LeaseError(`${current.name ?? device} is held by ${describeHolder(current)}, not by you`, current);
  fs.rmSync(file, {force: true});
  return {released: true, lease: current};
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
