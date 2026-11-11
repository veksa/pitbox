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
import {appState, assertPackage, callReceiver, grantNotifications, missingReceiver, notifications, notificationsAllowed, type AppState, type PostedNotification} from './android.ts';
import {describe, toApns, toFcmExtras, toMessage, type PushInput, type PushMessage} from './payload.ts';

export type PushTarget = {platform: 'android'; id: string; a: AndroidDriver} | {platform: 'apple'; id: string; s: AppleDevices};

export type PushDeps = {
  /** The device a call names, or the only one online. */
  target: (device?: string) => Promise<PushTarget>;
  /** Online devices by platform, for the gateway's routing. */
  online: () => Promise<{android: string[]; apple: string[]}>;
  androidApp?: () => string | undefined;
  appleApp?: () => string | undefined;
  ui: (device: string) => Promise<DeviceUi>;
  /** The device's UI only when its runner already runs: the gateway must not wait minutes for a runner build. */
  liveUi?: (device: string) => DeviceUi | undefined;
  /** Where token bindings are kept across daemon restarts (read on first use: the config may load later). */
  tokenFile?: () => string | undefined;
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
  /** `unregistered`: the device cannot take pushes for the app at all (the gateway answers as for a dead token). */
  reason?: 'unregistered';
  verdict: string;
  notes?: string[];
  count?: number;
  /** Seconds until a delayed push goes out. */
  scheduled?: number;
  source?: string;
};

export type PushRecord = PushResult & {at: number; token?: string};

const yes = (v: unknown) => v === true || v === 'true' || v === '1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A notification counts as this push's when it is new or changed since the snapshot before sending. */
const fresh = (before: PostedNotification[], after: PostedNotification[]): PostedNotification | undefined => {
  const was = new Map(before.map(n => [n.key, n.updated]));
  return after.filter(n => !n.summary && (!was.has(n.key) || was.get(n.key) !== n.updated)).sort((a, b) => b.updated - a.updated)[0];
};

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

  #record(r: PushResult, token?: string) {
    this.log.push({...r, at: Date.now(), token});
    if (this.log.length > 50) this.log.shift();
  }

  #app(t: PushTarget, given?: string): string {
    const app = given ?? (t.platform === 'android' ? this.#deps.androidApp?.() : this.#deps.appleApp?.());
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
    const msg = toMessage(opts);
    const t = await this.#deps.target(opts.device);
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

  /** Taps the app's latest notification (Android: in the shade; iOS: its banner or Notification Center). */
  async tap(opts: {device?: string; app?: string; title?: string}): Promise<{device: string; app: string; tapped: string; state?: AppState; act?: ActResult; screen?: string[]}> {
    const t = await this.#deps.target(opts.device);
    const app = this.#app(t, opts.app);
    const ui = await this.#deps.ui(t.id);
    let title = opts.title;
    if (t.platform === 'android') {
      if (!title) {
        const posted = (await notifications(t.a, t.id, app)).filter(n => !n.summary).sort((a, b) => b.updated - a.updated)[0];
        if (!posted) throw new Error(`${app} has no notification in the shade`);
        title = posted.title ?? posted.text;
        if (!title) throw new Error('the latest notification has no title or text to tap');
      }
      await t.a.shell(t.id, 'cmd statusbar expand-notifications');
      await sleep(600);
    } else {
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
      for (let i = 0; i < 3; i++) {
        await sleep(900);
        const r = await ui.runner.call<{front?: string}>('banners').catch(() => ({}) as {front?: string});
        if (r.front === app) break;
        const snap = await ui.snapshot();
        const open = snap.nodes.findIndex(n => n.id === 'swipe-action-button-identifier');
        const ref = open >= 0 ? snap.refOf.get(open) : undefined;
        if (ref && snap.nodes.filter(n => n.id === 'swipe-action-button-identifier').length === 1) await ui.press(ref).catch(() => undefined);
        else if (!(await tapBanner())) break;
      }
      const snap = await ui.snapshot();
      return {device: t.id, app, tapped: title, screen: snap.lines.slice(0, 12)};
    }
    const r = await ui.press(`text~=${title}`);
    const {state} = await appState(t.a, t.id, app);
    return {device: t.id, app, tapped: title!, state, act: r};
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
    if (t.platform === 'apple') return {device: t.id, app, platform: 'apple', lines: ['simctl push: ready (no app code needed; the app must have asked for notification permission)']};
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

  /** Which device a gateway request goes to: a bound token, else by the kind of request and what is online. */
  async route(kind: 'apns' | 'fcm', token?: string): Promise<{device?: string; note?: string}> {
    if (token && this.tokens.has(token)) return {device: this.tokens.get(token)};
    const online = await this.#deps.online();
    if (kind === 'apns') return {device: online.apple[0]};
    // An APNs device token is 64 hex digits; an FCM token is not.
    if (token && /^[0-9a-f]{64}$/i.test(token) && online.apple.length) return {device: online.apple[0]};
    const device = online.android[0] ?? online.apple[0];
    const note =
      online.android.length && online.apple.length
        ? `an FCM token with an emulator and a simulator online went to ${device}: \`push bind <token> --device …\` picks the other`
        : undefined;
    return {device, note};
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
