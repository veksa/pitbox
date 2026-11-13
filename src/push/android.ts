// Push on an Android device: the message goes to the app's own FirebaseMessagingService through the connect
// library's debug-only receiver (PitboxPushReceiver), and the verdict comes from what the system shows —
// `dumpsys notification` for the app's posted notifications, and whether the app is in front.

import type {AndroidDriver} from '../drivers/android/driver.ts';

export const PUSH_RECEIVER = 'dev.pitbox.connect.PitboxPushReceiver';

/**
 * Every function here puts the package into an `adb shell` command line: a package name and nothing else may
 * pass (a name from the stand's gateway comes from whatever sent the request).
 */
export const assertPackage = (pkg: string): string => {
  if (!/^[A-Za-z]\w*(\.\w+)+$/.test(pkg)) throw new Error(`not an Android package name: ${JSON.stringify(pkg)}`);
  return pkg;
};

/** A notification the app has posted, as `dumpsys notification --noredact` lists it. */
export type PostedNotification = {key: string; pkg: string; id: number; tag?: string; channel: string; importance: number; title?: string; text?: string; updated: number; summary: boolean};

const value = (line: string): string => {
  // `android.title=String (Hello)`, `android.text=SpannableString (Hi)`: the value is inside the parentheses.
  const m = /^[\w.]+=\w+ \((.*)\)\s*$/.exec(line.trim());
  return m ? m[1]! : line.slice(line.indexOf('=') + 1).trim();
};

/** The posted notifications of `pkg` (all packages without it), from `dumpsys notification --noredact`. */
export const parseNotifications = (dump: string, pkg?: string): PostedNotification[] => {
  const lines = dump.replace(/\r/g, '').split('\n');
  const start = lines.findIndex(l => /^\s{2}Notification List:/.test(l));
  if (start < 0) return [];
  const out: PostedNotification[] = [];
  let cur: PostedNotification | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // The next section of the dump ("  Notification attention state:", "  Snoozed notifications:", …).
    if (/^\s{2}\S.*:\s*$/.test(line)) break;
    const head = /NotificationRecord\(0x[0-9a-f]+: pkg=(\S+) user=\S+ id=(-?\d+) tag=(.*?) importance=(-?\d+) key=(\S+): Notification\(channel=(\S+).*?flags=(\S+)/.exec(line);
    if (head) {
      cur = undefined;
      if (pkg && head[1] !== pkg) continue;
      cur = {key: head[5]!, pkg: head[1]!, id: Number(head[2]), tag: head[3] === 'null' ? undefined : head[3], channel: head[6]!, importance: Number(head[4]), updated: 0, summary: /GROUP_SUMMARY/.test(head[7]!)};
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    if (t.startsWith('android.title=') && cur.title === undefined) cur.title = value(t);
    else if (t.startsWith('android.text=') && cur.text === undefined) cur.text = value(t);
    else if (t.startsWith('mUpdateTimeMs=')) cur.updated = Number(t.slice('mUpdateTimeMs='.length)) || 0;
  }
  return out;
};

/** The broadcast's answer as `am broadcast` prints it: `Broadcast completed: result=1, data="ok …"`. */
export const parseBroadcast = (out: string): {code: number; data?: string} => {
  const m = /Broadcast completed: result=(-?\d+)(?:, data="([\s\S]*?)")?\s*$/m.exec(out);
  return m ? {code: Number(m[1]), data: m[2]} : {code: -1};
};

export type AppState = 'foreground' | 'background' | 'not running';

/** Where the app is, whether it was force-stopped (real FCM does not deliver to a stopped app), and the package in front. */
export const appState = async (a: AndroidDriver, serial: string, pkg: string): Promise<{state: AppState; stopped: boolean; front?: string}> => {
  assertPackage(pkg);
  const out = await a.shell(serial, `pidof ${pkg}; echo ---; dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity' | head -2; echo ---; dumpsys package ${pkg} | grep -m1 -o 'stopped=[a-z]*'`).catch(() => '');
  const [pid = '', resumed = '', stopped = ''] = out.split('---\n');
  const state: AppState = resumed.includes(`${pkg}/`) ? 'foreground' : /^\d+/.test(pid.trim()) ? 'background' : 'not running';
  const front = /\bu\d+ ([\w.]+)\//.exec(resumed)?.[1];
  return {state, stopped: /stopped=true/.test(stopped), front};
};

/** The home screen's package, so a tap that only closed the shade is not taken for one that opened another app. */
export const homePackage = async (a: AndroidDriver, serial: string): Promise<string | undefined> => {
  const out = await a.shell(serial, 'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME').catch(() => '');
  return /^([\w.]+)\//m.exec(out)?.[1];
};

/** The posted notifications of `pkg`, or of every package without it. */
export const notifications = async (a: AndroidDriver, serial: string, pkg?: string): Promise<PostedNotification[]> =>
  parseNotifications(await a.shell(serial, 'dumpsys notification --noredact', 15_000), pkg);

/** Whether the app may post notifications: the runtime permission (Android 13+) and the user's switch. */
export const notificationsAllowed = async (a: AndroidDriver, serial: string, pkg: string): Promise<{allowed: boolean; reason?: string}> => {
  assertPackage(pkg);
  const out = await a.shell(serial, `dumpsys package ${pkg} | grep -m1 'android.permission.POST_NOTIFICATIONS: granted='; cmd appops get ${pkg} POST_NOTIFICATION 2>/dev/null; getprop ro.build.version.sdk`).catch(() => '');
  const sdk = Number(out.trim().split('\n').pop());
  if (sdk >= 33 && /POST_NOTIFICATIONS: granted=false/.test(out)) return {allowed: false, reason: 'POST_NOTIFICATIONS not granted'};
  if (/POST_NOTIFICATION: (ignore|deny)/.test(out)) return {allowed: false, reason: 'notifications switched off for the app'};
  return {allowed: true};
};

export const grantNotifications = async (a: AndroidDriver, serial: string, pkg: string): Promise<string> => {
  assertPackage(pkg);
  const sdk = Number((await a.shell(serial, 'getprop ro.build.version.sdk')).trim());
  if (sdk < 33) {
    await a.shell(serial, `cmd appops set ${pkg} POST_NOTIFICATION allow`).catch(() => '');
    return 'notifications allowed (no runtime permission before Android 13)';
  }
  const out = await a.shell(serial, `pm grant ${pkg} android.permission.POST_NOTIFICATIONS 2>&1`);
  if (/Exception|not a changeable|has not requested/i.test(out)) throw new Error(`could not grant POST_NOTIFICATIONS to ${pkg}: ${out.trim().split('\n')[0]}`);
  return 'granted POST_NOTIFICATIONS';
};

const base64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/**
 * Calls the app's receiver. The app goes on the temporary power allowlist first, as Play services puts it for a
 * high-priority message: Android 8+ refuses a background app's service start otherwise. The broadcast includes
 * stopped packages, so an app force-stopped by `app stop` still gets it (real FCM would not wake it; see docs).
 */
export const callReceiver = async (a: AndroidDriver, serial: string, pkg: string, op: 'deliver' | 'probe' | 'clear', payload?: Record<string, string>): Promise<{code: number; data?: string}> => {
  assertPackage(pkg);
  const extras = [`--es op ${op}`, payload ? `--es payload ${base64(JSON.stringify(payload))}` : ''].filter(Boolean).join(' ');
  // 0x10000020: FLAG_RECEIVER_FOREGROUND | FLAG_INCLUDE_STOPPED_PACKAGES.
  const cmd = `cmd deviceidle tempwhitelist -d 20000 ${pkg} >/dev/null 2>&1; am broadcast -f 0x10000020 -n ${pkg}/${PUSH_RECEIVER} ${extras}`;
  return parseBroadcast(await a.shell(serial, cmd, 20_000));
};

/** Why a receiver call came back empty: no app, or an app built without the push receiver. */
export const missingReceiver = async (a: AndroidDriver, serial: string, pkg: string): Promise<string> => {
  assertPackage(pkg);
  const installed = (await a.shell(serial, `pm path ${pkg}`).catch(() => '')).includes('package:');
  if (!installed) return `${pkg} is not installed on ${serial}`;
  return `${pkg} has no pitbox push receiver\nhint: rebuild the debug build with a @veksa/pitbox that has push (the connect library is autolinked into React Native apps; native apps add it with debugImplementation)`;
};

/** The tree shape the device runner answers `tree` with: windows, and nodes with their window, parent and flags. */
type ShadeTree = {windows: {pkg: string}[]; nodes: {p: number; w: number; b: [number, number, number, number]; t?: string; d?: string; f?: string}[]};

type Box = {w: number; b: [number, number, number, number]};

/**
 * A notification in the expanded shade: a clickable row of a System UI window — never the app's own window behind
 * the shade — whose texts include both the notification's title and its text, and the node to tap in it (the
 * title, else the text). The texts come from the app's own posted notification (dumpsys), so a row of another app
 * that shows only the same title is not taken. Undefined when no row shows them.
 */
export const shadeRow = (tree: ShadeTree, n: {title?: string; text?: string}): {text: Box; row: Box} | undefined => {
  const norm = (x?: string) => (x ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const title = norm(n.title);
  const text = norm(n.text);
  if (!title && !text) return undefined;
  const inShade = (i: number) => tree.windows[tree.nodes[i]!.w]?.pkg.startsWith('com.android.systemui') ?? false;
  const kids = new Map<number, number[]>();
  tree.nodes.forEach((x, i) => kids.set(x.p, [...(kids.get(x.p) ?? []), i]));
  const below = (i: number): number[] => {
    const out: number[] = [];
    for (const stack = [...(kids.get(i) ?? [])]; stack.length; ) {
      const j = stack.shift()!;
      out.push(j);
      stack.push(...(kids.get(j) ?? []));
    }
    return out;
  };
  // Innermost rows first: a group's own row holds its children's texts too.
  const rows = tree.nodes
    .map((x, i) => ({x, i}))
    .filter(({x, i}) => inShade(i) && (x.f ?? '').includes('c'))
    .map(({x, i}) => ({x, i, sub: below(i)}))
    .sort((r1, r2) => r1.sub.length - r2.sub.length);
  for (const r of rows) {
    const ids = [r.i, ...r.sub];
    const texts = ids.map(j => norm(tree.nodes[j]!.t ?? tree.nodes[j]!.d));
    const all = texts.join(' \n ');
    if ((title && !all.includes(title)) || (text && !all.includes(text))) continue;
    let k = title ? texts.indexOf(title) : -1;
    if (k < 0) k = texts.findIndex(t => t.includes(title || text));
    const node = tree.nodes[ids[Math.max(0, k)]!]!;
    return {text: {w: node.w, b: node.b}, row: {w: r.x.w, b: r.x.b}};
  }
  return undefined;
};

/** The titles of the notifications the shade shows, for an error that says what was there instead. */
export const shadeTitles = (tree: ShadeTree): string[] =>
  [...new Set(tree.nodes.filter(n => tree.windows[n.w]?.pkg.startsWith('com.android.systemui') && n.t && (n.f ?? '') === '').map(n => n.t!))].slice(0, 8);
