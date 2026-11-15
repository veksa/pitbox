// Live Activities on an iOS simulator: a stand-in for the pushes that start, update and end them. `simctl push` has
// no Live Activity push type, so the system never takes one from outside; instead pitbox hands the push to the app's
// debug-only hook (`PitboxLiveActivity` in the connect library), which calls the same ActivityKit API the system
// would act on — `Activity.request`, `update`, `end` — and answers what happened.
//
//   pitbox → app   a command file in the app's data container (Library/Caches/pitbox/liveactivity/in/<id>.json),
//                  then the Darwin notification `dev.pitbox.liveactivity.<bundle id>` (`notifyutil -p`); the hook
//                  also drains the folder whenever the app becomes active
//   app → pitbox   out/<id>.json with the outcome, and state.json: the registered attribute types, the push tokens
//                  the system gave (push-to-start per type, one per activity) and the activities
//
// The tokens in state.json are what routes a gateway request: the APNs path's device token, or FCM's
// `apns.live_activity_token`, names the activity (or, for a start, the type) on whichever simulator holds it.

import fs from 'node:fs';
import path from 'node:path';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

export const LIVE_ACTIVITY_EVENTS = ['start', 'update', 'end'] as const;
export type LiveActivityEvent = (typeof LIVE_ACTIVITY_EVENTS)[number];

/** A Live Activity push, from its `aps`. Dates are seconds since 1970, as APNs takes them. */
export type LiveActivityPush = {
  event?: string;
  timestamp?: number;
  /** `attributes-type`: the name of the ActivityAttributes struct (a start). */
  type?: string;
  attributes?: Obj;
  /** `content-state`. */
  state?: Obj;
  staleDate?: number;
  dismissalDate?: number;
  relevanceScore?: number;
  alert?: {title?: string; body?: string; sound?: string};
};

const alertText = (v: unknown): string | undefined => (typeof v === 'string' ? v : isObj(v) && typeof v['loc-key'] === 'string' ? v['loc-key'] : undefined);

/** Whether an APNs payload with its headers is a Live Activity push. */
export const isLiveActivity = (payload: Obj | undefined, headers: Record<string, string | undefined> = {}): boolean => {
  if (headers['apns-push-type'] === 'liveactivity' || /\.push-type\.liveactivity$/.test(headers['apns-topic'] ?? '')) return true;
  const aps = isObj(payload?.aps) ? payload.aps : undefined;
  return !!aps && typeof aps.event === 'string' && (LIVE_ACTIVITY_EVENTS as readonly string[]).includes(aps.event) && ('content-state' in aps || aps.event === 'end');
};

/** The Live Activity fields of an APNs payload. */
export const parseLiveActivity = (payload: Obj): LiveActivityPush => {
  const aps = isObj(payload.aps) ? payload.aps : {};
  const alert = isObj(aps.alert) ? aps.alert : undefined;
  const sound = isObj(alert?.sound) ? (alert.sound as Obj).name : alert?.sound ?? aps.sound;
  return {
    event: typeof aps.event === 'string' ? aps.event : undefined,
    timestamp: num(aps.timestamp),
    type: typeof aps['attributes-type'] === 'string' ? aps['attributes-type'] : undefined,
    attributes: isObj(aps.attributes) ? aps.attributes : undefined,
    state: isObj(aps['content-state']) ? aps['content-state'] : undefined,
    staleDate: num(aps['stale-date']),
    dismissalDate: num(aps['dismissal-date']),
    relevanceScore: num(aps['relevance-score']),
    alert: alert ? {title: alertText(alert.title), body: alertText(alert.body), sound: typeof sound === 'string' ? sound : undefined} : undefined,
  };
};

/**
 * Why the system would drop this push, as APNs documents the payload; undefined when it would take it. A dropped push
 * is answered 200 by APNs all the same, so this goes into the verdict, not into the status.
 */
export const liveActivityProblem = (la: LiveActivityPush): string | undefined => {
  if (!la.event) return 'aps.event is missing (start, update or end)';
  if (!(LIVE_ACTIVITY_EVENTS as readonly string[]).includes(la.event)) return `aps.event "${la.event}" is none of start, update, end`;
  if (la.timestamp === undefined) return 'aps.timestamp is missing: the system drops a Live Activity push without one';
  if (la.event !== 'end' && !la.state) return `a ${la.event} needs aps.content-state`;
  if (la.event === 'start' && !la.type) return 'a start needs aps.attributes-type (the ActivityAttributes struct name)';
  if (la.event === 'start' && !la.attributes) return 'a start needs aps.attributes';
  return undefined;
};

/** The APNs payload of a Live Activity push made from `push activity` fields. */
export const toLiveActivityPayload = (la: LiveActivityPush): Obj => {
  const aps: Obj = {event: la.event, timestamp: la.timestamp ?? Math.floor(Date.now() / 1000)};
  if (la.type !== undefined) aps['attributes-type'] = la.type;
  if (la.attributes !== undefined) aps.attributes = la.attributes;
  if (la.state !== undefined) aps['content-state'] = la.state;
  if (la.staleDate !== undefined) aps['stale-date'] = la.staleDate;
  if (la.dismissalDate !== undefined) aps['dismissal-date'] = la.dismissalDate;
  if (la.relevanceScore !== undefined) aps['relevance-score'] = la.relevanceScore;
  if (la.alert) aps.alert = Object.fromEntries(Object.entries(la.alert).filter(([, v]) => v !== undefined));
  return {aps};
};

/** What the app's hook reports about itself (state.json). */
export type LiveActivityState = {
  version: number;
  /** ActivityAttributes types registered with the hook, by the name a push names them with. */
  types: string[];
  tokens: {token: string; kind: 'start' | 'activity'; type: string; activityId?: string; synthetic?: boolean}[];
  activities: {id: string; type: string; state: string}[];
};

/**
 * The command the hook takes (in/<id>.json): the push, with the activity it is for resolved by pitbox. `deadline`
 * (seconds since 1970): the hook does not apply a command it takes later — a pitbox that died never sees the answer.
 */
export type LiveActivityCommand = LiveActivityPush & {id: string; activityId?: string; deadline?: number};

/** The hook's answer (out/<id>.json). */
export type LiveActivityOutcome = {ok: boolean; activityId?: string; token?: string; synthetic?: boolean; error?: string; note?: string};

/** What delivering needs of the simulator; the engine gives the local Apple driver's. */
export type LiveActivityHost = {
  container: (udid: string, bundleId: string) => Promise<string>;
  notify: (udid: string, name: string) => Promise<void>;
  launch: (udid: string, bundleId: string) => Promise<void>;
  /** Whether the installed app carries the aps-environment entitlement (undefined: cannot tell). */
  apsEnvironment?: (udid: string, bundleId: string) => Promise<boolean | undefined>;
};

export const liveActivityDir = (container: string) => path.join(container, 'Library', 'Caches', 'pitbox', 'liveactivity');
export const liveActivityNotification = (bundleId: string) => `dev.pitbox.liveactivity.${bundleId}`;

/** The hook's state for an app on a simulator; undefined when the app has no hook (or is not installed). */
export const readLiveActivityState = async (host: LiveActivityHost, udid: string, bundleId: string): Promise<LiveActivityState | undefined> => {
  let dir: string;
  try {
    dir = liveActivityDir(await host.container(udid, bundleId));
  } catch {
    return undefined;
  }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as Partial<LiveActivityState>;
    return {version: Number(s.version ?? 1), types: Array.isArray(s.types) ? s.types : [], tokens: Array.isArray(s.tokens) ? s.tokens : [], activities: Array.isArray(s.activities) ? s.activities : []};
  } catch {
    return undefined;
  }
};

/** Which activity (or, for a start, which type) a token names in a state; undefined when it names none. */
/**
 * The entry a token names. The system may hand one push-to-start token to several attribute types, so a push that
 * says what it wants (`kind`, `type`) takes the entry that matches it, and only then the first with the token.
 */
export const tokenIn = (state: LiveActivityState, token: string, want?: {kind?: string; type?: string}) => {
  const all = state.tokens.filter(t => t.token.toLowerCase() === token.toLowerCase());
  return (want && all.find(t => (!want.kind || t.kind === want.kind) && (!want.type || t.type === want.type))) ?? all[0];
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** An answer older than this in out/ is one nobody waited for any more: removed on the next delivery. */
export const STALE_ANSWER_MS = 60_000;

/**
 * Hands a command to the hook and waits for its answer. A start is an `Activity.request`, which only an app in front
 * may make: the app is launched (brought to the front) first. An update or an end goes to the running app; when no
 * answer comes in `waitMs` (the app is suspended in the background), the app is brought to the front, where the hook
 * drains its folder. `launched` says whether pitbox had to.
 *
 * Giving up is a claim on the command file: pitbox and the hook both take it by deleting it, and only one delete
 * succeeds. When pitbox's succeeds, the hook never sees the command, so a push answered as failed is never applied
 * later. When the hook took it first, the command is running (a start waits up to 3 s for its token): pitbox waits
 * `takenMs` more for the answer.
 */
export const deliverLiveActivity = (
  host: LiveActivityHost,
  udid: string,
  bundleId: string,
  cmd: LiveActivityCommand,
  opts: {waitMs?: number; afterLaunchMs?: number; takenMs?: number} = {},
): Promise<{outcome?: LiveActivityOutcome; launched: boolean}> =>
  deliverToHook<LiveActivityOutcome>(host, udid, bundleId, {dir: liveActivityDir, notice: liveActivityNotification(bundleId), launchFirst: cmd.event === 'start'}, cmd, opts);

/**
 * The exchange with one of the app's debug hooks (Live Activities, notification responses): the command into the
 * hook's in/, its Darwin notification, the answer from out/. `launchFirst` brings the app to the front before (an
 * `Activity.request` needs it); otherwise a command nobody took in `waitMs` (the app suspended or not running)
 * launches the app, where the hook drains its folder.
 */
export const deliverToHook = async <O>(
  host: LiveActivityHost,
  udid: string,
  bundleId: string,
  where: {dir: (container: string) => string; notice: string; launchFirst?: boolean},
  cmd: {id: string} & Obj,
  opts: {waitMs?: number; afterLaunchMs?: number; takenMs?: number} = {},
): Promise<{outcome?: O; launched: boolean}> => {
  const dir = where.dir(await host.container(udid, bundleId));
  const inbox = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  const inFile = path.join(inbox, `${cmd.id}.json`);
  const outFile = path.join(outDir, `${cmd.id}.json`);
  fs.mkdirSync(inbox, {recursive: true});
  // Answers to commands pitbox gave up on, written after it stopped waiting.
  for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) {
    const file = path.join(outDir, f);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > STALE_ANSWER_MS) fs.rmSync(file, {force: true});
    } catch {
      // gone meanwhile
    }
  }
  // A safety net for a pitbox that dies while waiting; the claim below is what normally ends a command.
  const deadline = Math.ceil((Date.now() + STALE_ANSWER_MS) / 1000);
  // Written aside and renamed in: the hook never reads half a command.
  const tmp = path.join(dir, `.${cmd.id}.json`);
  fs.writeFileSync(tmp, JSON.stringify({...cmd, deadline}));
  fs.renameSync(tmp, inFile);
  const answer = async (ms: number) => {
    for (const end = Date.now() + ms; ; ) {
      try {
        const o = JSON.parse(fs.readFileSync(outFile, 'utf8')) as O;
        fs.rmSync(outFile, {force: true});
        return o;
      } catch {
        if (Date.now() >= end) return undefined;
        await sleep(150);
      }
    }
  };
  let launched = false;
  if (where.launchFirst) {
    await host.launch(udid, bundleId);
    launched = true;
  }
  await host.notify(udid, where.notice);
  let outcome = await answer(opts.waitMs ?? 2000);
  if (!outcome && !launched && fs.existsSync(inFile)) {
    await host.launch(udid, bundleId);
    launched = true;
    await host.notify(udid, where.notice).catch(() => undefined);
    outcome = await answer(opts.afterLaunchMs ?? 4000);
  }
  if (!outcome) {
    let claimed = false;
    try {
      fs.unlinkSync(inFile);
      claimed = true;
    } catch {
      // The hook took it: it is running.
    }
    if (!claimed) outcome = await answer(opts.takenMs ?? 10_000);
  }
  return {outcome, launched};
};

/** A token shortened for an answer: its first and last characters. */
export const shortToken = (t: string) => (t.length > 16 ? `${t.slice(0, 8)}…${t.slice(-4)}` : t);
