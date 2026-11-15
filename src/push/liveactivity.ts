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

/** The command the hook takes (in/<id>.json): the push, with the activity it is for resolved by pitbox. */
export type LiveActivityCommand = LiveActivityPush & {id: string; activityId?: string};

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
export const tokenIn = (state: LiveActivityState, token: string) => state.tokens.find(t => t.token.toLowerCase() === token.toLowerCase());

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Hands a command to the hook and waits for its answer. A start is an `Activity.request`, which only an app in front
 * may make: the app is launched (brought to the front) first. An update or an end goes to the running app; when no
 * answer comes in `waitMs` (the app is suspended in the background), the app is brought to the front, where the hook
 * drains its folder. `launched` says whether pitbox had to.
 */
export const deliverLiveActivity = async (
  host: LiveActivityHost,
  udid: string,
  bundleId: string,
  cmd: LiveActivityCommand,
  opts: {waitMs?: number; afterLaunchMs?: number} = {},
): Promise<{outcome?: LiveActivityOutcome; launched: boolean}> => {
  const dir = liveActivityDir(await host.container(udid, bundleId));
  const inbox = path.join(dir, 'in');
  const outFile = path.join(dir, 'out', `${cmd.id}.json`);
  fs.mkdirSync(inbox, {recursive: true});
  // Written aside and renamed in: the hook never reads half a command.
  const tmp = path.join(dir, `.${cmd.id}.json`);
  fs.writeFileSync(tmp, JSON.stringify(cmd));
  fs.renameSync(tmp, path.join(inbox, `${cmd.id}.json`));
  const answer = async (ms: number) => {
    for (const end = Date.now() + ms; ; ) {
      try {
        const o = JSON.parse(fs.readFileSync(outFile, 'utf8')) as LiveActivityOutcome;
        fs.rmSync(outFile, {force: true});
        return o;
      } catch {
        if (Date.now() >= end) return undefined;
        await sleep(150);
      }
    }
  };
  let launched = false;
  if (cmd.event === 'start') {
    await host.launch(udid, bundleId);
    launched = true;
  }
  await host.notify(udid, liveActivityNotification(bundleId));
  let outcome = await answer(opts.waitMs ?? 2000);
  if (!outcome && !launched) {
    await host.launch(udid, bundleId);
    launched = true;
    await host.notify(udid, liveActivityNotification(bundleId)).catch(() => undefined);
    outcome = await answer(opts.afterLaunchMs ?? 4000);
  }
  if (!outcome) fs.rmSync(path.join(inbox, `${cmd.id}.json`), {force: true});
  return {outcome, launched};
};

/** A token shortened for an answer: its first and last characters. */
export const shortToken = (t: string) => (t.length > 16 ? `${t.slice(0, 8)}…${t.slice(-4)}` : t);
