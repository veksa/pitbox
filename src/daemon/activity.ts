// What the daemon's clients are doing: calls in flight, the last call, and the pitbox version each client runs.
// A daemon in use is not stopped for a version swap — another session's run would lose its runner mid-step — and a
// client of another version sharing the daemon is something `doctor` reports.

/** A daemon with no call for this long is idle: a client of a newer version may replace it. */
export const IDLE_MS = 5 * 60_000;

/** What a client that sends no version is: a pitbox from before clients said theirs. */
export const UNVERSIONED = 'older';

/** The daemon's own housekeeping calls, which say nothing about a session at work. */
const QUIET = new Set(['ping']);

export type ActivityReport = {version: string; inFlight: number; idleMs?: number; clients: {version: string; agoMs: number}[]};

export class Activity {
  readonly version: string;
  #inFlight = 0;
  #last?: number;
  readonly #clients = new Map<string, number>();

  constructor(version: string) {
    this.version = version;
  }

  /** A call starts; returns what ends it. Quiet calls are not counted. */
  begin(method: string, clientVersion: string | undefined, now = Date.now()): (at?: number) => void {
    if (QUIET.has(method)) return () => undefined;
    this.#inFlight++;
    this.#last = now;
    this.#clients.set(clientVersion || UNVERSIONED, now);
    let ended = false;
    return (at = Date.now()) => {
      if (ended) return;
      ended = true;
      this.#inFlight--;
      this.#last = Math.max(this.#last ?? at, at);
    };
  }

  report(now = Date.now()): ActivityReport {
    return {
      version: this.version,
      inFlight: this.#inFlight,
      ...(this.#last !== undefined ? {idleMs: now - this.#last} : {}),
      clients: [...this.#clients].filter(([, at]) => now - at < IDLE_MS).map(([version, at]) => ({version, agoMs: now - at})),
    };
  }

  /** Why the daemon counts as in use, or undefined when it is idle. */
  busy(now = Date.now()): string | undefined {
    return busyReason(this.report(now));
  }

  /** Clients of another version that called within the idle window. */
  strangers(now = Date.now()) {
    return this.report(now).clients.filter(c => c.version !== this.version);
  }
}

const secs = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

/** Why a daemon that reported this counts as in use, or undefined when it is idle. */
export const busyReason = (r: Pick<ActivityReport, 'inFlight' | 'idleMs'>): string | undefined => {
  if (r.inFlight > 0) return `${r.inFlight} call${r.inFlight > 1 ? 's' : ''} running`;
  if (r.idleMs !== undefined && r.idleMs < IDLE_MS) return `last call ${secs(r.idleMs)} ago`;
  return undefined;
};

/** `1.2.3` against `1.10.0`: negative when `a` is older. A pre-release sorts before its release. */
export const compareVersions = (a: string, b: string): number => {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    return {nums: core.split('.').map(n => Number.parseInt(n, 10) || 0), pre};
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
};
