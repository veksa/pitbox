// A slim emulator: the background apps of a Google image that an app under test does not need are disabled, so the
// guest keeps fewer processes alive (less RAM on the host, less CPU while idle, less swapping inside the guest).
// Disabling an app persists in the AVD's data, so it is done once per AVD: later boots find the apps already off.
// What pitbox disabled is written down on the device (`SLIM_RECORD`): a stock boot enables exactly those again and
// never touches an app the user disabled by hand. A wiped AVD forgets both.

/** Background apps of Google's phone images that apps under test do not reach. Play services, the Play Store, the
 *  launcher, the keyboard, Chrome, WebView, the camera, contacts and the dialer stay. */
export const SLIM_PACKAGES = [
  'com.google.android.apps.youtube.music',
  'com.google.android.youtube',
  'com.google.android.apps.docs',
  'com.google.android.apps.photos',
  'com.google.android.apps.maps',
  'com.google.android.gm',
  'com.google.android.calendar',
  'com.google.android.apps.messaging',
  'com.google.android.apps.wellbeing',
  'com.google.android.googlequicksearchbox',
  'com.google.android.projection.gearhead',
  'com.google.android.apps.restore',
  'com.google.android.partnersetup',
  'com.google.android.marvin.talkback',
  'com.google.android.accessibility.switchaccess',
  'com.google.android.apps.accessibility.voiceaccess',
  'com.google.android.as',
  'com.google.android.as.oss',
  'com.google.android.apps.safetyhub',
  'com.google.android.healthconnect.controller',
  'com.google.android.feedback',
  'com.google.android.deskclock',
  'com.android.traceur',
  'com.android.devicediagnostics',
  'com.google.android.federatedcompute',
  'com.google.android.ondevicepersonalization.services',
];

/** Packages pitbox disabled on this device, one per line; gone with a wipe. */
export const SLIM_RECORD = '/data/local/tmp/pitbox-slim';

export type SlimOptions = {keep?: string[]; disable?: string[]};

/** What a slim boot disables: the default list and `disable`, less `keep`. */
export const slimList = (opts: SlimOptions = {}): string[] => {
  const keep = new Set(opts.keep ?? []);
  return [...new Set([...SLIM_PACKAGES, ...(opts.disable ?? [])])].filter(p => !keep.has(p));
};

/** `pm list packages` output as names. */
export const packageNames = (out: string): string[] =>
  out
    .split('\n')
    .map(l => /^package:(\S+)/.exec(l.trim())?.[1])
    .filter((p): p is string => !!p);

const PKG = /^[A-Za-z][\w.]*$/;

/** A package name safe to put into the device's shell. */
const valid = (p: string) => PKG.test(p);

type Shell = (command: string, timeoutMs?: number) => Promise<string>;

export type SlimResult = {
  /** Packages disabled now. */
  disabled: string[];
  /** Of the list, those already off (by an earlier slim boot or by hand). */
  already: number;
  /** Packages in the list that refused to be disabled (`pm` said no). */
  failed: string[];
  /** Packages pitbox enabled again because the list no longer names them (`keep` grew). */
  enabled: string[];
};

/**
 * Disables the list's packages that are installed and on, and enables again those pitbox disabled earlier that the
 * list no longer names. Two shell calls when nothing changes.
 */
export const slim = async (shell: Shell, opts: SlimOptions = {}): Promise<SlimResult> => {
  const want = slimList(opts).filter(valid);
  const [enabledOut, disabledOut, recordOut] = (await shell(`pm list packages -e; echo ---; pm list packages -d; echo ---; cat ${SLIM_RECORD} 2>/dev/null; true`, 30_000)).split('---\n');
  const on = new Set(packageNames(enabledOut ?? ''));
  const off = new Set(packageNames(disabledOut ?? ''));
  const record = new Set((recordOut ?? '').split('\n').map(s => s.trim()).filter(valid));
  const todo = want.filter(p => on.has(p));
  const back = [...record].filter(p => !want.includes(p));
  const result: SlimResult = {disabled: [], already: want.filter(p => off.has(p)).length, failed: [], enabled: []};
  if (!todo.length && !back.length) return result;
  // One call: each package answers `+name` when off, `-name` when pm refused; the record gains only what went off.
  const script = [
    ...todo.map(p => `if pm disable-user --user 0 ${p} 2>&1 | grep -q 'new state: disabled'; then echo +${p}; echo ${p} >> ${SLIM_RECORD}; else echo -${p}; fi`),
    ...back.map(p => `pm enable --user 0 ${p} >/dev/null 2>&1 && echo =${p}`),
    ...(back.length ? [`grep -v -x ${back.map(p => `-e ${p}`).join(' ')} ${SLIM_RECORD} > ${SLIM_RECORD}.new; mv ${SLIM_RECORD}.new ${SLIM_RECORD}`] : []),
  ].join('; ');
  const out = await shell(script, 120_000);
  for (const line of out.split('\n')) {
    const p = line.slice(1).trim();
    if (line.startsWith('+')) result.disabled.push(p);
    else if (line.startsWith('-')) result.failed.push(p);
    else if (line.startsWith('=')) result.enabled.push(p);
  }
  return result;
};

/** Enables again every package pitbox disabled on the device and forgets the record. */
export const unslim = async (shell: Shell): Promise<string[]> => {
  const record = (await shell(`cat ${SLIM_RECORD} 2>/dev/null; true`)).split('\n').map(s => s.trim()).filter(valid);
  if (!record.length) return [];
  const out = await shell(`${record.map(p => `pm enable --user 0 ${p} >/dev/null 2>&1 && echo ${p}`).join('; ')}; rm -f ${SLIM_RECORD}`, 120_000);
  return out.split('\n').map(s => s.trim()).filter(valid);
};

/** Packages pitbox disabled on the device (empty: a stock device, or one slimmed by another tool). */
export const slimmed = async (shell: Shell): Promise<string[]> =>
  (await shell(`cat ${SLIM_RECORD} 2>/dev/null; true`).catch(() => '')).split('\n').map(s => s.trim()).filter(valid);

/** One line for a boot's answer. */
export const describeSlim = (r: SlimResult): string => {
  const off = r.disabled.length + r.already;
  const parts = [`${off} background apps off${r.disabled.length ? ` (${r.disabled.length} now)` : ''}`];
  if (r.enabled.length) parts.push(`${r.enabled.length} on again (kept)`);
  if (r.failed.length) parts.push(`not disabled: ${r.failed.join(', ')}`);
  return parts.join('; ');
};
