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

/** A crash report of `bundleId` on the simulator `udid` as an event, or undefined when it is someone else's. */
export const parseIps = (text: string, bundleId: string | undefined, udid: string, fallbackAt: number): AppEvent | undefined => {
  const nl = text.indexOf('\n');
  if (nl < 0) return undefined;
  let header: {bundleID?: string; bug_type?: string};
  let body: Ips;
  try {
    header = JSON.parse(text.slice(0, nl));
    body = JSON.parse(text.slice(nl + 1));
  } catch {
    return undefined;
  }
  // 309 is a crash; hangs, jetsam and the like have other types.
  if (header.bug_type !== '309') return undefined;
  if (!body.procPath?.includes(`/CoreSimulator/Devices/${udid}/`)) return undefined;
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
  const at = body.captureTime ? Date.parse(body.captureTime.replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
  return {at: Number.isFinite(at) ? at : fallbackAt, kind: 'crash', summary: summary || 'crash', lines: frames.slice(0, 15).map(frame)};
};

export class AppleCrashWatcher {
  readonly #driver: AppleDriver;
  readonly #udid: string;
  readonly #bundleId?: string;
  readonly #dir: string;
  /** Whether the app ran when the current action began. */
  #wasRunning?: Promise<boolean>;
  readonly #seen = new Map<string, AppEvent | undefined>();

  constructor(driver: AppleDriver, udid: string, bundleId?: string, dir = reportsDir()) {
    this.#driver = driver;
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

  async #running(): Promise<boolean> {
    if (!this.#bundleId) return false;
    const r = await this.#driver.simctl(['spawn', this.#udid, 'launchctl', 'list'], {timeoutMs: 10_000});
    return r.stdout.split('\n').some(l => l.includes(`UIKitApplication:${this.#bundleId}[`) && /^\d+\s/.test(l));
  }

  #scan(since: number): AppEvent[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.#dir).filter(n => n.endsWith('.ips'));
    } catch {
      return [];
    }
    const out: AppEvent[] = [];
    for (const name of names) {
      const file = path.join(this.#dir, name);
      let mtime: number;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < since - 1000) continue;
      if (!this.#seen.has(file)) {
        let event: AppEvent | undefined;
        try {
          event = parseIps(fs.readFileSync(file, 'utf8'), this.#bundleId, this.#udid, mtime);
        } catch {
          event = undefined;
        }
        this.#seen.set(file, event);
      }
      const e = this.#seen.get(file);
      // The capture time comes after the crash: a small margin, or the last action's crash leaks into the next.
      if (e && e.at >= since - 300) out.push(e);
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

  /** How many reports of one app macOS writes a day; past that its crashes leave none. */
  static dailyReports = 25;

  /** The app's reports from today, by the header line of each. */
  #reportsToday(): number {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let n = 0;
    try {
      for (const name of fs.readdirSync(this.#dir)) {
        if (!name.endsWith('.ips') || !name.includes(`-${today}-`)) continue;
        try {
          const head = JSON.parse(fs.readFileSync(path.join(this.#dir, name), 'utf8').split('\n', 1)[0]!) as {bundleID?: string; timestamp?: string};
          if (head.bundleID === this.#bundleId && head.timestamp?.startsWith(today)) n++;
        } catch {}
      }
    } catch {}
    return n;
  }

  async since(since: number, after?: string[], final = false): Promise<AppEvent[]> {
    let found = this.#scan(since);
    const was = await this.#wasRunning;
    this.#wasRunning = undefined;
    if (found.length || !(was || final)) return found;
    this.#slow ??= this.#driver.simulators().then(sims => sims.find(s => s.udid === this.#udid)?.kind === 'xr').catch(() => false);
    const slow = await this.#slow;
    const gone = (slow && !!after && !!this.#bundleId && !after.includes(this.#bundleId)) || !(await this.#running().catch(() => true));
    // The app died during the action and its report is not written yet: it takes the reporter a few seconds.
    if (gone) {
      const deadline = Date.now() + (slow || final ? AppleCrashWatcher.waitMs.long : AppleCrashWatcher.waitMs.quick);
      while (!found.length && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 400));
        found = this.#scan(since);
      }
      if (!found.length) {
        const kept = this.#reportsToday();
        const why = kept >= AppleCrashWatcher.dailyReports ? `no crash report: macOS keeps ${AppleCrashWatcher.dailyReports} a day per app and has ${kept} of it today; remove old ones from ${this.#dir}` : 'no crash report yet';
        found = [{at: Date.now(), kind: 'crash', summary: `${this.#bundleId} stopped running during the action (${why})`, lines: []}];
      }
    }
    return found;
  }
}
