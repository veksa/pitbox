// A slim iOS simulator: launchd daemons an app under test does not need (Siri and Apple Intelligence, Spotlight,
// Mail, Screen Time, News, Weather, Home, lock screen posters…) are disabled before it boots, so it comes up with
// about half the processes, under half the memory and almost no CPU while idle.
//
// launchd_sim reads its disable overrides at start from a file on the Mac, keyed by the simulator's udid (not in the
// device's data, so an erase keeps them). Written while the simulator is shut down, they take effect with no extra
// boot. Runtimes before iOS 18.5 do not keep them, so slimming starts there. What pitbox changed is written down next
// to the file with each label's earlier value: a stock boot puts exactly those back.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Daemons a slim simulator runs without. Kept on purpose: SpringBoard and the keyboard, notifications and push,
 *  widgets and Live Activities (chronod, liveactivitiesd), location, privacy prompts (tccd), the photo library,
 *  accessibility (the UI test runner reads through it), universal links, keychain, contacts, calendars and
 *  reminders, HealthKit, Wallet and the App Store (StoreKit). */
export const SIM_SLIM_LABELS = [
  // lock screen posters
  'com.apple.PosterBoard',
  // Siri, speech and Apple Intelligence
  'com.apple.assistantd',
  'com.apple.assistant_service',
  'com.apple.assistant_cdmd',
  'com.apple.siriactionsd',
  'com.apple.siriinferenced',
  'com.apple.siriknowledged',
  'com.apple.siri.context.service',
  'com.apple.sirittsd',
  'com.apple.corespeechd',
  'com.apple.intelligenceflowd',
  'com.apple.intelligencecontextd',
  'com.apple.intelligenceplatformd',
  'com.apple.generativeexperiencesd',
  'com.apple.suggestd',
  'com.apple.routined',
  // Spotlight
  'com.apple.searchd',
  'com.apple.spotlightknowledged.updater',
  // Mail and account sync
  'com.apple.email.maild',
  'com.apple.icloudmailagent',
  'com.apple.dataaccess.dataaccessd',
  // Screen Time and Family
  'com.apple.ScreenTimeAgent',
  'com.apple.ScreenTimeSettingsAgent',
  'com.apple.FamilyControlsAgent',
  'com.apple.familycircled',
  'com.apple.UsageTrackingAgent',
  'com.apple.dmd',
  // Health app, Home and Fitness (HealthKit's healthd stays)
  'com.apple.healthappd',
  'com.apple.homed',
  'com.apple.homeeventsd',
  'com.apple.fitnesscoachingd',
  'com.apple.activitysharingd',
  'com.apple.fitcore',
  // News, Weather, Maps sync, Game Center, Finance, Shared with You, App Store engagement
  'com.apple.newsd',
  'com.apple.weatherd',
  'com.apple.gamed',
  'com.apple.Maps.mapssyncd',
  'com.apple.financed',
  'com.apple.sociallayerd',
  'com.apple.amsengagementd',
  'com.apple.jetpackassetd',
  'com.apple.itunescloudd',
  // Continuity, CarPlay
  'com.apple.rapportd',
  'com.apple.carkitd',
  // ads, experiments, diagnostics, photo analysis, Safari bookmark sync
  'com.apple.ap.adprivacyd',
  'com.apple.triald',
  'com.apple.diagnosticextensionsd',
  'com.apple.photoanalysisd',
  'com.apple.SafariBookmarksSyncAgent',
];

export type SimSlimOptions = {keep?: string[]; disable?: string[]};

/** What a slim boot disables: the default list and `disable`, less `keep`. */
export const simSlimList = (opts: SimSlimOptions = {}): string[] => {
  const keep = new Set(opts.keep ?? []);
  return [...new Set([...SIM_SLIM_LABELS, ...(opts.disable ?? [])])].filter(l => !keep.has(l) && /^[\w.-]+$/.test(l));
};

/** Whether a runtime keeps launchd overrides across boots: iOS 18.5 and later (`com.apple.CoreSimulator.SimRuntime.iOS-18-5`). */
export const keepsOverrides = (runtime: string): boolean => {
  const m = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 18 || (major === 18 && minor >= 5);
};

/** The Mac-side folder of a simulator's launchd: its log and its disable overrides. */
export const storeDir = (udid: string, root = '/private/var/tmp') => path.join(root, `com.apple.CoreSimulator.SimDevice.${udid}`);

const STORE = 'disabled.plist';
const RECORD = 'pitbox-slim.json';

/** Label → disabled, from launchd_sim's XML plist (a flat dict of booleans). */
export const parseStore = (xml: string): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  for (const m of xml.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/g)) out[m[1]!] = m[2] === 'true';
  return out;
};

/** The store in the shape launchd_sim writes it, sorted so an unchanged store is the same file. */
export const encodeStore = (entries: Record<string, boolean>): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n<dict>\n' +
  Object.keys(entries)
    .sort()
    .map(k => `\t<key>${k}</key>\n\t<${entries[k] ? 'true' : 'false'}/>\n`)
    .join('') +
  '</dict>\n</plist>\n';

/** A binary plist (written by another tool) as XML; undefined when it cannot be read. */
const readStore = (file: string): Record<string, boolean> | undefined => {
  if (!fs.existsSync(file)) return {};
  let text = fs.readFileSync(file, 'utf8');
  if (!text.startsWith('<?xml')) {
    try {
      text = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', file], {encoding: 'utf8'});
    } catch {
      return undefined;
    }
  }
  return parseStore(text);
};

/** Written whole or not at all: launchd_sim never reads a half-written store. */
const writeAtomic = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.pitbox-${process.pid}`;
  fs.writeFileSync(tmp, text, {mode: 0o644});
  fs.renameSync(tmp, file);
};

/** Labels pitbox disabled, with the value each had before (`null`: no entry). */
type Record_ = Record<string, boolean | null>;

const readRecord = (dir: string): Record_ => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8')) as Record_;
  } catch {
    return {};
  }
};

export type SimSlimResult = {disabled: number; changed: number; restored: number; error?: string};

/**
 * Brings a shut-down simulator's overrides to the slim list: disables the list's labels and puts back the earlier
 * value of labels pitbox disabled that the list no longer names. Labels pitbox did not disable are never touched.
 */
export const slimSimulator = (udid: string, opts: SimSlimOptions = {}, root?: string): SimSlimResult => {
  const dir = storeDir(udid, root);
  const file = path.join(dir, STORE);
  const store = readStore(file);
  if (!store) return {disabled: 0, changed: 0, restored: 0, error: `cannot read ${file}`};
  const record = readRecord(dir);
  const want = simSlimList(opts);
  let changed = 0;
  let restored = 0;
  for (const label of want) {
    if (store[label] === true) continue;
    if (!(label in record)) record[label] = label in store ? store[label]! : null;
    store[label] = true;
    changed++;
  }
  for (const label of Object.keys(record)) {
    if (want.includes(label)) continue;
    const before = record[label];
    if (before === null || before === undefined) delete store[label];
    else store[label] = before;
    delete record[label];
    restored++;
  }
  if (changed || restored) {
    writeAtomic(file, encodeStore(store));
    writeAtomic(path.join(dir, RECORD), JSON.stringify(record));
  }
  return {disabled: want.length, changed, restored};
};

/** Puts back every override pitbox changed on a shut-down simulator; the number of labels put back. */
export const unslimSimulator = (udid: string, root?: string): number => {
  const dir = storeDir(udid, root);
  const record = readRecord(dir);
  const labels = Object.keys(record);
  if (!labels.length) return 0;
  const file = path.join(dir, STORE);
  const store = readStore(file) ?? {};
  for (const label of labels) {
    const before = record[label];
    if (before === null || before === undefined) delete store[label];
    else store[label] = before;
  }
  writeAtomic(file, encodeStore(store));
  fs.rmSync(path.join(dir, RECORD), {force: true});
  return labels.length;
};

/** Of `labels`, those launchd does not report disabled (`launchctl print-disabled system`). */
export const notDisabled = (printDisabled: string, labels: string[]): string[] => {
  const off = new Set([...printDisabled.matchAll(/"([^"]+)"\s*=>\s*(?:true|disabled)/g)].map(m => m[1]!));
  return labels.filter(l => !off.has(l));
};
