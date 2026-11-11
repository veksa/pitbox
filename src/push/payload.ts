// Push payloads: one message from whatever the caller has — pitbox's simple fields, an APNs payload, an FCM
// message (HTTP v1, firebase-admin or the legacy API) — and back out in the form each platform's delivery takes:
// the APNs JSON `simctl push` reads, and the intent extras an Android FirebaseMessagingService receives.

export type Priority = 'high' | 'normal';

/** One push, platform-neutral. */
export type PushMessage = {
  title?: string;
  subtitle?: string;
  body?: string;
  /** Custom keys: APNs top-level keys, FCM `data`. */
  data: Record<string, unknown>;
  badge?: number;
  sound?: string;
  /** iOS category (actions); also `click_action` on Android when none is given. */
  category?: string;
  threadId?: string;
  /** `apns-collapse-id` / FCM `collapse_key`. */
  collapseId?: string;
  /** Android notification channel. */
  channel?: string;
  image?: string;
  /** Android notification tag: a new notification with the same tag replaces the old one. */
  tag?: string;
  icon?: string;
  color?: string;
  clickAction?: string;
  /** No visible notification from the system: iOS `content-available` with no alert, an FCM data-only message. */
  silent?: boolean;
  priority?: Priority;
  ttl?: number;
  /** aps fields with no field here (`mutable-content`, `interruption-level`, …), kept as they are. */
  aps?: Record<string, unknown>;
  /** The message came as an FCM message (an iOS app then sees `gcm.message_id`, as with real FCM). */
  viaFcm?: boolean;
};

/** What `push` accepts: simple fields, or a raw payload for one platform (converted for the other). */
export type PushInput = {
  title?: string;
  subtitle?: string;
  body?: string;
  data?: Record<string, unknown> | string;
  badge?: number | string;
  sound?: string;
  category?: string;
  threadId?: string;
  collapseId?: string;
  channel?: string;
  image?: string;
  tag?: string;
  silent?: boolean | string;
  contentAvailable?: boolean | string;
  priority?: string;
  apns?: Record<string, unknown> | string;
  /** Headers of an APNs request (`apns-collapse-id`, `apns-priority`, `apns-push-type`). */
  apnsHeaders?: Record<string, string>;
  fcm?: Record<string, unknown> | string;
};

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const s = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v));
const n = (v: unknown): number | undefined => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
const yes = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

const parseJson = (v: unknown, what: string): Obj | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (isObj(v)) return v;
  try {
    const parsed = JSON.parse(String(v)) as unknown;
    if (!isObj(parsed)) throw new Error('not an object');
    return parsed;
  } catch (e) {
    throw new Error(`${what} is not a JSON object: ${(e as Error).message}`);
  }
};

const drop = <T extends Obj>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** An APNs payload (`{aps: {…}, …custom}`) as a message. */
export const fromApns = (payload: Obj, headers: Record<string, string | undefined> = {}): PushMessage => {
  const {aps: rawAps, ...custom} = payload;
  const aps = isObj(rawAps) ? {...rawAps} : {};
  const alert = aps.alert;
  delete aps.alert;
  const msg: PushMessage = {data: {...custom}};
  delete msg.data['Simulator Target Bundle'];
  if (typeof alert === 'string') msg.body = alert;
  else if (isObj(alert)) {
    msg.title = s(alert.title);
    msg.subtitle = s(alert.subtitle);
    msg.body = s(alert.body);
  }
  msg.badge = n(aps.badge);
  delete aps.badge;
  const sound = aps.sound;
  msg.sound = isObj(sound) ? s(sound.name) : s(sound);
  delete aps.sound;
  msg.threadId = s(aps['thread-id']);
  delete aps['thread-id'];
  msg.category = s(aps.category);
  delete aps.category;
  if (yes(aps['content-available']) && alert === undefined) msg.silent = true;
  if (!msg.silent && yes(aps['content-available'])) msg.aps = {'content-available': 1};
  delete aps['content-available'];
  if (Object.keys(aps).length) msg.aps = {...msg.aps, ...aps};
  msg.collapseId = s(headers['apns-collapse-id']);
  const priority = s(headers['apns-priority']);
  if (priority) msg.priority = priority === '10' ? 'high' : 'normal';
  if (headers['apns-push-type'] === 'background') msg.silent = true;
  return drop(msg);
};

/** FCM's time to live in seconds: HTTP v1 writes `"3600s"`, firebase-admin milliseconds, the legacy API seconds. */
const ttlSeconds = (v: unknown): number | undefined => {
  if (typeof v === 'string' && /^\d+(\.\d+)?s$/.test(v)) return Math.round(Number(v.slice(0, -1)));
  if (typeof v === 'number') return Math.round(v / 1000);
  return n(v);
};

/**
 * An FCM message as a message: HTTP v1 (`{message: {…}}` or the inner object, as firebase-admin's `send` takes
 * it) or the legacy API (`{to, notification, data, collapse_key, priority}`). Android fields win over the
 * shared notification; the `apns` block fills what iOS needs.
 */
export const fromFcm = (raw: Obj): PushMessage => {
  const m = isObj(raw.message) ? raw.message : raw;
  const notification = isObj(m.notification) ? m.notification : {};
  const android = isObj(m.android) ? m.android : {};
  const an = isObj(android.notification) ? android.notification : {};
  const apns = isObj(m.apns) ? m.apns : {};
  const apnsHeaders = isObj(apns.headers) ? (apns.headers as Record<string, string>) : {};
  const fromIos = isObj(apns.payload) ? fromApns(apns.payload, apnsHeaders) : undefined;
  // `android.data` (firebase-admin) adds to and overrides the shared data on Android.
  const data = {...(isObj(m.data) ? m.data : {}), ...(isObj(android.data) ? android.data : {})};
  const priority = (s(android.priority) ?? s(m.priority))?.toLowerCase();
  const msg: PushMessage = {
    // On iOS the data keys sit next to aps, like the custom keys of the apns payload.
    data: {...(fromIos?.data ?? {}), ...data},
    title: s(an.title) ?? s(notification.title) ?? fromIos?.title,
    subtitle: fromIos?.subtitle,
    body: s(an.body) ?? s(notification.body) ?? fromIos?.body,
    image: s(an.image) ?? s(notification.image) ?? s(notification.imageUrl),
    channel: s(an.channel_id) ?? s(an.channelId) ?? s(notification.android_channel_id),
    sound: s(an.sound) ?? s(notification.sound) ?? fromIos?.sound,
    tag: s(an.tag) ?? s(notification.tag),
    icon: s(an.icon) ?? s(notification.icon),
    color: s(an.color) ?? s(notification.color),
    clickAction: s(an.click_action) ?? s(an.clickAction) ?? s(notification.click_action),
    badge: n(an.notification_count) ?? n(an.notificationCount) ?? n(notification.badge) ?? fromIos?.badge,
    category: fromIos?.category,
    threadId: fromIos?.threadId,
    collapseId: s(android.collapse_key) ?? s(android.collapseKey) ?? s(m.collapse_key) ?? fromIos?.collapseId,
    priority: priority ? (priority === 'normal' ? 'normal' : 'high') : fromIos?.priority,
    ttl: android.ttl !== undefined ? ttlSeconds(android.ttl) : n(m.time_to_live),
    aps: fromIos?.aps,
    viaFcm: true,
  };
  if (msg.title === undefined && msg.body === undefined) msg.silent = true;
  return drop(msg);
};

/** The message for a `push` call: raw payloads first, simple fields on top of them. */
export const toMessage = (input: PushInput): PushMessage => {
  const apns = parseJson(input.apns, 'apns');
  const fcm = parseJson(input.fcm, 'fcm');
  if (apns && fcm) throw new Error('give apns or fcm, not both');
  const base: PushMessage = apns ? fromApns(apns, input.apnsHeaders) : fcm ? fromFcm(fcm) : {data: {}};
  const data = parseJson(input.data, 'data');
  const msg: PushMessage = {
    ...base,
    data: {...base.data, ...(data ?? {})},
    title: s(input.title) ?? base.title,
    subtitle: s(input.subtitle) ?? base.subtitle,
    body: s(input.body) ?? base.body,
    badge: n(input.badge) ?? base.badge,
    sound: s(input.sound) ?? base.sound,
    category: s(input.category) ?? base.category,
    threadId: s(input.threadId) ?? base.threadId,
    collapseId: s(input.collapseId) ?? base.collapseId,
    channel: s(input.channel) ?? base.channel,
    image: s(input.image) ?? base.image,
    tag: s(input.tag) ?? base.tag,
  };
  const priority = s(input.priority);
  if (priority) {
    if (priority !== 'high' && priority !== 'normal') throw new Error('priority: high or normal');
    msg.priority = priority;
  }
  if (yes(input.silent) || yes(input.contentAvailable)) msg.silent = true;
  else if (input.silent !== undefined && !yes(input.silent)) msg.silent = false;
  if (!apns && !fcm && msg.title === undefined && msg.body === undefined && !msg.silent) {
    if (!Object.keys(msg.data).length) throw new Error('nothing to send: give title/body, data, apns, fcm or file');
    // Only data: a data message, as FCM would make of it.
    msg.silent = true;
  }
  return drop(msg);
};

/** The APNs JSON `simctl push` takes (`Simulator Target Bundle` names the app). */
export const toApns = (msg: PushMessage, bundleId?: string, messageId?: string): Obj => {
  const aps: Obj = {};
  if (!msg.silent && (msg.title !== undefined || msg.body !== undefined || msg.subtitle !== undefined)) {
    aps.alert = drop({title: msg.title, subtitle: msg.subtitle, body: msg.body});
  }
  if (msg.badge !== undefined) aps.badge = msg.badge;
  if (msg.sound !== undefined && !msg.silent) aps.sound = msg.sound;
  if (msg.threadId !== undefined) aps['thread-id'] = msg.threadId;
  if (msg.category !== undefined) aps.category = msg.category;
  Object.assign(aps, msg.aps ?? {});
  if (msg.silent) aps['content-available'] = 1;
  const out: Obj = {aps, ...msg.data};
  // React Native Firebase on iOS treats a notification as an FCM message (onMessage, getInitialNotification)
  // only when it carries the id FCM adds.
  if (msg.viaFcm && messageId && out['gcm.message_id'] === undefined) out['gcm.message_id'] = messageId;
  if (bundleId) out['Simulator Target Bundle'] = bundleId;
  return out;
};

const dataString = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * The intent extras FCM delivers to a FirebaseMessagingService: the message envelope (`google.*`, `from`,
 * `collapse_key`), the notification under `gcm.notification.*` with `gcm.n.e` marking it, and the data keys
 * as they are (strings). Firebase reads both the `gcm.n.` and the `gcm.notification.` prefix.
 */
export const toFcmExtras = (msg: PushMessage, opts: {messageId: string; pkg: string; sentAt?: number; sender?: string}): Record<string, string> => {
  const priority = msg.priority ?? 'high';
  const out: Record<string, string> = {
    from: opts.sender ?? 'pitbox',
    'google.message_id': opts.messageId,
    'google.sent_time': String(opts.sentAt ?? Date.now()),
    'google.ttl': String(msg.ttl ?? 2419200),
    'google.delivered_priority': priority,
    'google.original_priority': priority,
    // FCM's default collapse key is the package name.
    collapse_key: msg.collapseId ?? opts.pkg,
  };
  if (!msg.silent) {
    const notification: Record<string, string | undefined> = {
      title: msg.title,
      body: msg.body,
      android_channel_id: msg.channel,
      sound2: msg.sound,
      tag: msg.tag,
      image: msg.image,
      icon: msg.icon,
      color: msg.color,
      click_action: msg.clickAction,
      notification_count: msg.badge === undefined ? undefined : String(msg.badge),
    };
    out['gcm.n.e'] = '1';
    out['gcm.notification.e'] = '1';
    for (const [k, v] of Object.entries(notification)) if (v !== undefined) out[`gcm.notification.${k}`] = v;
  }
  for (const [k, v] of Object.entries(msg.data)) {
    if (/^(google\.|gcm\.)/.test(k) || k === 'from' || k === 'collapse_key' || k === 'message_type') continue;
    out[k] = dataString(v);
  }
  return out;
};

/** One line for the log and the verdict: what was sent. */
export const describe = (msg: PushMessage): string => {
  const head = msg.silent ? 'data-only' : [msg.title, msg.body].filter(Boolean).map(t => `"${t}"`).join(' — ') || 'notification';
  const keys = Object.keys(msg.data);
  return `${head}${keys.length ? ` · data ${keys.slice(0, 6).join(',')}${keys.length > 6 ? ',…' : ''}` : ''}`;
};

/** A payload file as `push` input: an APNs payload (`aps`, as Xcode's .apns files) or an FCM message. */
export const fromPayloadFile = (content: unknown): PushInput => {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) throw new Error('the payload file is not a JSON object');
  const o = content as Record<string, unknown>;
  if ('aps' in o) return {apns: o};
  if ('message' in o || 'notification' in o || 'data' in o || 'android' in o || 'token' in o || 'to' in o) return {fcm: o};
  throw new Error('the payload file is neither an APNs payload (aps) nor an FCM message (message, notification, data)');
};
