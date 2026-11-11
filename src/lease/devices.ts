// A daemon's side of device leases: the devices it holds, the choice of a device when none is named, the heartbeat,
// and giving everything back when it stops. The lease files themselves are in lease.ts.

import path from 'node:path';
import {acquire, DAEMON_TTL_MS, describeHolder, heartbeat, listLeases, readLease, refusal, release, staleReason, type Holder, type Lease, type Platform} from './lease.ts';

export type Candidate = {platform: Platform; id: string; name?: string};

export type Held = {platform: Platform; id: string; name?: string; booted: boolean};

const key = (platform: Platform, id: string) => `${platform}:${id}`;

/** The label other sessions see: the project's folder, and `PITBOX_SESSION` when the agent set one. */
export const sessionLabel = (root: string, env: NodeJS.ProcessEnv = process.env) => {
  const session = env.PITBOX_SESSION?.trim();
  return session ? `${path.basename(root)} · ${session}` : path.basename(root);
};

export class DeviceLeases {
  readonly holder: Holder;
  readonly #held = new Map<string, Held>();

  constructor(root: string, pid = process.pid, label = sessionLabel(root)) {
    this.holder = {owner: `daemon:${root}`, label, pid, root};
  }

  /** A lease of this daemon, or of a shell lease taken in the same project (`pitbox lease acquire` there). */
  isMine = (l: Lease) => l.owner === this.holder.owner || (!!l.root && l.root === this.holder.root);

  /** Who holds a device, as other sessions see it: undefined when nobody (or a stale lease). */
  holderOf(platform: Platform, id: string): {mine: boolean; lease: Lease} | undefined {
    const l = readLease(platform, id);
    if (!l) return undefined;
    if (this.isMine(l)) return {mine: true, lease: l};
    return staleReason(l) ? undefined : {mine: false, lease: l};
  }

  /** A short tag for device lists: `yours`, or `held by "label" (pid …)`. */
  tag(platform: Platform, id: string): string | undefined {
    const h = this.holderOf(platform, id);
    if (!h) return undefined;
    return h.mine ? `yours${h.lease.booted ? ', booted here' : ''}` : `held by ${describeHolder(h.lease)}`;
  }

  /** Takes the device or renews the hold; throws the refusal naming its holder when someone else has it. */
  claim(platform: Platform, id: string, opts: {name?: string; purpose?: string; booted?: boolean} = {}): Lease {
    const r = acquire(platform, id, this.holder, {...opts, ttlMs: DAEMON_TTL_MS}, this.isMine);
    if (!r.ok) throw new Error(refusal(r.lease, opts.name ?? r.lease.name ?? id));
    const was = this.#held.get(key(platform, id));
    this.#held.set(key(platform, id), {platform, id, name: opts.name ?? r.lease.name ?? was?.name, booted: !!(r.lease.booted || was?.booted || opts.booted)});
    return r.lease;
  }

  /** Whether this daemon may drive the device without asking: it holds it. */
  holds(platform: Platform, id: string): boolean {
    const h = this.holderOf(platform, id);
    return !!h?.mine;
  }

  held(): Held[] {
    return [...this.#held.values()];
  }

  /**
   * The device a call without a device means: the one this session holds, else the only free one (taken now).
   * Devices other sessions hold are never chosen; when they are all there is, the error names their holders.
   */
  choose(candidates: Candidate[], opts: {observe?: boolean} = {}): Candidate {
    const mine: Candidate[] = [];
    const free: Candidate[] = [];
    const taken: {c: Candidate; lease: Lease}[] = [];
    for (const c of candidates) {
      const h = this.holderOf(c.platform, c.id);
      if (!h) free.push(c);
      else if (h.mine) mine.push(c);
      else taken.push({c, lease: h.lease});
    }
    const names = (list: Candidate[]) => list.map(c => c.name ?? c.id).join(', ');
    if (mine.length === 1) return mine[0]!;
    if (mine.length > 1) throw new Error(`you hold several devices\nhint: pass a device: ${names(mine)}`);
    if (free.length === 1) {
      if (!opts.observe) this.claim(free[0]!.platform, free[0]!.id, {name: free[0]!.name});
      return free[0]!;
    }
    if (free.length > 1) throw new Error(`several devices online\nhint: pass a device: ${names(free)}`);
    if (opts.observe && taken.length === 1) return taken[0]!.c;
    const who = taken.map(t => `${t.c.name ?? t.c.id} — held by ${describeHolder(t.lease)}`).join('\n');
    throw new Error(`every device online is held by another session:\n${who}\nhint: \`device boot\` gives you one of your own; pitbox does not touch another session's device`);
  }

  /** Renews every lease; a lease taken away (forced, or expired and taken) is dropped. Returns the dropped ones. */
  beat(): Held[] {
    const lost: Held[] = [];
    for (const [k, h] of this.#held) {
      const ok = heartbeat(h.platform, h.id, this.holder.owner, {pid: this.holder.pid});
      if (ok) continue;
      const l = readLease(h.platform, h.id);
      // A shell lease of this project that this daemon used: still ours, not renewed by us.
      if (l && this.isMine(l)) continue;
      this.#held.delete(k);
      lost.push(h);
    }
    return lost;
  }

  /** Picks up the leases a previous daemon of this project left (a restart after an upgrade). */
  adopt(): Held[] {
    const adopted: Held[] = [];
    for (const l of listLeases()) {
      if (l.owner !== this.holder.owner) continue;
      if (!heartbeat(l.platform, l.device, l.owner, {pid: this.holder.pid, label: this.holder.label})) continue;
      const h: Held = {platform: l.platform, id: l.device, name: l.name, booted: !!l.booted};
      this.#held.set(key(l.platform, l.device), h);
      adopted.push(h);
    }
    return adopted;
  }

  /** Gives one device back; forgotten whether or not the file was still ours. */
  release(platform: Platform, id: string, opts: {force?: boolean} = {}): {released: boolean; lease?: Lease} {
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
      if (l && l.owner !== this.holder.owner) {
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
