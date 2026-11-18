// App crashes on a simulator. A crashing simulator app leaves a crash report (.ips) in the Mac's
// ~/Library/Logs/DiagnosticReports a few seconds after it dies; there is no log stream to watch. So an action
// notes whether the app was running when it began, and when the app is gone afterwards, waits for the report.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AppEvent} from '../android/events.ts';
import type {AppleDriver} from './driver.ts';

type Frame = {imageIndex?: number; symbol?: string; sourceFile?: string; sourceLine?: number; imageOffset?: number};
type Ips = {
  procPath?: string;
  captureTime?: string;
  bundleInfo?: {CFBundleIdentifier?: string};
  exception?: {type?: string; signal?: string; subtype?: string};
  termination?: {indicator?: string};
  asi?: Record<string, string[]>;
  lastExceptionBacktrace?: Frame[];
  faultingThread?: number;
  threads?: {frames?: Frame[]; name?: string; queue?: string}[];
  usedImages?: {name?: string}[];
};

export const reportsDir = () => path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');

/**
 * A crash report of `bundleId` on the simulator `udid` as an event, or undefined when it is someone else's. An empty
 * `udid` is the Mac itself: a report of an app that does not run in a simulator.
 */
export const parseIps = (text: string, bundleId: string | undefined, udid: string, fallbackAt: number): AppEvent | undefined => {
  const nl = text.indexOf('\n');
  if (nl < 0) return undefined;
  let header: {bundleID?: string; bug_type?: string; timestamp?: string};
  let body: Ips;
  try {
    header = JSON.parse(text.slice(0, nl));
    body = JSON.parse(text.slice(nl + 1));
  } catch {
    return undefined;
  }
  // 309 is a crash; hangs, jetsam and the like have other types.
  if (header.bug_type !== '309') return undefined;
  if (udid ? !body.procPath?.includes(`/CoreSimulator/Devices/${udid}/`) : !body.procPath || body.procPath.includes('/CoreSimulator/')) return undefined;
  const id = header.bundleID ?? body.bundleInfo?.CFBundleIdentifier;
  if (bundleId && id !== bundleId) return undefined;
  const images = body.usedImages ?? [];
  const frame = (f: Frame) => {
    const image = images[f.imageIndex ?? -1]?.name ?? '?';
    const where = f.sourceFile && f.sourceLine ? ` (${path.basename(f.sourceFile)}:${f.sourceLine})` : '';
    return `${image} ${f.symbol ?? `+${f.imageOffset ?? 0}`}${where}`;
  };
  // An uncaught Objective-C exception keeps its stack in lastExceptionBacktrace; the faulting thread then only
  // shows the abort.
  const frames = body.lastExceptionBacktrace?.length ? body.lastExceptionBacktrace : (body.threads?.[body.faultingThread ?? 0]?.frames ?? []);
  const reason = Object.values(body.asi ?? {}).flat().find(Boolean);
  const ex = body.exception;
  const summary = [ex?.type, ex?.signal && `(${ex.signal})`, reason ?? body.termination?.indicator].filter(Boolean).join(' ');
  // The capture time, else the header's: a report's file can be touched long after it was written, so its mtime is
  // only the last resort.
  const at = reportTime(body.captureTime) ?? reportTime(header.timestamp) ?? fallbackAt;
  return {at, kind: 'crash', summary: summary || 'crash', lines: frames.slice(0, 15).map(frame)};
};

/** `2026-01-02 10:00:00.1234 +0200` (a report's capture time or header timestamp) as epoch ms. */
const reportTime = (t: string | undefined): number | undefined => {
  if (!t) return undefined;
  const at = Date.parse(t.replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1').replace(/(\.\d{1,2})(?=\s)/, m => m.padEnd(4, '0')).replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(at) ? at : undefined;
};

/** The header line of a report (its first line), read without the rest of the file. */
const readHead = (file: string): {bundleID?: string; bug_type?: string; name?: string; app_name?: string} | undefined => {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    return JSON.parse(nl < 0 ? text : text.slice(0, nl));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

/**
 * How many crash reports macOS keeps of the app's process in `dir`, which is what it counts against its limit: it
 * saves a crash report only while fewer than {@link AppleCrashWatcher.keptReports} of that process are in the
 * directory, whatever their dates, and drops every later one until old ones are removed.
 */
export const keptReports = (dir: string, bundleId: string): number => {
  const heads: {name?: string; bundleID?: string}[] = [];
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.ips') || file.startsWith('.')) continue;
      const head = readHead(path.join(dir, file));
      if (head?.bug_type === '309') heads.push({name: head.name ?? head.app_name, bundleID: head.bundleID});
    }
  } catch {
    return 0;
  }
  // The limit is per process name: another app with the same executable name shares it.
  const names = new Set(heads.filter(h => h.bundleID === bundleId && h.name).map(h => h.name));
  return heads.filter(h => h.name && names.has(h.name)).length;
};

/** Whether the app runs, and whether its reports are slow to come (visionOS). */
export type CrashProbe = {running: () => Promise<boolean>; slow: () => Promise<boolean>};

export class AppleCrashWatcher {
  readonly #probe: CrashProbe;
  readonly #udid: string;
  readonly #bundleId?: string;
  readonly #dir: string;
  /** Whether the app ran when the current action began. */
  #wasRunning?: Promise<boolean>;
  /** Each report read so far, with the mtime and size it had: a file touched or rewritten later is read again. */
  readonly #seen = new Map<string, {stamp: string; event?: AppEvent; written?: number}>();

  /** `driver` reads a simulator; a probe stands for a Mac app (`udid` empty). */
  constructor(driver: AppleDriver | CrashProbe, udid: string, bundleId?: string, dir = reportsDir()) {
    this.#probe =
      'simctl' in driver
        ? {
            running: async () => {
              if (!bundleId) return false;
              // The Mac's process list first (a tenth of the time); launchctl inside the simulator when it cannot tell.
              const seen = 'appRunning' in driver ? await driver.appRunning(udid, bundleId).catch(() => undefined) : undefined;
              if (seen !== undefined) return seen;
              const r = await driver.simctl(['spawn', udid, 'launchctl', 'list'], {timeoutMs: 10_000});
              return r.stdout.split('\n').some(l => l.includes(`UIKitApplication:${bundleId}[`) && /^\d+\s/.test(l));
            },
            slow: () => driver.simulators().then(sims => sims.find(s => s.udid === udid)?.kind === 'xr').catch(() => false),
          }
        : driver;
    this.#udid = udid;
    this.#bundleId = bundleId;
    this.#dir = dir;
  }

  start() {}

  stop() {}

  /**
   * `front` is what the last snapshot showed. Asking launchctl races the action: an app that crashes on a tap is
   * often gone before the answer comes, so it is only the fallback without a snapshot.
   */
  begin(front?: string[]) {
    this.#wasRunning = front ? Promise.resolve(!!this.#bundleId && front.includes(this.#bundleId)) : this.#running().catch(() => false);
  }

  #running(): Promise<boolean> {
    return this.#probe.running();
  }

  /**
   * The app's reports written since `since`, by what is in them: a file's name and creation say nothing, as macOS
   * touches an old report of the same crash instead of writing a new one when it keeps too many. `touched` is set
   * when a report of the app from before `since` was modified since: the sign of a crash that macOS saw and saved
   * no report of.
   */
  #scan(since: number, seen?: {touched: boolean}): AppEvent[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.#dir).filter(n => n.endsWith('.ips') && !n.startsWith('.'));
    } catch {
      return [];
    }
    const out: AppEvent[] = [];
    for (const name of names) {
      const file = path.join(this.#dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < since - 1000) continue;
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      let entry = this.#seen.get(file);
      if (entry?.stamp !== stamp) {
        let event: AppEvent | undefined;
        let written: number | undefined;
        try {
          const text = fs.readFileSync(file, 'utf8');
          event = parseIps(text, this.#bundleId, this.#udid, stat.mtimeMs);
          // When a crash report of the app, from any simulator, was written: by its header, not its file.
          const head = JSON.parse(text.slice(0, text.indexOf('\n'))) as {bundleID?: string; bug_type?: string; timestamp?: string};
          if (head.bug_type === '309' && head.bundleID === this.#bundleId) written = reportTime(head.timestamp);
        } catch {}
        entry = {stamp, event, written};
        this.#seen.set(file, entry);
      }
      const e = entry.event;
      // The capture time comes after the crash: a small margin, or the last action's crash leaks into the next.
      if (e && e.at >= since - 300) out.push(e);
      else if (seen && entry.written !== undefined && entry.written < since - 1000) seen.touched = true;
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /**
   * visionOS keeps a crashed app's process listed while it writes the report, which takes up to a minute: there
   * the app is gone when its window is.
   */
  #slow?: Promise<boolean>;

  /**
   * How long a report is waited for once the app is gone: briefly after each action, longer on visionOS and when a
   * flow has failed — under load the reporter takes close to a minute on every platform.
   */
  static waitMs = {quick: 8000, long: 60_000};

  /** How many crash reports of one process macOS keeps in its reports directory; past that it saves no more. */
  static keptReports = 25;

  /** A report of the app that macOS will not save, and why, or undefined while it would. */
  #notSaved(): string | undefined {
    if (!this.#bundleId) return undefined;
    const kept = keptReports(this.#dir, this.#bundleId);
    if (kept < AppleCrashWatcher.keptReports) return undefined;
    return `no crash report: macOS saves none while it keeps ${AppleCrashWatcher.keptReports} of the app and it has ${kept}; remove old ones from ${this.#dir}`;
  }

  async since(since: number, after?: string[], final = false): Promise<AppEvent[]> {
    let found = this.#scan(since);
    const was = await this.#wasRunning;
    this.#wasRunning = undefined;
    if (found.length || !(was || final)) return found;
    this.#slow ??= this.#probe.slow().catch(() => false);
    const slow = await this.#slow;
    const gone = (slow && !!after && !!this.#bundleId && !after.includes(this.#bundleId)) || !(await this.#running().catch(() => true));
    // The app died during the action and its report is not written yet: it takes the reporter a few seconds. A
    // report macOS will not save is not waited for.
    if (gone) {
      let why = found.length ? undefined : this.#notSaved();
      // The count may include a report written since the scan above.
      if (why) found = this.#scan(since);
      if (found.length) why = undefined;
      const deadline = Date.now() + (slow || final ? AppleCrashWatcher.waitMs.long : AppleCrashWatcher.waitMs.quick);
      const seen = {touched: false};
      let touchedAt: number | undefined;
      while (!found.length && !why && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 400));
        found = this.#scan(since, seen);
        // An old report of the app touched: macOS took the crash for one it has a report of and saved none. A
        // moment more for a new report that comes with it, then the answer.
        if (seen.touched && !found.length) {
          touchedAt ??= Date.now();
          if (Date.now() - touchedAt >= 1200) why = this.#notSaved() ?? 'no crash report: macOS saved none, it took the crash for one it has a report of';
        }
      }
      if (!found.length) {
        why ??= this.#notSaved() ?? 'no crash report yet';
        found = [{at: Date.now(), kind: 'crash', summary: `${this.#bundleId} stopped running during the action (${why})`, lines: []}];
      }
    }
    return found;
  }
}
