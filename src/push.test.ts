// Push emulation without a device: payloads in and out, the dumpsys parser, the CLI and the stand's gateway.

import http2 from 'node:http2';
import {describe, expect, it} from 'vitest';
import {parseArgs, toCall} from './cli.ts';
import {parseBroadcast, parseNotifications} from './push/android.ts';
import {handlePush, PushGateway} from './push/gateway.ts';
import {fromApns, fromFcm, fromPayloadFile, toApns, toFcmExtras, toMessage} from './push/payload.ts';
import type {PushOptions, PushResult} from './push/push.ts';
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

/** A push center that records what it was asked and answers like a delivered push. */
const fakeCenter = (route: (kind: string, token?: string) => string | undefined = () => 'dev1') => {
  const sent: {opts: PushOptions; source: string; token?: string}[] = [];
  return {
    sent,
    route: async (kind: 'apns' | 'fcm', token?: string) => route(kind, token),
    send: async (opts: PushOptions, source = 'push', token?: string): Promise<PushResult> => {
      sent.push({opts, source, token});
      return {id: 'm1', platform: 'android', device: opts.device!, app: opts.app ?? 'com.example.app', sent: 'x', ok: true, verdict: 'notification posted "T" — "B" · channel c'};
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
      const h1 = await fetch(`http://127.0.0.1:${port}/push`, {method: 'POST', body: JSON.stringify({title: 'T', token: 'x'})});
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
});
