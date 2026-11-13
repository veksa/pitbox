// A daemon's side of device leases: the devices it holds, the choice of a device when none is named, the heartbeat,
// and giving everything back when it stops. The lease files themselves are in lease.ts.

import path from 'node:path';
import {acquire, DAEMON_TTL_MS, describeHolder, heartbeat, listLeases, processStart, readLease, refusal, release, staleReason, type Holder, type Lease, type Platform} from './lease.ts';

/** A device online now. `instance` is its current boot (Android), to tell a reused serial from the leased device. */
export type Candidate = {platform: Platform; id: string; name?: string; instance?: string; offline?: boolean};

export type Held = {platform: Platform; id: string; name?: string; instance?: string; booted: boolean; created: boolean};

const key = (platform: Platform, id: string) => `${platform}:${id}`;

/** The label other sessions see: the project's folder, and `PITBOX_SESSION` when the agent set one. */
export const sessionLabel = (root: string, env: NodeJS.ProcessEnv = process.env) => {
  const session = env.PITBOX_SESSION?.trim();
  return session ? `${path.basename(root)} · ${session}` : path.basename(root);
};

/** What a running device nobody leased is to every session: someone's (another tool, an older pitbox), until named. */
export const UNLEASED = 'running, unleased';

export class DeviceLeases {
  readonly holder: Holder;
  readonly #held = new Map<string, Held>();
  /** Whether the project keeps the devices it booted up after giving them back: they are then never reaped. */
  keepBooted: () => boolean = () => false;

  constructor(root: string, pid = process.pid, label = sessionLabel(root), session = process.env.PITBOX_SESSION?.trim() || undefined) {
    this.holder = {owner: `daemon:${root}`, label, pid, pidStart: processStart(pid), root, ...(session ? {session} : {})};
  }

  /** A lease of this daemon, or of a shell lease taken in the same project (`pitbox lease acquire` there). */
  isMine = (l: Lease) => l.owner === this.holder.owner || (!!l.root && l.root === this.holder.root);

  /** Who holds a device: undefined when nobody does (no lease, a stale one, or one taken on an earlier boot). */
  holderOf(platform: Platform, id: string, instance?: string): {mine: boolean; lease: Lease} | undefined {
    const l = readLease(platform, id);
    if (!l) return undefined;
    if (instance && l.instance && instance !== l.instance) return undefined;
    if (this.isMine(l)) return {mine: true, lease: l};
    return staleReason(l) ? undefined : {mine: false, lease: l};
  }

  /** A short tag for device lists: `yours`, `held by "label" (pid …)`, or `running, unleased`. */
  tag(platform: Platform, id: string, instance?: string, running = true): string | undefined {
    const h = this.holderOf(platform, id, instance);
    if (!h) return running ? UNLEASED : undefined;
    return h.mine ? `yours${h.lease.created ? ', created here' : h.lease.booted ? ', booted here' : ''}` : `held by ${describeHolder(h.lease)}`;
  }

  /** Takes the device or renews the hold; throws the refusal naming its holder when someone else has it. */
  claim(platform: Platform, id: string, opts: {name?: string; purpose?: string; booted?: boolean; created?: boolean; instance?: string} = {}): Lease {
    const r = acquire(platform, id, this.holder, {...opts, ...(opts.booted && this.keepBooted() ? {keep: true} : {}), ttlMs: DAEMON_TTL_MS}, this.isMine);
    if (!r.ok) throw new Error(refusal(r.lease, opts.name ?? r.lease.name ?? id));
    const was = this.#held.get(key(platform, id));
    this.#held.set(key(platform, id), {
      platform,
      id,
      name: opts.name ?? r.lease.name ?? was?.name,
      instance: r.lease.instance ?? opts.instance,
      booted: !!(r.lease.booted || opts.booted),
      created: !!(r.lease.created || opts.created),
    });
    return r.lease;
  }

  /** Whether this daemon may drive the device without asking: it holds it. */
  holds(platform: Platform, id: string, instance?: string): boolean {
    return !!this.holderOf(platform, id, instance)?.mine;
  }

  held(): Held[] {
    return [...this.#held.values()];
  }

  /**
   * The device a call without a device means: the one this session holds. A device another session holds is never
   * chosen, and neither is a running device nobody leased (another tool or an older pitbox may be driving it): it
   * is taken only when named. `observe` (reading only) may look at the only device online, whoever's it is.
   */
  choose(candidates: Candidate[], opts: {observe?: boolean} = {}): Candidate {
    const mine: Candidate[] = [];
    const unleased: Candidate[] = [];
    const taken: {c: Candidate; lease: Lease}[] = [];
    for (const c of candidates) {
      const h = this.holderOf(c.platform, c.id, c.instance);
      if (!h) unleased.push(c);
      else if (h.mine) mine.push(c);
      else taken.push({c, lease: h.lease});
    }
    const names = (list: Candidate[]) => list.map(c => c.name ?? c.id).join(', ');
    if (mine.length === 1) return mine[0]!;
    if (mine.length > 1) throw new Error(`you hold several devices\nhint: pass a device: ${names(mine)}`);
    if (opts.observe && candidates.length === 1) return candidates[0]!;
    const lines = [...taken.map(t => `${t.c.name ?? t.c.id} — held by ${describeHolder(t.lease)}`), ...unleased.map(c => `${c.name ?? c.id} (${c.id}) — ${UNLEASED}`)];
    const hint = unleased.length
      ? `\`device boot\` gives you one of your own; a running device nobody leased is taken only when named (device=${unleased[0]!.id}) — make sure no one else drives it`
      : "`device boot` gives you one of your own; pitbox does not touch another session's device";
    throw new Error(`no device of this session is online:\n${lines.join('\n')}\nhint: ${hint}`);
  }

  /** Beats a device must be missing from the lists, and for how long, before its lease goes. */
  static readonly ABSENT_BEATS = 3;
  static readonly ABSENT_MS = 90_000;
  /** When a whole platform's list comes back empty (adb restarted, CoreSimulator restarting): much longer. */
  static readonly EMPTY_LIST_MS = 5 * 60_000;
  /** An emulator or phone offline this long counts as gone: one stuck offline does not hold its lease forever. */
  static readonly OFFLINE_MS = 10 * 60_000;
  readonly #absent = new Map<string, {since: number; count: number}>();
  readonly #offline = new Map<string, number>();

  /**
   * Renews the leases, and gives back the devices that went away for good: missing from the lists for several beats
   * in a row and a while (a device that blinks out — adb restarted by another session, an emulator offline under
   * load, a reboot, a USB reconnect — keeps its lease), or an emulator serial now another emulator's (at once).
   * `online` lists every device the drivers report in any state (offline counts as present, for up to OFFLINE_MS);
   * undefined when no list could be read, and `unread` names a platform whose list could not: its devices are not
   * judged. `busy`: devices on their way up. Returns the dropped devices.
   */
  beat(online?: Candidate[], busy: Set<string> = new Set(), now = Date.now(), unread: Set<Platform> = new Set()): Held[] {
    const lost: Held[] = [];
    const drop = (k: string, h: Held) => {
      const l = readLease(h.platform, h.id);
      if (l && l.owner === this.holder.owner && (!h.instance || !l.instance || l.instance === h.instance)) release(h.platform, h.id, this.isMine);
      this.#held.delete(k);
      this.#absent.delete(k);
      this.#offline.delete(k);
      lost.push(h);
    };
    for (const [k, h] of this.#held) {
      if (online && !busy.has(h.id) && !unread.has(h.platform)) {
        let here = online.find(c => c.platform === h.platform && c.id === h.id);
        if (here?.offline) {
          const since = this.#offline.get(k) ?? now;
          this.#offline.set(k, since);
          if (now - since >= DeviceLeases.OFFLINE_MS) here = undefined;
        } else this.#offline.delete(k);
        if (here && h.instance && here.instance && h.instance !== here.instance) {
          drop(k, h);
          continue;
        }
        if (!here) {
          const a = this.#absent.get(k) ?? {since: now, count: 0};
          a.count++;
          this.#absent.set(k, a);
          const wait = online.some(c => c.platform === h.platform) ? DeviceLeases.ABSENT_MS : DeviceLeases.EMPTY_LIST_MS;
          if (a.count >= DeviceLeases.ABSENT_BEATS && now - a.since >= wait) {
            drop(k, h);
            continue;
          }
        } else this.#absent.delete(k);
        // A lease taken while the emulator's instance was unknown gets it now.
        // Only from the same AVD: a reused port may already show another session's emulator.
        if (here?.instance && !h.instance && here.name && here.name === h.name) h.instance = here.instance;
      } else if (online && !unread.has(h.platform)) this.#absent.delete(k);
      const l = readLease(h.platform, h.id);
      if (heartbeat(h.platform, h.id, this.holder.owner, {pid: this.holder.pid, pidStart: this.holder.pidStart, ...(h.instance ? {instance: h.instance} : {})})) continue;
      // A shell lease of this project that this daemon used: still ours, not renewed by us.
      if (l && this.isMine(l)) continue;
      this.#held.delete(k);
      this.#absent.delete(k);
      lost.push(h);
    }
    return lost;
  }

  /** Picks up the leases a previous daemon of this project left (a restart after an upgrade). */
  adopt(): Held[] {
    const adopted: Held[] = [];
    for (const l of listLeases()) {
      if (l.owner !== this.holder.owner) continue;
      if (!heartbeat(l.platform, l.device, l.owner, {pid: this.holder.pid, pidStart: this.holder.pidStart, label: this.holder.label})) continue;
      const h: Held = {platform: l.platform, id: l.device, name: l.name, instance: l.instance, booted: !!l.booted, created: !!l.created};
      this.#held.set(key(l.platform, l.device), h);
      adopted.push(h);
    }
    return adopted;
  }

  /** Gives one device back; forgotten whether or not the file was still ours. */
  release(platform: Platform, id: string, opts: {force?: boolean; instance?: string} = {}): {released: boolean; lease?: Lease} {
    this.#held.delete(key(platform, id));
    return release(platform, id, this.isMine, opts);
  }

  /**
   * Gives every device back. `shutdown` is called for the devices this daemon booted (when the config lets it);
   * devices it found running stay running.
   */
  async releaseAll(shutdown?: (h: Held) => Promise<unknown>): Promise<{released: Held[]; shutDown: Held[]}> {
    const released: Held[] = [];
    const shutDown: Held[] = [];
    for (const h of [...this.#held.values()]) {
      const l = readLease(h.platform, h.id);
      // Someone else's by now, or a shell lease of this project that this daemon only used: not ours to end.
      if (!l || l.owner !== this.holder.owner || (h.instance && l.instance && l.instance !== h.instance)) {
        this.#held.delete(key(h.platform, h.id));
        continue;
      }
      if (h.booted && shutdown) {
        try {
          await shutdown(h);
          shutDown.push(h);
        } catch {
          // gone already, or it would not stop: the lease goes anyway
        }
      }
      this.release(h.platform, h.id);
      released.push(h);
    }
    return {released, shutDown};
  }
}
