// Leases that ended without a release: their holder process died (an agent killed with its daemon or script) or a
// shell lease ran out of ttl. Nobody gives such a device back, and nobody else may take it — a running device with
// no live lease is someone's to every other session — so the device pitbox booted for it would run, unowned, until
// the machine runs out of memory and sessions boot twins beside it.
//
// The reaper ends them. Any pitbox runs it: every daemon on each beat (whichever project's: the daemon that took the
// lease may be the one that died) and `pitbox lease list`. For each stale lease, once ORPHAN_GRACE_MS has passed
// since it went stale (the same session, restarted, takes its device again within it — lease.ts `sameSession`):
//
// - a device pitbox booted for the lease that still runs the very boot pitbox made (Lease.boot: a simulator's
//   launchd_sim process, an emulator's process — never a bare udid or serial) is shut down: the lease is first
//   replaced by a short one of the reaper, so no session takes the device while it goes down, then released;
// - any other stale lease — a device pitbox did not boot, a device no longer running, a simulator booted again since
//   (by hand, Xcode, another tool), an emulator serial now another emulator's, a lease with no boot mark (written by
//   pitbox before 0.3.2, or a boot whose mark could not be read), a device booted for a project that keeps its
//   devices up — is only removed. A device pitbox did not boot, or cannot tell it booted, is never shut down.
//
// A platform whose device list could not be read is not judged at all.

import {describeHolder, listLeases, ORPHAN_GRACE_MS, release, replaceStale, sameBoot, staleReason, staleSince, type Lease, type Platform} from './lease.ts';

/**
 * A device that runs now (not shut down), as the drivers list it. `instance` is an emulator's process; `boot` a
 * simulator's current boot (its launchd_sim process, AppleDriver.bootMarks), when it could be read.
 */
export type Running = {platform: Platform; id: string; name?: string; instance?: string; boot?: string};

export type ReapOptions = {
  running: Running[];
  /** Platforms whose list could not be read (or that this pitbox cannot drive): their leases are left as they are. */
  unread?: Set<Platform>;
  shutdown: (platform: Platform, id: string) => Promise<unknown>;
  now?: number;
};

export type Reaped = {shutDown: Lease[]; swept: Lease[]; failed: {lease: Lease; error: string}[]};

/** How long the reaper's own lease lives: a reaper that dies mid-shutdown leaves the device to the next sweep. */
export const REAPER_TTL_MS = 5 * 60_000;

const REAPER = 'reaper:';

/**
 * Whether the running device still runs the boot pitbox made for the lease, beyond doubt: the only case in which a
 * lease may lead to a shutdown. A lease without a boot mark (an older pitbox's) never does; nor a simulator booted
 * again since (a crashed daemon's udid, booted later by hand or by Xcode), nor an emulator serial another emulator took.
 */
export const stillBootedByPitbox = (l: Lease, dev: Running | undefined): boolean => {
  if (!dev || !l.boot) return false;
  if (l.platform === 'apple') return sameBoot(l.boot, dev.boot);
  return !!dev.instance && l.boot === dev.instance && (!l.instance || l.instance === dev.instance);
};

/** Shuts down the devices pitbox booted for leases that ended, and clears the other stale leases (see the top). */
export const reapLeases = async (o: ReapOptions): Promise<Reaped> => {
  const now = o.now ?? Date.now();
  const out: Reaped = {shutDown: [], swept: [], failed: []};
  for (const l of listLeases()) {
    if (o.unread?.has(l.platform)) continue;
    const dev = o.running.find(r => r.platform === l.platform && r.id === l.device);
    const why = staleReason(l, now, dev?.instance);
    if (!why) continue;
    const reused = !!(dev?.instance && l.instance && dev.instance !== l.instance);
    if (!reused && now - staleSince(l) < ORPHAN_GRACE_MS) continue;
    const {stale: _, ...seen} = l as Lease & {stale?: string};
    if (!(l.booted && !l.keep && stillBootedByPitbox(l, dev))) {
      if (replaceStale(seen)) out.swept.push(seen);
      continue;
    }
    const was = l.owner.startsWith(REAPER) ? l.purpose : `booted for "${l.label}", whose lease ended (${why})`;
    const mark: Lease = {
      owner: `${REAPER}${process.pid}`,
      label: 'pitbox, shutting down a device whose lease ended',
      platform: l.platform,
      device: l.device,
      name: l.name,
      instance: l.instance,
      boot: l.boot,
      purpose: was,
      since: now,
      heartbeat: now,
      ttlMs: REAPER_TTL_MS,
      // Still pitbox's to shut down: a reaper that dies mid-way leaves the job to the next sweep.
      booted: true,
      created: l.created,
    };
    if (!replaceStale(seen, mark)) continue;
    try {
      await o.shutdown(l.platform, l.device);
    } catch (e) {
      // The reaper's lease stays: no session takes a device half shut down, and once it runs out the next sweep tries again.
      out.failed.push({lease: seen, error: (e as Error).message.split('\n')[0]!});
      continue;
    }
    out.shutDown.push(seen);
    release(l.platform, l.device, x => x.owner === mark.owner);
  }
  return out;
};

/** One line per thing a reap did, for a daemon's log or `lease list`. */
export const describeReaped = (r: Reaped): string[] => [
  ...r.shutDown.map(l => `shut down ${l.name ?? l.device} (${l.device}): pitbox booted it for ${describeHolder(l)}, whose lease ended`),
  ...r.swept.map(l => `cleared the stale lease of ${l.name ?? l.device} (${l.device}) by ${describeHolder(l)}`),
  ...r.failed.map(f => `could not shut down ${f.lease.name ?? f.lease.device} (${f.lease.device}): ${f.error}; the next sweep tries again`),
];

/**
 * What `lease list` and `doctor` warn about: a device pitbox booted waiting out its grace before it is shut down, and a
 * holder with several live devices of one platform (a session that booted a second one instead of using its first).
 */
export const leaseWarnings = (leases: (Lease & {stale?: string})[], now = Date.now()): string[] => {
  const out: string[] = [];
  for (const l of leases) {
    if (!l.stale || !l.booted || l.keep || !l.boot || l.owner.startsWith(REAPER)) continue;
    const left = Math.max(0, Math.ceil((staleSince(l) + ORPHAN_GRACE_MS - now) / 60_000));
    out.push(`${l.name ?? l.device} (${l.device}) was booted by pitbox for ${describeHolder(l, now)}, whose lease ended: if it still runs, it is shut down ${left ? `in about ${left} min` : 'on the next sweep'} unless that session takes it again`);
  }
  const byHolder = new Map<string, Lease[]>();
  for (const l of leases) {
    if (l.stale || l.owner.startsWith(REAPER)) continue;
    const k = `${l.owner}|${l.platform}`;
    byHolder.set(k, [...(byHolder.get(k) ?? []), l]);
  }
  for (const list of byHolder.values()) {
    if (list.length < 2) continue;
    const l = list[0]!;
    const what = l.platform === 'apple' ? 'simulators' : 'Android devices';
    out.push(`"${l.label}" holds ${list.length} ${what}: ${list.map(x => x.name ?? x.device).join(', ')} — give back the ones it does not use (\`device release device=<id>\`)`);
  }
  return out;
};
