// `push`: one command for both platforms. A message (simple fields, an APNs payload or an FCM message) goes to
// the app on a simulator through `simctl push`, or to the app on an Android device through its own
// FirebaseMessagingService (the connect library's debug-only receiver), and the answer is a verdict from what the
// system shows instead of a screenshot. The stand's push gateway (gateway.ts) sends through the same path.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {AndroidDriver} from '../drivers/android/driver.ts';
import type {AppleDevices} from '../remote/appleRemote.ts';
import type {ActResult, DeviceUi} from '../ui/device.ts';
import {appState, assertPackage, callReceiver, grantNotifications, homePackage, missingReceiver, notifications, notificationsAllowed, pickAction, shadeButton, shadeRow, shadeTitles, type AppState, type PostedNotification} from './android.ts';
import {deliverLiveActivity, deliverToHook, isLiveActivity, liveActivityProblem, parseLiveActivity, readLiveActivityState, shortToken, tokenIn, type LiveActivityHost, type LiveActivityPush, type LiveActivityState} from './liveactivity.ts';
import {notificationDir, notificationNotice, type NotificationResponseOutcome} from './respond.ts';
import {describe, fromFirebaseAdmin, toApns, toFcmExtras, toMessage, type PushInput, type PushMessage} from './payload.ts';

/** What a notification's tap must bring to the front: the app, another app (a web page in the browser), or either. */
export const TAP_EXPECT = ['app', 'away', 'any'] as const;
export type TapExpect = (typeof TAP_EXPECT)[number];

export type PushTarget = {platform: 'android'; id: string; a: AndroidDriver} | {platform: 'apple'; id: string; s: AppleDevices};

export type PushDeps = {
  /** The device a call names, or the only one online. */
  target: (device?: string, opts?: {fromGateway?: boolean}) => Promise<PushTarget>;
  /** Devices the gateway may deliver to, by platform (this session's own: never another session's). */
  online: () => Promise<{android: string[]; apple: string[]}>;
  androidApp?: (device?: string) => string | undefined;
  appleApp?: (device?: string) => string | undefined;
  ui: (device: string) => Promise<DeviceUi>;
  /** The device's UI only when its runner already runs: the gateway must not wait minutes for a runner build. */
  liveUi?: (device: string) => DeviceUi | undefined;
  /** Where token bindings are kept across daemon restarts (read on first use: the config may load later). */
  tokenFile?: () => string | undefined;
  /** The simulator side of Live Activities (liveactivity.ts); undefined when the simulators are not on this Mac. */
  liveActivity?: () => LiveActivityHost | undefined;
};

/** The device cannot take pushes for this app at all: not installed, no receiver, no FCM client. */
export class PushUnregistered extends Error {}

export type PushOptions = PushInput & {
  device?: string;
  /** Package or bundle id; default: the config's app. */
  app?: string;
  /** Seconds to wait before sending (the call answers at once). */
  delay?: number | string;
  /** Send this many copies (distinct message ids). */
  repeat?: number | string;
  /** Grant the notification permission first (Android 13+ runtime permission). */
  grant?: boolean | string;
  /** How long to watch for the notification, ms. */
  wait?: number | string;
  /** Sent by the stand's gateway: answer without starting a runner. */
  fromGateway?: boolean;
  /** How the gateway chose the device, when the choice was a guess. */
  routeNote?: string;
  /** A Live Activity push: the token that names its activity (or, for a start, its type) — APNs' device token, FCM's `live_activity_token`. */
  liveActivityToken?: string;
  /** A Live Activity push: the activity it is for, by its id (`push activity id=…`). */
  activityId?: string;
};

export type PushResult = {
  id: string;
  platform: 'android' | 'apple';
  device: string;
  app: string;
  sent: string;
  /** The text a notification for it shows first (its title, or its body), for `push tap`. */
  title?: string;
  /** Where the app was when the message arrived. */
  state?: AppState;
  /** What took the message on the device: the service, other receivers. */
  via?: string;
  /** The notification the system shows for it, when it shows one. */
  shown?: {title?: string; text?: string; channel?: string; importance?: number};
  ok: boolean;
  /**
   * `unregistered`: the device cannot take pushes for the app at all, or no activity has the Live Activity token (the
   * gateway answers as for a dead token); `nohook`: the app has no Live Activity hook to take one.
   */
  reason?: 'unregistered' | 'nohook';
  verdict: string;
  notes?: string[];
  count?: number;
  /** Seconds until a delayed push goes out. */
  scheduled?: number;
  source?: string;
};

export type PushRecord = PushResult & {at: number; token?: string};

const yes = (v: unknown) => v === true || v === 'true' || v === '1';

const obj = (v: unknown): Record<string, unknown> | undefined => {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  try {
    const parsed = JSON.parse(v) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** A Live Activity push in a send's input (an APNs payload with its headers, or an FCM message's apns block), if it is one. */
export const liveActivityOf = (opts: PushOptions): {push: LiveActivityPush; token?: string} | undefined => {
  const apns = obj(opts.apns);
  if (apns) return isLiveActivity(apns, opts.apnsHeaders) ? {push: parseLiveActivity(apns), token: opts.liveActivityToken} : undefined;
  const raw = obj(opts.fcm);
  if (!raw) return undefined;
  const m = fromFirebaseAdmin(obj(raw.message) ?? raw);
  const block = obj(m.apns);
  const payload = obj(block?.payload);
  const headers = (obj(block?.headers) ?? {}) as Record<string, string>;
  const token = typeof block?.live_activity_token === 'string' ? block.live_activity_token : undefined;
  if (!payload || (!token && !isLiveActivity(payload, headers))) return undefined;
  return {push: parseLiveActivity(payload), token: token ?? opts.liveActivityToken};
};

const pastTense = {start: 'started', update: 'updated', end: 'ended'} as Record<string, string>;

/** The platform a placeholder token names (`pitbox-ios-<id>`, `pitbox-android-<id>`), if it is one. */
export const placeholderPlatform = (token: string): 'apple' | 'android' | undefined => {
  const m = /^pitbox-(ios|android)-/.exec(token);
  return m ? (m[1] === 'ios' ? 'apple' : 'android') : undefined;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A notification counts as this push's when it is new or changed since the snapshot before sending. */
const fresh = (before: PostedNotification[], after: PostedNotification[]): PostedNotification | undefined => {
  const was = new Map(before.map(n => [n.key, n.updated]));
  return after.filter(n => !n.summary && (!was.has(n.key) || was.get(n.key) !== n.updated)).sort((a, b) => b.updated - a.updated)[0];
};

export type RespondResult = {device: string; app: string; ok: boolean; verdict: string; notification?: string; /** The action that was answered (iOS: its identifier; Android: its title). */ answered?: string; actions?: string[]; state?: AppState; screen?: string[]; notes?: string[]};

export class PushCenter {
  readonly log: PushRecord[] = [];
  /** Device tokens bound to a device by `push bind` or learned from a gateway request with a device. */
  #tokens?: Map<string, string>;
  readonly #deps: PushDeps;
  readonly #timers = new Set<NodeJS.Timeout>();
  #seq = 0;

  constructor(deps: PushDeps) {
    this.#deps = deps;
  }

  get tokens(): Map<string, string> {
    if (this.#tokens) return this.#tokens;
    this.#tokens = new Map();
    try {
      const file = this.#deps.tokenFile?.();
      if (file && fs.existsSync(file)) {
        for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>)) this.#tokens.set(k, v);
      }
    } catch {
      // a broken file only loses the bindings
    }
    return this.#tokens;
  }

  /** Drops delayed pushes that have not gone out (on `down` and daemon exit). */
  cancelScheduled(): number {
    const n = this.#timers.size;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    return n;
  }

  /**
   * The log after waiting up to `waitMs` for a push recorded after `since` (a scheduled push or a gateway delivery
   * landing in the meantime); answers as soon as one lands. `device` narrows what counts as new.
   */
  async waitLog(opts: {since: number; waitMs: number; device?: string}): Promise<{log: PushRecord[]; arrived: boolean; waitedMs: number}> {
    const isNew = (r: PushRecord) => r.at > opts.since && (!opts.device || r.device === opts.device);
    const start = Date.now();
    const deadline = start + Math.max(0, opts.waitMs);
    while (!this.log.some(isNew) && Date.now() < deadline) await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
    return {log: this.log, arrived: this.log.some(isNew), waitedMs: Date.now() - start};
  }

  #record(r: PushResult, token?: string) {
    this.log.push({...r, at: Date.now(), token});
    if (this.log.length > 50) this.log.shift();
  }

  #app(t: PushTarget, given?: string): string {
    const app = given ?? (t.platform === 'android' ? this.#deps.androidApp?.(t.id) : this.#deps.appleApp?.(t.id));
    if (!app) throw new Error(`no app: pass app=<${t.platform === 'android' ? 'package' : 'bundle id'}> or set app.${t.platform} in the config`);
    // The id ends up in adb shell commands (Android) and simctl arguments: nothing but an id passes.
    if (t.platform === 'android') assertPackage(app);
    else if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app)) throw new Error(`not a bundle id: ${JSON.stringify(app)}`);
    return app;
  }

  #messageId() {
    return `0:${Date.now()}%pitbox${(++this.#seq).toString(16)}${crypto.randomBytes(3).toString('hex')}`;
  }

  /** Sends one push (or schedules it); `source` tells the log where it came from. */
  async send(opts: PushOptions, source = 'push', token?: string): Promise<PushResult> {
    const la = liveActivityOf(opts);
    if (la) {
      const t = await this.#deps.target(opts.device, {fromGateway: opts.fromGateway});
      const r = await this.#activity(t, this.#app(t, opts.app), la, opts);
      const notes = [...(r.notes ?? []), ...(opts.routeNote ? [opts.routeNote] : [])];
      const result = {...r, notes: notes.length ? notes : undefined, source};
      this.#record(result, token);
      return result;
    }
    const msg = toMessage(opts);
    const t = await this.#deps.target(opts.device, {fromGateway: opts.fromGateway});
    const app = this.#app(t, opts.app);
    const delay = Number(opts.delay ?? 0);
    if (!Number.isFinite(delay) || delay < 0 || delay > 3600) throw new Error('delay: seconds, 0 to 3600');
    const repeat = Number(opts.repeat ?? 1);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('repeat: 1 to 20');
    if (delay > 0) {
      const id = this.#messageId();
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        void this.#sendNow(t, app, msg, opts, repeat, source, token).catch(e =>
          this.#record({id, platform: t.platform, device: t.id, app, sent: describe(msg), ok: false, verdict: `delayed push failed: ${(e as Error).message}`, source}, token),
        );
      }, delay * 1000);
      this.#timers.add(timer);
      return {id, platform: t.platform, device: t.id, app, sent: describe(msg), ok: true, verdict: `scheduled in ${delay}s (push log shows how it went)`, scheduled: delay, source};
    }
    return this.#sendNow(t, app, msg, opts, repeat, source, token);
  }

  async #sendNow(t: PushTarget, app: string, msg: PushMessage, opts: PushOptions, repeat: number, source: string, token?: string): Promise<PushResult> {
    let r: PushResult | undefined;
    for (let i = 0; i < repeat; i++) {
      // Only the last copy waits for its notification: the call should not take a wait per copy.
      const o = i < repeat - 1 ? {...opts, wait: 0} : opts;
      r = t.platform === 'android' ? await this.#android(t.a, t.id, app, msg, o) : await this.#apple(t.s, t.id, app, msg, o);
    }
    const notes = [...(r!.notes ?? []), ...(opts.routeNote ? [opts.routeNote] : [])];
    const result = {...r!, notes: notes.length ? notes : undefined, count: repeat > 1 ? repeat : undefined, source};
    this.#record(result, token);
    return result;
  }

  async #android(a: AndroidDriver, serial: string, pkg: string, msg: PushMessage, opts: PushOptions): Promise<PushResult> {
    const notes: string[] = [];
    if (yes(opts.grant)) notes.push(await grantNotifications(a, serial, pkg));
    const [{state, stopped}, before] = await Promise.all([appState(a, serial, pkg), notifications(a, serial, pkg)]);
    // pitbox delivers to a force-stopped app too (a cold start from a push is worth testing); real FCM does not.
    if (stopped) notes.push('the app was force-stopped: real FCM would not deliver to it until it is opened again');
    const id = this.#messageId();
    const r = await callReceiver(a, serial, pkg, 'deliver', toFcmExtras(msg, {messageId: id, pkg}));
    const base = {id, platform: 'android' as const, device: serial, app: pkg, sent: describe(msg), title: msg.title ?? msg.body, state};
    if (r.code !== 1) {
      if (!r.data) throw new PushUnregistered(await missingReceiver(a, serial, pkg));
      return {...base, ok: false, reason: /no-fcm-service/.test(r.data) ? ('unregistered' as const) : undefined, verdict: r.data.replace(/^error /, 'not delivered: '), notes};
    }
    const via = [/service=(\S+)/.exec(r.data ?? '')?.[1], /receivers=(\S+)/.exec(r.data ?? '')?.[1]].filter(Boolean).map(s => s!.split(',').map(x => x.split('.').pop()).join(', ')).join(' + ');
    // Firebase posts the notification itself only when the app is not in front; a data message posts nothing
    // unless the app does. Either way the app gets a moment to post one.
    const waitMs = Number(opts.wait ?? (msg.silent ? 1500 : 3000));
    let shown: PostedNotification | undefined;
    for (const deadline = Date.now() + waitMs; Date.now() < deadline && !shown; ) {
      await sleep(300);
      shown = fresh(before, await notifications(a, serial, pkg));
    }
    if (shown) {
      return {...base, via, ok: true, shown: {title: shown.title, text: shown.text, channel: shown.channel, importance: shown.importance}, verdict: `notification posted${shown.title ? ` "${shown.title}"` : ''}${shown.text ? ` — "${shown.text}"` : ''} · channel ${shown.channel}${shown.importance < 3 ? ` (importance ${shown.importance}: no sound or banner)` : ''}`, notes};
    }
    const allowed = /notifications=false/.test(r.data ?? '') ? {allowed: false, reason: 'notifications are off for the app'} : await notificationsAllowed(a, serial, pkg);
    if (!allowed.allowed && !msg.silent) {
      return {...base, via, ok: false, verdict: `delivered, but no notification: ${allowed.reason}`, notes: [...notes, 'push grant=true (or push action=grant) allows notifications']};
    }
    if (msg.silent) return {...base, via, ok: true, verdict: 'data message delivered (nothing posted, as expected for a data-only message)', notes};
    if (state === 'foreground') return {...base, via, ok: true, verdict: "delivered with the app in front: no notification posted (Firebase leaves it to the app's foreground handler)", notes};
    return {...base, via, ok: true, verdict: `delivered, but no notification posted within ${waitMs / 1000}s — the app counted as in front, or its handler posts none`, notes};
  }

  async #apple(s: AppleDevices, udid: string, bundleId: string, msg: PushMessage, opts: PushOptions): Promise<PushResult> {
    const id = this.#messageId();
    const notes: string[] = [];
    // From the gateway the banner is checked only by a runner that already runs: building one takes minutes,
    // and the server's request would time out waiting.
    const ui = opts.fromGateway ? this.#deps.liveUi?.(udid) : await this.#deps.ui(udid).catch(() => undefined);
    // The shell's banners read once before the push: a first read during the banner's arrival can come back empty.
    if (!msg.silent) await ui?.runner.call('banners').catch(() => undefined);
    if (yes(opts.grant)) notes.push('iOS has no way to grant notifications from outside: allow them in the app\'s prompt (press "Allow")');
    if (msg.collapseId) notes.push('simctl push has no apns-collapse-id: the simulator shows each push on its own');
    if (msg.silent) notes.push('a background push may not wake a suspended app on the simulator');
    if (msg.aps?.['mutable-content'] === 1 || msg.aps?.['mutable-content'] === true) notes.push('the Notification Service Extension does not run for simctl push: the banner shows the payload as sent' + (msg.image ? ', without its image' : ''));
    const base = {id, platform: 'apple' as const, device: udid, app: bundleId, sent: describe(msg), title: msg.title ?? msg.body};
    try {
      await s.push(udid, bundleId, toApns(msg, bundleId, id));
    } catch (e) {
      // UNErrorDomain 2003: the app has no notification permission (never asked, prompt unanswered, or denied).
      if (/code=2003|not authorized/i.test((e as Error).message)) {
        return {...base, ok: false, verdict: 'not delivered: notifications are not allowed for the app — it must ask, and the prompt be answered "Allow"', notes};
      }
      throw e;
    }
    if (msg.silent) return {...base, ok: true, verdict: 'delivered (background push: nothing shown)', notes};
    const title = msg.title ?? msg.body;
    if (!ui) return {...base, ok: true, verdict: 'delivered (banner not checked: no runner on this simulator yet)', notes};
    const banner = title ? await this.#banner(ui, title, Number(opts.wait ?? 3000)) : undefined;
    const state = (front?: string): AppState | undefined => (front === undefined ? undefined : front === bundleId ? 'foreground' : 'background');
    if (banner?.seen) return {...base, ok: true, state: state(banner.front), shown: {title: msg.title, text: msg.body}, verdict: `banner shown${msg.title ? ` "${msg.title}"` : ''}${msg.body ? ` — "${msg.body}"` : ''}`, notes};
    const inFront = banner?.front === bundleId;
    return {
      ...base,
      ok: true,
      state: state(banner?.front),
      verdict: inFront ? "delivered; no banner — the app is in front and its notification handler shows none" : 'delivered; no banner seen — notifications may be off for the app, or its banners turned off',
      notes,
    };
  }

  /**
   * A Live Activity push on a simulator, through the app's hook (liveactivity.ts): the activity resolved from the token
   * (or the id, or the only one of its type that runs), checked as the system checks the payload, and handed over.
   */
  async #activity(t: PushTarget, app: string, la: {push: LiveActivityPush; token?: string}, opts: PushOptions): Promise<PushResult> {
    const {push, token} = la;
    // Sorts by time: the hook takes waiting commands in name order.
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const sent = `Live Activity ${push.event ?? '?'}${push.type ? ` ${push.type}` : ''}`;
    const base = {id, platform: t.platform, device: t.id, app, sent};
    const fail = (verdict: string, reason?: PushResult['reason']): PushResult => ({...base, ok: false, verdict, ...(reason ? {reason} : {})});
    if (t.platform === 'android') return fail('not delivered: Live Activities are iOS-only (an Android app shows a live update as an ongoing notification of its own)');
    const host = this.#deps.liveActivity?.();
    if (!host) throw new Error('Live Activities need a simulator on this Mac: a remote Mac does not take them');
    const state = await readLiveActivityState(host, t.id, app);
    if (!state) return fail(`not delivered: ${app} has no Live Activity hook — its debug build registers its attribute types with PitboxLiveActivity (docs/push.md#live-activities)`, 'nohook');
    const problem = liveActivityProblem(push);
    if (problem) return fail(`dropped, as the system would: ${problem}`);
    let activityId = opts.activityId;
    let type = push.type;
    if (token) {
      const hit = tokenIn(state, token, push.event === 'start' ? {kind: 'start', type: push.type} : {kind: 'activity'});
      if (!hit) return fail(`not delivered: no activity or push-to-start token of ${app} on this simulator has the token ${shortToken(token)}`, 'unregistered');
      if (push.event === 'start' && hit.kind !== 'start') return fail("dropped: a start sent to an activity's token — the system starts activities only from a push-to-start token");
      if (push.event !== 'start' && hit.kind === 'start') return fail(`dropped: an ${push.event} sent to the push-to-start token of ${hit.type} — the system ignores it; send it to the activity's own token`);
      if (push.event === 'start' && push.type && hit.type !== push.type) return fail(`dropped: the token is the push-to-start token of ${hit.type}, the push starts ${push.type}`);
      activityId = hit.activityId ?? activityId;
      type ??= hit.type;
    }
    if (push.event === 'start' && !state.types.includes(type!)) return fail(`not delivered: ${type} is not registered with the hook (registered: ${state.types.join(', ') || 'none'})`);
    if (push.event !== 'start' && !activityId) {
      const running = state.activities.filter(a => a.state === 'active' && (!type || a.type === type));
      if (running.length !== 1) throw new Error(running.length ? `${running.length} activities run: name one with id=<activity id> (push activities lists them)` : `no activity of ${app} runs on this simulator${type ? ` of type ${type}` : ''}`);
      activityId = running[0]!.id;
      type ??= running[0]!.type;
    }
    if (activityId && !type) type = state.activities.find(a => a.id === activityId)?.type;
    const {outcome, launched} = await deliverLiveActivity(host, t.id, app, {...push, type, id, activityId}, {waitMs: push.event === 'start' ? 8000 : 2000});
    // "(stand-in)" in the verdict says what this is; a note only for what a real push would not have done.
    const notes: string[] = [];
    if (launched) notes.push(`the app was brought to the front ${push.event === 'start' ? 'for Activity.request' : '(it was suspended)'}, which a real push does not need — \`key home\` shows the activity in the Island`);
    if (push.event === 'start' && push.alert) notes.push("a start's alert is not shown by the stand-in");
    if (!outcome) return {...fail(`not delivered: the hook did not answer — is PitboxLiveActivity.start() called at launch?`), notes};
    if (!outcome.ok) return {...fail(/^dropped/.test(outcome.error ?? '') ? outcome.error! : `the hook could not ${push.event} it: ${outcome.error ?? 'no reason given'}`), notes};
    const which = `${type ?? ''} ${(outcome.activityId ?? activityId ?? '').slice(0, 8)}`.trim();
    const tok = outcome.token ? ` · token ${shortToken(outcome.token)}${outcome.synthetic ? ' (synthetic)' : ''}` : '';
    if (outcome.note) notes.push(outcome.note);
    return {...base, ok: true, verdict: `Live Activity ${pastTense[push.event!]} (stand-in) · ${which}${tok}`, notes};
  }

  /** `push activity`: a Live Activity push from fields, with no payload to write. */
  async activity(opts: {device?: string; app?: string; event?: string; type?: string; attributes?: unknown; state?: unknown; stale?: unknown; dismissal?: unknown; relevance?: unknown; alert?: unknown; id?: string; token?: string; timestamp?: unknown}): Promise<PushResult> {
    const json = (v: unknown, what: string) => {
      if (v === undefined) return undefined;
      const o = obj(v);
      if (!o) throw new Error(`${what} is not a JSON object`);
      return o;
    };
    const date = (v: unknown, what: string) => {
      if (v === undefined || v === '') return undefined;
      const n = Number(v);
      if (Number.isFinite(n)) return n < 1e5 ? Math.floor(Date.now() / 1000) + n : n;
      const t = Date.parse(String(v));
      if (Number.isNaN(t)) throw new Error(`${what}: seconds from now, epoch seconds or an ISO date`);
      return Math.floor(t / 1000);
    };
    const alert = typeof opts.alert === 'string' && !opts.alert.trim().startsWith('{') ? {title: opts.alert} : (json(opts.alert, 'alert') as LiveActivityPush['alert']);
    const push: LiveActivityPush = {
      event: opts.event,
      timestamp: opts.timestamp === undefined ? Math.floor(Date.now() / 1000) : Number(opts.timestamp),
      type: opts.type,
      attributes: json(opts.attributes, 'attributes'),
      state: json(opts.state, 'state'),
      staleDate: date(opts.stale, 'stale'),
      dismissalDate: date(opts.dismissal, 'dismissal'),
      relevanceScore: opts.relevance === undefined ? undefined : Number(opts.relevance),
      alert,
    };
    if (push.event === 'start' && !push.attributes) push.attributes = {};
    const t = await this.#deps.target(opts.device);
    const r = await this.#activity(t, this.#app(t, opts.app), {push, token: opts.token}, {activityId: opts.id});
    const result = {...r, source: 'push activity'};
    this.#record(result, opts.token);
    return result;
  }

  /** `push activities`: what the app's hook reports — its types, its activities, the tokens the system gave. */
  async activities(opts: {device?: string; app?: string}): Promise<{device: string; app: string; state?: LiveActivityState; lines: string[]}> {
    const t = await this.#deps.target(opts.device, {fromGateway: false});
    const app = this.#app(t, opts.app);
    if (t.platform === 'android') throw new Error('Live Activities are iOS-only');
    const host = this.#deps.liveActivity?.();
    if (!host) throw new Error('Live Activities need a simulator on this Mac');
    const state = await readLiveActivityState(host, t.id, app);
    if (!state) return {device: t.id, app, lines: [`${app} has no Live Activity hook (PitboxLiveActivity in its debug build)`]};
    const start = state.tokens.filter(x => x.kind === 'start');
    const lines = [
      `types: ${state.types.join(', ') || 'none registered'}`,
      ...start.map(x => `push-to-start ${x.type}: ${shortToken(x.token)}${x.synthetic ? ' (synthetic)' : ''}`),
      ...state.activities.map(a => {
        const tok = state.tokens.find(x => x.kind === 'activity' && x.activityId === a.id);
        return `${a.type} ${a.id.slice(0, 8)} · ${a.state}${tok ? ` · token ${shortToken(tok.token)}${tok.synthetic ? ' (synthetic)' : ''}` : ''}`;
      }),
    ];
    if (!state.activities.length) lines.push('no activities');
    return {device: t.id, app, state, lines};
  }

  /**
   * Which simulator a Live Activity token is on: a bound token's, else the held simulator whose app reports it.
   * `dead`: no held simulator has it (`unregistered`), or none has an app with the hook to tell (`nohook`).
   */
  async routeActivity(token: string, bundleId?: string): Promise<{device?: string; dead?: 'unregistered' | 'nohook'; note?: string}> {
    const online = (await this.#deps.online()).apple;
    if (this.tokens.has(token) && online.includes(this.tokens.get(token)!)) return {device: this.tokens.get(token)};
    if (!online.length) return {};
    const host = this.#deps.liveActivity?.();
    const app = bundleId ?? this.#deps.appleApp?.();
    if (!host || !app) return {dead: 'nohook'};
    let hooked = false;
    for (const udid of online) {
      const st = await readLiveActivityState(host, udid, app);
      if (!st) continue;
      hooked = true;
      if (tokenIn(st, token)) return {device: udid};
    }
    return {dead: hooked ? 'unregistered' : 'nohook'};
  }

  /**
   * Looks for the banner: the runner lists the shell's notification banners, which sit over the app in front
   * and are not in its tree. Undefined when the screen cannot be read; null when no banner showed in time.
   */
  async #banner(ui: DeviceUi, title: string, waitMs: number): Promise<{seen: boolean; front?: string} | undefined> {
    const deadline = Date.now() + Math.max(waitMs, 1);
    let front: string | undefined;
    do {
      const r = await ui.runner.call<{banners?: string[]; front?: string}>('banners').catch(() => undefined);
      if (!r?.banners) return undefined;
      front = r.front;
      if (r.banners.some(b => b.includes(title))) return {seen: true, front};
      await sleep(300);
    } while (Date.now() < deadline);
    return {seen: false, front};
  }

  /**
   * Taps the app's latest notification (Android: in the shade; iOS: its banner or Notification Center). `expect`: what
   * the tap must bring to the front — the app (default), another app (`away`: a notification that opens a web page in
   * the browser, or another app's screen), or either (`any`).
   */
  async tap(opts: {device?: string; app?: string; title?: string; expect?: TapExpect}): Promise<{device: string; app: string; tapped: string; state?: AppState; front?: string; act?: ActResult; screen?: string[]; note?: string; ok?: boolean}> {
    const expect = opts.expect ?? 'app';
    if (!TAP_EXPECT.includes(expect)) throw new Error(`expect must be ${TAP_EXPECT.join(', ')}, not "${expect}"`);
    const t = await this.#deps.target(opts.device);
    const app = this.#app(t, opts.app);
    const ui = await this.#deps.ui(t.id);
    let title = opts.title;
    if (t.platform === 'android') return this.#tapAndroid(t.a, t.id, app, ui, title, expect);
    if (!title) {
      const last = [...this.log].reverse().find(r => r.platform === 'apple' && r.device === t.id && r.ok && r.title);
      title = last?.title;
      if (!title) throw new Error('no push on record for this simulator: pass title=<text on the notification>');
    }
    // The banner, or the notification in Notification Center (a swipe down from the top edge, left of the
    // notch); there the app's notifications stack and the first tap only spreads the stack.
    const tapBanner = async () => !!(await ui.runner.call<{tapped?: boolean}>('tapBanner', {text: title}).catch(() => undefined))?.tapped;
    let tapped = await tapBanner();
    if (!tapped) {
      const {width, height} = await ui.size();
      await ui.swipe(`${Math.round(width * 0.3)},2,${Math.round(width * 0.3)},${Math.round(height * 0.6)}`, 300).catch(() => undefined);
      await sleep(800);
      tapped = await tapBanner();
    }
    if (!tapped) throw new Error(`no notification "${title}" on screen or in Notification Center`);
    // Notification Center answers a tap in steps: a stack of the app's notifications spreads out, then a
    // notification shows its "Open" action, which opens the app.
    // Another app in front: not the app, not SpringBoard (its banners and Notification Center).
    const away = (front?: string) => !!front && front !== app && front !== 'com.apple.springboard';
    for (let i = 0; i < 3; i++) {
      await sleep(900);
      const r = await ui.runner.call<{front?: string}>('banners').catch(() => ({}) as {front?: string});
      if (r.front === app || (expect !== 'app' && away(r.front))) break;
      const snap = await ui.snapshot();
      const open = snap.nodes.findIndex(n => n.id === 'swipe-action-button-identifier');
      const ref = open >= 0 ? snap.refOf.get(open) : undefined;
      if (ref && snap.nodes.filter(n => n.id === 'swipe-action-button-identifier').length === 1) await ui.press(ref).catch(() => undefined);
      else if (!(await tapBanner())) break;
    }
    const front = (await ui.runner.call<{front?: string}>('banners').catch(() => ({}) as {front?: string})).front;
    const state: AppState | undefined = front === undefined ? undefined : front === app ? 'foreground' : 'background';
    const snap = await ui.snapshot();
    const ok = expect === 'away' ? away(front) : state !== 'background' || (expect === 'any' && away(front));
    const note = ok
      ? undefined
      : expect === 'away'
        ? `the notification was tapped, but no other app came to the front (${front === app ? 'the app is in front' : front ? `${front} is in front` : 'the front app is unknown'})`
        : `the notification was tapped, but ${front} is in front, not the app${expect === 'app' ? ' (expect=away for a tap that leaves the app)' : ''}`;
    return {device: t.id, app, tapped: title, state, ...(expect !== 'app' && away(front) && {front}), screen: snap.lines.slice(0, 12), note, ok};
  }

  /**
   * Android: the shade is opened and the notification found in System UI's own window (a snapshot leaves System UI
   * out, and the app behind the shade may show the same name), then tapped where its title is, as a person would.
   * Done when the app is in front and the notification is gone from the screen; a row that took no tap is clicked
   * through accessibility once more. Without a title: the latest one pitbox delivered that is still posted, else the
   * app's latest.
   */
  async #tapAndroid(a: AndroidDriver, serial: string, app: string, ui: DeviceUi, given: string | undefined, expect: TapExpect) {
    const norm = (x?: string) => (x ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    // Only the app's own notifications are candidates: the text to find in the shade is theirs, title and text.
    const {target, posted} = await this.#androidTarget(a, serial, app, given);
    if (!target.title && !target.text) throw new Error('the notification has no title or text to find it by in the shade');
    const twin = posted.find(n => n.pkg !== app && norm(n.title) === norm(target.title) && norm(n.text) === norm(target.text));
    if (twin) throw new Error(`${twin.pkg} shows a notification with the same title and text: the shade cannot tell which row is ${app}'s\nhint: push clear for the other app, or send this one with a distinct text`);
    const title = target.title ?? target.text!;
    type Tree = Parameters<typeof shadeRow>[0];
    // A tree the runner could not read is unknown, never an empty screen: it must not pass for "the notification is gone".
    const read = () => ui.runner.call<Tree>('tree').catch(() => undefined);
    await a.shell(serial, 'cmd statusbar expand-notifications');
    let tree: Tree | undefined;
    let found: ReturnType<typeof shadeRow>;
    for (const deadline = Date.now() + 3000; ; ) {
      tree = (await read()) ?? tree;
      found = tree && shadeRow(tree, target);
      if (found || Date.now() >= deadline) break;
      await sleep(300);
    }
    ui.screenChanged();
    if (!found) {
      await a.shell(serial, 'cmd statusbar collapse').catch(() => '');
      if (!tree) throw new Error('could not read the screen to find the notification in the shade: the device runner did not answer');
      const seen = shadeTitles(tree);
      throw new Error(`no notification "${title}" of ${app} in the shade${seen.length ? ` (it shows: ${seen.map(x => JSON.stringify(x)).join(', ')})` : ''}`);
    }
    const centre = (b: number[]) => ({x: Math.round((b[0]! + b[2]!) / 2), y: Math.round((b[1]! + b[3]!) / 2)});
    // Another app in front: not the app, not System UI's shade, not the home screen a tap that did nothing leaves.
    const home = expect === 'app' ? undefined : await homePackage(a, serial);
    const away = (front?: string) => !!front && front !== app && front !== 'com.android.systemui' && front !== home;
    /** Opened: the app in front and the row off the screen (or, as expected, another app in front); unknown when the last screen read failed. */
    const opened = async (): Promise<'yes' | 'no' | 'unknown'> => {
      let last: 'no' | 'unknown' = 'no';
      for (const deadline = Date.now() + 4000; Date.now() < deadline; ) {
        await sleep(400);
        const {state, front} = await appState(a, serial, app);
        if (expect !== 'app' && away(front)) return 'yes';
        if (state !== 'foreground' || expect === 'away') {
          last = 'no';
          continue;
        }
        const now = await read();
        if (!now) last = 'unknown';
        else if (!shadeRow(now, target)) return 'yes';
        else last = 'no';
      }
      return last;
    };
    await ui.runner.call('tap', centre(found.text.b));
    let outcome = await opened();
    let note: string | undefined;
    if (outcome !== 'yes') {
      const again = await read();
      const row = again ? shadeRow(again, target)?.row : undefined;
      if (row) {
        await ui.runner.call('node-action', {window: row.w, bounds: row.b, action: 16}, 15_000).catch(() => undefined);
        outcome = await opened();
        if (outcome === 'yes') note = 'the row took no tap: clicked through accessibility';
      }
    }
    ui.screenChanged();
    const {state, front} = await appState(a, serial, app);
    const ok = outcome === 'yes';
    if (!ok) {
      await a.shell(serial, 'cmd statusbar collapse').catch(() => '');
      note =
        outcome === 'unknown'
          ? 'the notification was tapped and the app is in front, but the screen could not be read to confirm the notification left the shade'
          : expect === 'away'
            ? `the notification was tapped, but no other app came to the front (${state === 'foreground' ? 'the app is in front' : `the app is ${state}`})`
            : `the notification was tapped, but ${state === 'foreground' ? 'it stayed in the shade' : `the app did not come to the front (${state})`}: its tap opens nothing in the app, or opens another app${expect === 'app' ? ' (expect=away for a tap that leaves the app)' : ''}`;
    }
    const snap = await ui.snapshot().catch(() => undefined);
    return {device: serial, app, tapped: title, state, ...(expect !== 'app' && away(front) && {front}), screen: snap?.lines.slice(0, 12), note, ok};
  }

  /**
   * `push respond`: answers a delivered notification as a person would — its tap (`open`, the default), a dismissal
   * (`dismiss`), or one of its actions by identifier or title, with `text` for a reply. iOS: through the app's
   * PitboxNotifications hook, which hands its notification delegate the response the system would (the simulator
   * shows the actions only in the expanded notification, which a long press does not reliably open). Android: the
   * action's button in the shade, pressed by System UI as a person's tap would be.
   */
  async respond(opts: {device?: string; app?: string; action?: string; title?: string; id?: string; text?: string}): Promise<RespondResult> {
    const t = await this.#deps.target(opts.device);
    const app = this.#app(t, opts.app);
    const action = opts.action?.trim() || 'open';
    if (t.platform === 'android') return this.#respondAndroid(t.a, t.id, app, opts.title, action, opts.text);
    const host = this.#deps.liveActivity?.();
    if (!host) throw new Error('notification responses need a simulator on this Mac: a remote Mac does not take them');
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const base = {device: t.id, app};
    const {outcome, launched} = await deliverToHook<NotificationResponseOutcome>(host, t.id, app, {dir: notificationDir, notice: notificationNotice(app)}, {id, action, notification: opts.id, title: opts.title, text: opts.text}, {waitMs: 2000, afterLaunchMs: 5000, takenMs: 8000});
    if (!outcome) return {...base, ok: false, verdict: `${app} took no response: its debug build calls PitboxNotifications.start() at launch (docs/push.md#notification-actions)`};
    if (!outcome.ok) return {...base, ok: false, verdict: outcome.error ?? 'the hook gave no reason', notification: outcome.title, actions: outcome.actions};
    // The system brings the app to the front for the notification's own tap and for an action with the foreground option.
    if (outcome.foreground && !launched) await host.launch(t.id, app).catch(() => undefined);
    const what = outcome.action === 'com.apple.UNNotificationDefaultActionIdentifier' ? 'opened' : outcome.action === 'com.apple.UNNotificationDismissActionIdentifier' ? 'dismissed' : `answered with ${outcome.action}`;
    const notes = [
      ...(outcome.completed === false ? ['the delegate did not call its completion handler within 5 s'] : []),
      ...(launched && !outcome.foreground ? ['the app was brought to the front to take the response (it was not running or suspended); the system would answer a background action without that'] : []),
    ];
    return {...base, ok: true, verdict: `${what} "${outcome.title ?? outcome.notification}"${opts.text !== undefined && outcome.action !== undefined ? ` (text ${JSON.stringify(opts.text)})` : ''} — the app's notification delegate got it`, notification: outcome.title, answered: outcome.action, actions: outcome.actions, notes};
  }

  /** The app's notification a call means: by text, else the latest pitbox delivered that is still posted, else the app's latest. */
  async #androidTarget(a: AndroidDriver, serial: string, app: string, given: string | undefined): Promise<{target: PostedNotification; posted: PostedNotification[]}> {
    const norm = (x?: string) => (x ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const posted = (await notifications(a, serial)).filter(n => !n.summary);
    const mine = posted.filter(n => n.pkg === app).sort((x, y) => y.updated - x.updated);
    if (!mine.length) throw new Error(`${app} has no notification in the shade`);
    let target: PostedNotification | undefined;
    if (given) {
      const g = norm(given);
      target = mine.find(n => norm(n.title) === g) ?? mine.find(n => norm(n.title).includes(g) || norm(n.text).includes(g));
      if (!target) throw new Error(`${app} has no notification showing "${given}" (its notifications: ${mine.slice(0, 5).map(n => JSON.stringify(n.title ?? n.text ?? '')).join(', ')})`);
    } else {
      const ours = [...this.log].reverse().filter(r => r.platform === 'android' && r.device === serial && r.app === app && r.shown?.title).map(r => r.shown!.title!);
      target = ours.map(o => mine.find(n => n.title === o)).find(Boolean) ?? mine[0]!;
    }
    return {target, posted};
  }

  async #respondAndroid(a: AndroidDriver, serial: string, app: string, given: string | undefined, action: string, text: string | undefined): Promise<RespondResult> {
    const base = {device: serial, app};
    if (/^(open|default)$/i.test(action)) {
      const r = await this.#tapAndroid(a, serial, app, await this.#deps.ui(serial), given, 'any');
      return {...base, ok: r.ok, verdict: r.ok ? `opened "${r.tapped}"` : (r.note ?? 'the tap did not open it'), notification: r.tapped, state: r.state, screen: r.screen};
    }
    const {target} = await this.#androidTarget(a, serial, app, given);
    const title = target.title ?? target.text ?? '';
    const actions = target.actions ?? [];
    const dismiss = /^dismiss$/i.test(action);
    const name = dismiss ? undefined : pickAction(actions, action);
    if (!dismiss && !name) {
      return {...base, ok: false, verdict: actions.length ? `"${title}" has no action "${action}"` : `"${title}" has no actions`, notification: title, actions};
    }
    const ui = await this.#deps.ui(serial);
    type Tree = Parameters<typeof shadeRow>[0];
    const read = () => ui.runner.call<Tree>('tree').catch(() => undefined);
    const centre = (b: number[]) => ({x: Math.round((b[0]! + b[2]!) / 2), y: Math.round((b[1]! + b[3]!) / 2)});
    await a.shell(serial, 'cmd statusbar expand-notifications');
    ui.screenChanged();
    let tree: Tree | undefined;
    let found: ReturnType<typeof shadeRow>;
    for (const deadline = Date.now() + 3000; ; ) {
      tree = (await read()) ?? tree;
      found = tree && shadeRow(tree, target);
      if (found || Date.now() >= deadline) break;
      await sleep(300);
    }
    const collapse = () => a.shell(serial, 'cmd statusbar collapse').catch(() => '');
    if (!found) {
      await collapse();
      return {...base, ok: false, verdict: `no notification "${title}" of ${app} in the shade${tree ? ` (it shows: ${shadeTitles(tree).map(x => JSON.stringify(x)).join(', ')})` : ''}`, notification: title, actions};
    }
    if (dismiss) {
      const [l, top, r, b] = found.row.b;
      const y = Math.round((top + b) / 2);
      await ui.runner.call('swipe', {x1: l + Math.round((r - l) * 0.2), y1: y, x2: r - 2, y2: y, duration: 250});
      await sleep(700);
      const gone = !(await notifications(a, serial, app)).some(n => n.key === target.key);
      await collapse();
      ui.screenChanged();
      return {...base, ok: gone, verdict: gone ? `dismissed "${title}"` : `swiped "${title}" away, but it is still posted (an ongoing notification cannot be dismissed)`, notification: title, actions};
    }
    let button = shadeButton(tree!, found.text, name!);
    if (!button) {
      // A collapsed notification hides its buttons: expanded through accessibility, as the expand arrow would.
      await ui.runner.call('node-action', {window: found.row.w, bounds: found.row.b, action: 0x40000}, 15_000).catch(() => undefined);
      await sleep(600);
      tree = (await read()) ?? tree;
      const again = tree && shadeRow(tree, target);
      button = tree && shadeButton(tree, (again ?? found).text, name!);
    }
    if (!button) {
      await collapse();
      return {...base, ok: false, verdict: `"${title}" lists the action "${name}", but the shade shows no button for it`, notification: title, actions};
    }
    await ui.runner.call('tap', centre(button.b));
    const notes: string[] = [];
    if (text !== undefined) {
      // A reply action opens an input in the notification: the text goes in, then its send button.
      let field: Tree['nodes'][number] | undefined;
      for (const deadline = Date.now() + 3000; !field && Date.now() < deadline; ) {
        await sleep(300);
        const now = await read();
        field = now?.nodes.find(n => now.windows[n.w]?.pkg.startsWith('com.android.systemui') && (n.f ?? '').includes('e'));
        if (field) tree = now;
      }
      if (!field) notes.push(`"${name}" opened no text field: the text was not sent`);
      else {
        await ui.runner.call('text', {text, bounds: field.b});
        await sleep(300);
        const now = (await read()) ?? tree!;
        const send = now.nodes.find(n => now.windows[n.w]?.pkg.startsWith('com.android.systemui') && (n.f ?? '').includes('c') && /^send\b/i.test(n.d ?? n.t ?? ''));
        if (send) await ui.runner.call('tap', centre(send.b));
        else notes.push('typed the text, but found no send button next to it');
      }
    }
    await sleep(800);
    await collapse();
    ui.screenChanged();
    const {state} = await appState(a, serial, app);
    const snap = await ui.snapshot().catch(() => undefined);
    return {...base, ok: !notes.length, verdict: `pressed "${name}" on "${title}"${text !== undefined && !notes.length ? ` and sent ${JSON.stringify(text)}` : ''}`, notification: title, answered: name, actions, state, screen: snap?.lines.slice(0, 12), notes};
  }

  /** Removes the app's notifications (Android; iOS has no command for it). */
  async clear(opts: {device?: string; app?: string}): Promise<{device: string; app: string; cleared: number}> {
    const t = await this.#deps.target(opts.device);
    const app = this.#app(t, opts.app);
    if (t.platform === 'apple') throw new Error('unsupported on iOS simulators: no command removes delivered notifications (swipe them away in Notification Center)');
    const before = (await notifications(t.a, t.id, app)).filter(n => !n.summary).length;
    const r = await callReceiver(t.a, t.id, app, 'clear');
    if (r.code !== 1) throw new Error(r.data ?? (await missingReceiver(t.a, t.id, app)));
    return {device: t.id, app, cleared: before};
  }

  async grant(opts: {device?: string; app?: string}): Promise<{device: string; app: string; note: string}> {
    const t = await this.#deps.target(opts.device);
    const app = this.#app(t, opts.app);
    if (t.platform === 'apple') throw new Error('unsupported on iOS simulators: notification permission is only given in the app\'s own prompt (press "Allow")');
    return {device: t.id, app, note: await grantNotifications(t.a, t.id, app)};
  }

  /** Can this app take pushes here: the receiver, the FCM service, Firebase, the permission. */
  async status(opts: {device?: string; app?: string}): Promise<{device: string; app: string; platform: string; lines: string[]}> {
    const t = await this.#deps.target(opts.device);
    const app = this.#app(t, opts.app);
    if (t.platform === 'apple') {
      const lines = ['simctl push: ready (no app code needed; the app must have asked for notification permission)'];
      const host = this.#deps.liveActivity?.();
      if (host) {
        const aps = await host.apsEnvironment?.(t.id, app).catch(() => undefined);
        if (aps !== undefined) lines.push(aps ? 'aps-environment: ✓ (the system gives real push tokens, Live Activity ones too)' : '✗ no aps-environment entitlement: no push tokens; the Live Activity hook makes up synthetic ones');
        const st = await readLiveActivityState(host, t.id, app);
        if (!st) lines.push('Live Activities: no hook (PitboxLiveActivity in the debug build takes them)');
        else {
          const real = st.tokens.filter(x => !x.synthetic).length;
          const made = st.tokens.length - real;
          lines.push(`Live Activities: hook ✓ · ${st.types.join(', ') || 'no types registered'} · ${st.activities.filter(a => a.state === 'active').length} running · tokens ${real} real${made ? `, ${made} synthetic` : ''}`);
        }
      }
      return {device: t.id, app, platform: 'apple', lines};
    }
    const r = await callReceiver(t.a, t.id, app, 'probe');
    if (!r.data) throw new Error(await missingReceiver(t.a, t.id, app));
    const allowed = await notificationsAllowed(t.a, t.id, app);
    const service = /service=(\S+)/.exec(r.data)?.[1];
    return {
      device: t.id,
      app,
      platform: 'android',
      lines: [
        `receiver: pitbox connect ✓`,
        service && service !== '-' ? `FCM service: ${service}` : '✗ no FCM service (the app has no FCM client: expo-notifications, @react-native-firebase/messaging or firebase-messaging)',
        /firebase=true/.test(r.data) ? 'Firebase: initialised' : '✗ Firebase not initialised (google-services.json, or FirebaseApp.initializeApp)',
        allowed.allowed ? 'notifications: allowed' : `✗ notifications: ${allowed.reason} (push action=grant)`,
      ],
    };
  }

  /**
   * Which device a gateway request goes to: a bound token, else a placeholder token's platform, else by the kind of
   * request and what is online. `dead`: the token cannot belong to any device here (the gateway answers as for a
   * dead token).
   */
  async route(kind: 'apns' | 'fcm', token?: string): Promise<{device?: string; note?: string; dead?: string}> {
    // `online` is the devices this session may deliver to (with leases: the ones it holds, never another's).
    const online = await this.#deps.online();
    let skipped: string | undefined;
    if (token && this.tokens.has(token)) {
      const bound = this.tokens.get(token)!;
      if (online.android.includes(bound) || online.apple.includes(bound)) return {device: bound};
      skipped = `the token is bound to ${bound}, which this session does not hold now: routed by kind instead`;
    }
    const withNote = (r: {device?: string; note?: string; dead?: string}) => ({...r, note: [skipped, r.note].filter(Boolean).join('; ') || undefined});
    // A debug build with no real token (no APNs on a simulator, no Play services on an emulator) registers
    // `pitbox-ios-…` / `pitbox-android-…`: the platform is in the token, so it is never a guess.
    const placeholder = token ? placeholderPlatform(token) : undefined;
    if (placeholder) {
      if (kind === 'apns' && placeholder === 'android') return withNote({dead: 'an Android placeholder token on an APNs request'});
      const candidates = placeholder === 'apple' ? online.apple : online.android;
      // The only device of its platform: bound, so the token keeps finding it when more devices come online.
      if (candidates.length === 1) this.bind(token!, candidates[0]!);
      const note = candidates.length > 1 ? `a ${placeholder === 'apple' ? 'pitbox-ios' : 'pitbox-android'} token with ${candidates.length} devices online went to ${candidates[0]}: \`push bind <token> --device …\` picks another` : undefined;
      return withNote({device: candidates[0], note});
    }
    if (kind === 'apns') return withNote({device: online.apple[0]});
    // An APNs device token is 64 hex digits; an FCM token is not.
    if (token && /^[0-9a-f]{64}$/i.test(token) && online.apple.length) return withNote({device: online.apple[0]});
    const device = online.android[0] ?? online.apple[0];
    const note =
      online.android.length && online.apple.length
        ? `an FCM token with an emulator and a simulator online went to ${device}: \`push bind <token> --device …\` picks the other`
        : undefined;
    return withNote({device, note});
  }

  bind(token: string, device: string) {
    this.tokens.set(token, device);
    const file = this.#deps.tokenFile?.();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries(this.tokens), null, 2));
    } catch {
      // kept in memory still
    }
  }
}
