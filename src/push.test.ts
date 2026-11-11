// Push emulation without a device: payloads in and out, the dumpsys parser, the CLI and the stand's gateway.

import http2 from 'node:http2';
import {describe, expect, it} from 'vitest';
import {parseArgs, toCall} from './cli.ts';
import {assertPackage, parseBroadcast, parseNotifications, shadeRow} from './push/android.ts';
import {handlePush, PushGateway} from './push/gateway.ts';
import {fromApns, fromFcm, fromPayloadFile, toApns, toFcmExtras, toMessage} from './push/payload.ts';
import {PushCenter, PushUnregistered, type PushOptions, type PushResult} from './push/push.ts';
import {freePort} from './util/net.ts';

describe('push payloads', () => {
  it('builds an APNs payload from the simple form', () => {
    const msg = toMessage({title: 'Hi', body: 'There', data: '{"chat":"c1","n":2}', badge: '3', sound: 'default', threadId: 'c1', category: 'MSG'});
    expect(toApns(msg, 'com.example.app')).toEqual({
      aps: {alert: {title: 'Hi', body: 'There'}, badge: 3, sound: 'default', 'thread-id': 'c1', category: 'MSG'},
      chat: 'c1',
      n: 2,
      'Simulator Target Bundle': 'com.example.app',
    });
  });

  it('builds FCM wire extras: envelope, notification under gcm.notification, data as strings', () => {
    const msg = toMessage({title: 'Hi', body: 'There', data: {chat: 'c1', n: 2, obj: {a: 1}}, channel: 'messages', tag: 'c1', badge: 4});
    const x = toFcmExtras(msg, {messageId: '0:1%x', pkg: 'com.example.app', sentAt: 5});
    expect(x).toMatchObject({
      'google.message_id': '0:1%x',
      'google.sent_time': '5',
      'google.delivered_priority': 'high',
      collapse_key: 'com.example.app',
      'gcm.n.e': '1',
      'gcm.notification.title': 'Hi',
      'gcm.notification.body': 'There',
      'gcm.notification.android_channel_id': 'messages',
      'gcm.notification.tag': 'c1',
      'gcm.notification.notification_count': '4',
      chat: 'c1',
      n: '2',
      obj: '{"a":1}',
    });
  });

  it('sends data alone as a data message on both platforms', () => {
    const msg = toMessage({data: {kind: 'read'}});
    expect(msg.silent).toBe(true);
    expect(toFcmExtras(msg, {messageId: 'm', pkg: 'p'})['gcm.n.e']).toBeUndefined();
    expect(toApns(msg)).toEqual({aps: {'content-available': 1}, kind: 'read'});
  });

  it('refuses an empty push', () => {
    expect(() => toMessage({})).toThrow(/nothing to send/);
    expect(() => toMessage({data: '[1]'})).toThrow(/not a JSON object/);
  });

  it('reads an APNs payload with its headers', () => {
    const msg = fromApns({aps: {alert: {title: 'T', subtitle: 'S', body: 'B'}, sound: {name: 'ping.caf', critical: 1}, 'thread-id': 'g', 'interruption-level': 'time-sensitive', 'mutable-content': 1}, chat: 'c1'}, {'apns-collapse-id': 'c1', 'apns-priority': '5'});
    expect(msg).toMatchObject({title: 'T', subtitle: 'S', body: 'B', sound: 'ping.caf', threadId: 'g', collapseId: 'c1', priority: 'normal', data: {chat: 'c1'}, aps: {'interruption-level': 'time-sensitive', 'mutable-content': 1}});
    // Back out for the simulator: the extra aps fields stay.
    expect(toApns(msg).aps).toMatchObject({'interruption-level': 'time-sensitive', 'mutable-content': 1, 'thread-id': 'g'});
  });

  it('reads a background APNs push as silent', () => {
    expect(fromApns({aps: {'content-available': 1}, kind: 'read'}, {'apns-push-type': 'background'})).toMatchObject({silent: true, data: {kind: 'read'}});
  });

  it('reads a firebase-admin message: android fields win, camelCase, ttl in ms', () => {
    const msg = fromFcm({
      token: 't',
      notification: {title: 'T', body: 'B'},
      data: {type: 'x', url: '/a'},
      android: {priority: 'high', ttl: 86_400_000, collapseKey: 'c1', notification: {channelId: 'messages', tag: 'c1', sound: 'default', title: 'Android T'}, data: {extra: '1'}},
      apns: {headers: {'apns-collapse-id': 'c1'}, payload: {aps: {badge: 1, sound: 'default', 'thread-id': 'c1'}}},
    });
    expect(msg).toMatchObject({title: 'Android T', body: 'B', channel: 'messages', tag: 'c1', sound: 'default', collapseId: 'c1', priority: 'high', ttl: 86_400, badge: 1, threadId: 'c1', viaFcm: true, data: {type: 'x', url: '/a', extra: '1'}});
  });

  it('reads an HTTP v1 request and a legacy one', () => {
    expect(fromFcm({message: {token: 't', data: {kind: 'read'}, android: {priority: 'NORMAL', ttl: '60s'}}})).toMatchObject({silent: true, priority: 'normal', ttl: 60, data: {kind: 'read'}});
    expect(fromFcm({to: 't', notification: {title: 'T'}, collapse_key: 'k', priority: 'high', time_to_live: 30})).toMatchObject({title: 'T', collapseId: 'k', priority: 'high', ttl: 30});
  });

  it('gives an FCM message to iOS with the id React Native Firebase looks for', () => {
    const msg = toMessage({fcm: {notification: {title: 'T', body: 'B'}, data: {url: '/a'}}});
    expect(toApns(msg, 'com.example.app', 'm1')).toEqual({aps: {alert: {title: 'T', body: 'B'}}, url: '/a', 'gcm.message_id': 'm1', 'Simulator Target Bundle': 'com.example.app'});
  });

  it('lets simple fields override a raw payload', () => {
    expect(toMessage({apns: '{"aps":{"alert":"old"}}', body: 'new', badge: 2})).toMatchObject({body: 'new', badge: 2});
    expect(() => toMessage({apns: {aps: {}}, fcm: {data: {}}})).toThrow(/not both/);
  });

  it('tells a payload file by its shape', () => {
    expect(fromPayloadFile({aps: {alert: 'x'}})).toHaveProperty('apns');
    expect(fromPayloadFile({message: {data: {}}})).toHaveProperty('fcm');
    expect(() => fromPayloadFile({foo: 1})).toThrow(/neither/);
  });
});

const DUMP = `Current Notification Manager state:
  Notification List:
    NotificationRecord(0x01380878: pkg=android user=UserHandle{-1} id=55 tag=null importance=2 key=-1|android|55|null|1000: Notification(channel=DEVELOPER shortcut=null contentView=null vibrate=null sound=null tick defaults=0 flags=ONGOING_EVENT|CAN_COLORIZE color=0x00000000 vis=PUBLIC))
      uid=1000 userId=-1
      key=-1|android|55|null|1000
          extras={
                android.title=String (Serial console enabled)
          }
      mUpdateTimeMs=1000
    NotificationRecord(0x0a1b2c3d: pkg=com.example.app user=UserHandle{0} id=0 tag=FCM-Notification:12 importance=3 key=0|com.example.app|0|FCM-Notification:12|10213: Notification(channel=fcm_fallback_notification_channel shortcut=null contentView=null vibrate=null sound=default defaults=0 flags=AUTO_CANCEL color=0x00000000 vis=PRIVATE))
      uid=10213 userId=0
      key=0|com.example.app|0|FCM-Notification:12|10213
          extras={
                android.title=String (Hello (again))
                android.text=SpannableString (Body text)
          }
      mUpdateTimeMs=2000
    NotificationRecord(0x0a1b2c3e: pkg=com.example.app user=UserHandle{0} id=7 tag=null importance=3 key=0|com.example.app|7|null|10213: Notification(channel=messages shortcut=null contentView=null vibrate=null sound=null defaults=0 flags=AUTO_CANCEL|GROUP_SUMMARY color=0x00000000 vis=PRIVATE))
      mUpdateTimeMs=3000
  Notification attention state:
  Enqueued Notification List:
    NotificationRecord(0x0ba02142: pkg=com.example.app user=UserHandle{0} id=99 tag=x importance=3 key=0|com.example.app|99|x|2000: Notification(channel=other shortcut=null flags=0 color=0x00000000 vis=PRIVATE))
`;

describe('android verdicts', () => {
  it('lists the posted notifications of one app', () => {
    const list = parseNotifications(DUMP, 'com.example.app');
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({key: '0|com.example.app|0|FCM-Notification:12|10213', id: 0, tag: 'FCM-Notification:12', channel: 'fcm_fallback_notification_channel', importance: 3, title: 'Hello (again)', text: 'Body text', updated: 2000, summary: false});
    expect(list[1]!.summary).toBe(true);
    expect(parseNotifications(DUMP)).toHaveLength(3);
    expect(parseNotifications('nothing here')).toEqual([]);
  });

  it('reads the receiver answer from am broadcast', () => {
    expect(parseBroadcast('Broadcasting: Intent { … }\nBroadcast completed: result=1, data="ok service=com.example.Svc notifications=true"\n')).toEqual({code: 1, data: 'ok service=com.example.Svc notifications=true'});
    // No receiver in the app: nobody sets a result.
    expect(parseBroadcast('Broadcast completed: result=0\n')).toEqual({code: 0, data: undefined});
    expect(parseBroadcast('Error: …')).toEqual({code: -1});
  });
});

// The expanded shade over the app: the app's own window shows the same name (a chat with Ann) under the shade.
const SHADE = {
  windows: [{type: 'system', title: '', pkg: 'com.android.systemui'}, {type: 'app', title: '', pkg: 'com.example.app'}],
  nodes: [
    {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 2400] as [number, number, number, number]},
    {p: 0, w: 0, c: 'TextView', b: [40, 40, 200, 90] as [number, number, number, number], t: '12:00'},
    {p: 0, w: 0, c: 'FrameLayout', b: [0, 300, 1080, 520] as [number, number, number, number], f: 'cl'},
    {p: 2, w: 0, c: 'TextView', b: [180, 330, 400, 380] as [number, number, number, number], id: 'title', t: 'Ann'},
    {p: 2, w: 0, c: 'TextView', b: [180, 390, 900, 440] as [number, number, number, number], id: 'text', t: 'Are you there?'},
    {p: -1, w: 1, c: 'TextView', b: [100, 1500, 300, 1560] as [number, number, number, number], t: 'Ann'},
  ],
};

describe('push tap on android', () => {
  it('finds the notification in the shade, not the same name in the app behind it', () => {
    const r = shadeRow(SHADE, 'Ann');
    expect(r?.text.b).toEqual([180, 330, 400, 380]);
    expect(r?.row?.b).toEqual([0, 300, 1080, 520]);
    expect(shadeRow(SHADE, 'are you')?.text.b).toEqual([180, 390, 900, 440]);
    expect(shadeRow(SHADE, 'Bob')).toBeUndefined();
    expect(shadeRow({...SHADE, windows: [{type: 'app', title: '', pkg: 'com.example.app'}, SHADE.windows[1]!]}, 'Ann')).toBeUndefined();
  });

  /** A device whose shade opens the app when its row gets `opensOn` (a tap or an accessibility click). */
  const device = (opensOn: 'tap' | 'node-action' | 'nothing') => {
    const s = {front: false, shade: false, calls: [] as string[]};
    const dump = `  Notification List:\n    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=1 tag=t importance=4 key=0|com.example.app|1|t|1: Notification(channel=messages flags=AUTO_CANCEL vis=PRIVATE))\n          extras={\n                android.title=String (Ann)\n          }\n      mUpdateTimeMs=5\n  Notification attention state:\n`;
    const a = {
      shell: async (_serial: string, cmd: string) => {
        s.calls.push(cmd.split(' ').slice(0, 3).join(' '));
        if (cmd.startsWith('dumpsys notification')) return dump;
        if (cmd.includes('expand-notifications')) s.shade = true;
        if (cmd.includes('statusbar collapse')) s.shade = false;
        if (cmd.startsWith('pidof')) return `123\n---\n  topResumedActivity=ActivityRecord{1 u0 ${s.front ? 'com.example.app/.Main' : 'com.android.launcher3/.Launcher'}}\n---\nstopped=false`;
        return '';
      },
    };
    const open = () => {
      s.front = true;
      s.shade = false;
    };
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        s.calls.push(cmd);
        if (cmd === 'tree') return s.shade ? SHADE : {windows: [SHADE.windows[1]], nodes: [{...SHADE.nodes[5], w: 0}]};
        if (cmd === 'tap' && opensOn === 'tap' && args.y === 355) open();
        if (cmd === 'node-action' && opensOn === 'node-action') open();
        return {};
      },
    };
    const ui = {runner, screenChanged: () => undefined, snapshot: async () => ({lines: ['@e1 "Ann"']})};
    const center = new PushCenter({
      target: async () => ({platform: 'android', id: 'emulator-5554', a}) as never,
      online: async () => ({android: ['emulator-5554'], apple: []}),
      androidApp: () => 'com.example.app',
      ui: async () => ui as never,
    });
    return {s, center};
  };

  it('opens the shade, taps the notification by its title and lands in the app', {timeout: 20_000}, async () => {
    const {s, center} = device('tap');
    const r = await center.tap({});
    expect(r).toMatchObject({tapped: 'Ann', state: 'foreground', ok: true});
    expect(r.note).toBeUndefined();
    expect(s.calls).not.toContain('node-action');
  });

  it('clicks the row through accessibility when it takes no tap, and says so', {timeout: 20_000}, async () => {
    const {s, center} = device('node-action');
    const r = await center.tap({title: 'Ann'});
    expect(r).toMatchObject({state: 'foreground', ok: true});
    expect(r.note).toMatch(/accessibility/);
    expect(s.calls).toContain('node-action');
  });

  it('fails a tap that opened nothing and closes the shade', {timeout: 20_000}, async () => {
    const {s, center} = device('nothing');
    const r = await center.tap({});
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/did not come to the front/);
    expect(s.shade).toBe(false);
    await expect(center.tap({title: 'Bob'})).rejects.toThrow(/no notification "Bob" in the shade \(it shows: "12:00"/);
  });
});

describe('push command line', () => {
  it('maps send, raw payloads and sub-commands', () => {
    expect(toCall(parseArgs(['push', 'title=Hi', 'body=There', 'data={"a":"b=c"}', '--device', 'Pixel']))).toEqual({method: 'push', params: {action: 'send', device: 'Pixel', app: undefined, title: 'Hi', body: 'There', data: '{"a":"b=c"}'}});
    expect(toCall(parseArgs(['push', 'tap', 'New', 'message']))).toMatchObject({params: {action: 'tap', title: 'New message'}});
    expect(toCall(parseArgs(['push', 'clear', '--app', 'com.example.app']))).toMatchObject({params: {action: 'clear', app: 'com.example.app'}});
    expect(toCall(parseArgs(['push', 'bind', 'tok123']))).toMatchObject({params: {action: 'bind', token: 'tok123'}});
    const file = toCall(parseArgs(['push', 'file=payload.json'])).params.file as string;
    expect(file.endsWith('payload.json') && file !== 'payload.json').toBe(true);
  });
});

/** A push center that records what it was asked and answers like a delivered push, or as `answer` says. */
const fakeCenter = (route: (kind: string, token?: string) => string | undefined = () => 'dev1', answer?: (r: PushResult) => PushResult) => {
  const sent: {opts: PushOptions; source: string; token?: string}[] = [];
  const bound = new Map<string, string>();
  return {
    sent,
    bound,
    route: async (kind: 'apns' | 'fcm', token?: string) => ({device: route(kind, token)}),
    bind: (token: string, device: string) => void bound.set(token, device),
    send: async (opts: PushOptions, source = 'push', token?: string): Promise<PushResult> => {
      sent.push({opts, source, token});
      const r: PushResult = {id: 'm1', platform: 'android', device: opts.device!, app: opts.app ?? 'com.example.app', sent: 'x', ok: true, verdict: 'notification posted "T" — "B" · channel c'};
      return answer ? answer(r) : r;
    },
  };
};

describe('push gateway', () => {
  const apps = {android: 'com.example.app', apple: 'com.example.app'};

  it('takes an FCM v1 request and answers like FCM', async () => {
    const c = fakeCenter();
    const a = await handlePush(c, {method: 'POST', path: '/v1/projects/demo/messages:send', headers: {}, body: JSON.stringify({message: {token: 'tok', notification: {title: 'T'}}})}, apps);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({name: 'projects/demo/messages/m1'});
    expect(a.headers!['x-pitbox-verdict']).toBe('notification posted "T" - "B" | channel c');
    expect(c.sent[0]).toMatchObject({token: 'tok', source: 'gateway fcm', opts: {device: 'dev1', fcm: {token: 'tok', notification: {title: 'T'}}}});
  });

  it('takes an APNs request with its headers and refuses VoIP', async () => {
    const c = fakeCenter();
    const a = await handlePush(c, {method: 'POST', path: '/3/device/abc', headers: {'apns-topic': 'com.example.app', 'apns-collapse-id': 'k', 'content-type': 'application/json'}, body: '{"aps":{"alert":"hi"}}'}, apps);
    expect(a).toMatchObject({status: 200, headers: {'apns-id': 'm1'}});
    expect(c.sent[0]!.opts).toMatchObject({app: 'com.example.app', apnsHeaders: {'apns-topic': 'com.example.app', 'apns-collapse-id': 'k'}});
    const voip = await handlePush(c, {method: 'POST', path: '/3/device/abc', headers: {'apns-topic': 'com.example.app.voip'}, body: '{}'}, apps);
    expect(voip.status).toBe(400);
  });

  it('answers 503 when no device is online, and the legacy API with results', async () => {
    const none = fakeCenter(() => undefined);
    expect((await handlePush(none, {method: 'POST', path: '/v1/projects/p/messages:send', headers: {}, body: '{"message":{"token":"t"}}'}, apps)).status).toBe(503);
    const c = fakeCenter();
    const a = await handlePush(c, {method: 'POST', path: '/fcm/send', headers: {}, body: JSON.stringify({registration_ids: ['a', 'b'], data: {k: 'v'}})}, apps);
    expect(a.body).toMatchObject({success: 2, failure: 0, results: [{message_id: 'm1'}, {message_id: 'm1'}]});
  });

  it('serves HTTP/1.1 and HTTP/2 cleartext on one port', async () => {
    const c = fakeCenter();
    const port = await freePort();
    const g = new PushGateway(c, port, () => apps);
    await g.start();
    try {
      const h1 = await fetch(`http://127.0.0.1:${port}/push`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({title: 'T', token: 'x'})});
      expect(((await h1.json()) as PushResult).ok).toBe(true);
      // What an APNs client does: HTTP/2 with prior knowledge.
      const client = http2.connect(`http://127.0.0.1:${port}`);
      const status = await new Promise<number>((resolve, reject) => {
        const req = client.request({':method': 'POST', ':path': '/3/device/abc', 'apns-topic': 'com.example.app'});
        req.on('response', h => resolve(Number(h[':status'])));
        req.on('error', reject);
        req.end('{"aps":{"alert":"hi"}}');
      });
      client.close();
      expect(status).toBe(200);
      expect(c.sent.map(s => s.source)).toEqual(['gateway', 'gateway apns']);
    } finally {
      await g.stop();
    }
  });

  it('answers 200 when delivered but not shown, and a dead token only when the app cannot take pushes', async () => {
    const denied = fakeCenter(undefined, r => ({...r, ok: false, verdict: 'delivered, but notifications are off for the app'}));
    const fcm = {method: 'POST', path: '/v1/projects/p/messages:send', headers: {}, body: '{"message":{"token":"t","notification":{"title":"T"}}}'};
    expect((await handlePush(denied, fcm, apps)).status).toBe(200);
    const apnsReq = {method: 'POST', path: '/3/device/abc', headers: {'apns-topic': 'com.example.app'}, body: '{"aps":{"alert":"hi"}}'};
    expect((await handlePush(denied, apnsReq, apps)).status).toBe(200);

    const noFcm = fakeCenter(undefined, r => ({...r, ok: false, reason: 'unregistered', verdict: 'error no-fcm-service'}));
    const v1 = await handlePush(noFcm, fcm, apps);
    expect(v1.status).toBe(404);
    expect(JSON.stringify(v1.body)).toContain('UNREGISTERED');
    const missing = {...fakeCenter(), send: async () => Promise.reject(new PushUnregistered('com.example.app is not installed'))};
    expect(await handlePush(missing, apnsReq, apps)).toMatchObject({status: 400, body: {reason: 'BadDeviceToken'}});
    const legacy = await handlePush(missing, {method: 'POST', path: '/fcm/send', headers: {}, body: '{"to":"t","data":{"k":"v"}}'}, apps);
    expect(legacy.body).toMatchObject({success: 0, failure: 1, results: [{error: 'NotRegistered'}]});
    const broken = {...fakeCenter(), send: async () => Promise.reject(new Error('adb went away'))};
    expect((await handlePush(broken, fcm, apps)).status).toBe(500);
  });

  it('refuses payloads over 4 KB as APNs and FCM do', async () => {
    const c = fakeCenter();
    const big = 'x'.repeat(5000);
    const apnsBig = await handlePush(c, {method: 'POST', path: '/3/device/abc', headers: {'apns-topic': 'com.example.app'}, body: JSON.stringify({aps: {alert: big}})}, apps);
    expect(apnsBig).toMatchObject({status: 413, body: {reason: 'PayloadTooLarge'}});
    const fcmBig = await handlePush(c, {method: 'POST', path: '/v1/projects/p/messages:send', headers: {}, body: JSON.stringify({message: {token: 't', data: {big}}})}, apps);
    expect(fcmBig).toMatchObject({status: 400, body: {error: {status: 'INVALID_ARGUMENT'}}});
    expect(c.sent).toHaveLength(0);
  });

  it('binds a token sent with its device', async () => {
    const c = fakeCenter();
    await handlePush(c, {method: 'POST', path: '/push', headers: {}, body: JSON.stringify({token: 'tok', device: 'dev2', title: 'T'})}, apps);
    expect(c.bound.get('tok')).toBe('dev2');
  });

  it('refuses browser requests and non-JSON posts, and stops with an open HTTP/2 session', async () => {
    const c = fakeCenter();
    const port = await freePort();
    const g = new PushGateway(c, port, () => apps);
    await g.start();
    const client = http2.connect(`http://127.0.0.1:${port}`);
    try {
      const url = `http://127.0.0.1:${port}/push`;
      expect((await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', origin: 'https://evil.example'}, body: '{"title":"T"}'})).status).toBe(403);
      expect((await fetch(url, {method: 'POST', headers: {'content-type': 'text/plain'}, body: '{"title":"T"}'})).status).toBe(415);
      expect((await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: 'x'.repeat(70 * 1024)})).status).toBe(413);
      expect(c.sent).toHaveLength(0);
      // An APNs client keeps its session open; stop must not wait for it.
      await new Promise<void>((resolve, reject) => {
        const req = client.request({':method': 'GET', ':path': '/health'});
        req.on('response', () => resolve());
        req.on('error', reject);
        req.end();
      });
      client.on('error', () => undefined);
      const t0 = Date.now();
      await g.stop();
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(g.running).toBe(false);
    } finally {
      client.destroy();
      await g.stop();
    }
  });
});

describe('push input checks', () => {
  it('lets only package names through to the shell', () => {
    expect(() => assertPackage('com.example.app')).not.toThrow();
    expect(() => assertPackage('com.example.app_2')).not.toThrow();
    for (const bad of ['com.example.app; reboot', 'com.example.$(id)', 'app', '.com.example', 'com..example', "com.example'x"]) expect(() => assertPackage(bad), bad).toThrow();
  });
});
