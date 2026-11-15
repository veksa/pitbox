// Live Activities on a simulator without a simulator: a push recognised and checked as the system checks it, the
// command handed to a fake hook through a real folder, the token routed by the hook's state, and the gateway's
// answers (200, 410 Unregistered, 404 UNREGISTERED, 500 with no hook, 503 with no simulator).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {parseArgs, toCall} from './cli.ts';
import {handlePush} from './push/gateway.ts';
import {deliverLiveActivity, isLiveActivity, liveActivityDir, liveActivityProblem, parseLiveActivity, type LiveActivityCommand, type LiveActivityHost, type LiveActivityOutcome, type LiveActivityState} from './push/liveactivity.ts';
import {liveActivityOf, PushCenter} from './push/push.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

const start = {aps: {timestamp: 1700000000, event: 'start', 'attributes-type': 'DeliveryAttributes', attributes: {order: '42'}, 'content-state': {status: 'Packed', progress: 0.2}, alert: {title: 'Order 42', body: 'Packed'}}};

/**
 * A simulator with an app whose hook answers like PitboxLiveActivity: commands read from in/, answers written to
 * out/. `running` is whether the app takes a command before it is launched (it is in front, not suspended).
 */
const fakeSim = (state: LiveActivityState | undefined, opts: {running?: boolean; answer?: (c: LiveActivityCommand) => LiveActivityOutcome} = {}) => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-la-'));
  dirs.push(container);
  const dir = liveActivityDir(container);
  if (state) {
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  }
  const seen: LiveActivityCommand[] = [];
  const calls: string[] = [];
  let up = opts.running ?? true;
  const drain = () => {
    if (!up) return;
    const inbox = path.join(dir, 'in');
    for (const f of fs.existsSync(inbox) ? fs.readdirSync(inbox).sort() : []) {
      const c = JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8')) as LiveActivityCommand;
      fs.rmSync(path.join(inbox, f));
      seen.push(c);
      fs.mkdirSync(path.join(dir, 'out'), {recursive: true});
      fs.writeFileSync(path.join(dir, 'out', `${c.id}.json`), JSON.stringify(opts.answer?.(c) ?? {ok: true, activityId: c.activityId ?? 'A-NEW', token: c.event === 'start' ? 'ab'.repeat(32) : undefined}));
    }
  };
  const host: LiveActivityHost = {
    container: async () => container,
    notify: async (_u, name) => {
      calls.push(`notify ${name}`);
      drain();
    },
    launch: async () => {
      calls.push('launch');
      up = true;
      drain();
    },
  };
  return {host, seen, calls, container};
};

const state = (extra: Partial<LiveActivityState> = {}): LiveActivityState => ({
  version: 1,
  types: ['DeliveryAttributes'],
  tokens: [
    {token: 'aa'.repeat(32), kind: 'start', type: 'DeliveryAttributes'},
    {token: 'bb'.repeat(32), kind: 'activity', type: 'DeliveryAttributes', activityId: 'A1'},
  ],
  activities: [{id: 'A1', type: 'DeliveryAttributes', state: 'active'}],
  ...extra,
});

const center = (host: LiveActivityHost | undefined, online: string[] = ['SIM-1']) =>
  new PushCenter({
    target: async device => ({platform: 'apple', id: device ?? online[0]!, s: {} as never}),
    online: async () => ({android: [], apple: online}),
    appleApp: () => 'com.example.app',
    ui: async () => Promise.reject(new Error('no runner')),
    liveActivity: () => host,
  });

describe('live activity pushes', () => {
  it('recognises one by its push type, its topic or its aps, and reads its fields', () => {
    expect(isLiveActivity({aps: {}}, {'apns-push-type': 'liveactivity'})).toBe(true);
    expect(isLiveActivity({aps: {}}, {'apns-topic': 'com.example.app.push-type.liveactivity'})).toBe(true);
    expect(isLiveActivity(start)).toBe(true);
    expect(isLiveActivity({aps: {alert: 'hi'}})).toBe(false);
    expect(parseLiveActivity({aps: {...start.aps, 'stale-date': 1700003600, 'dismissal-date': 1700000100, 'relevance-score': 50}})).toMatchObject({event: 'start', type: 'DeliveryAttributes', attributes: {order: '42'}, state: {status: 'Packed'}, staleDate: 1700003600, dismissalDate: 1700000100, relevanceScore: 50, alert: {title: 'Order 42', body: 'Packed'}});
  });

  it('says why the system would drop one', () => {
    expect(liveActivityProblem(parseLiveActivity(start))).toBeUndefined();
    expect(liveActivityProblem(parseLiveActivity({aps: {event: 'update', 'content-state': {}}}))).toMatch(/timestamp/);
    expect(liveActivityProblem(parseLiveActivity({aps: {timestamp: 1, event: 'update'}}))).toMatch(/content-state/);
    expect(liveActivityProblem(parseLiveActivity({aps: {timestamp: 1, event: 'start', 'content-state': {}}}))).toMatch(/attributes-type/);
    expect(liveActivityProblem(parseLiveActivity({aps: {timestamp: 1, event: 'end'}}))).toBeUndefined();
    expect(liveActivityProblem(parseLiveActivity({aps: {timestamp: 1, event: 'pause', 'content-state': {}}}))).toMatch(/none of/);
  });

  it('finds one in a firebase-admin message by its live activity token', () => {
    const la = liveActivityOf({fcm: {token: 'pitbox-ios-1', apns: {liveActivityToken: 'bb', payload: {aps: {timestamp: 1, event: 'update', 'content-state': {status: 'x'}}}}}});
    expect(la).toMatchObject({token: 'bb', push: {event: 'update', state: {status: 'x'}}});
    expect(liveActivityOf({fcm: {notification: {title: 'T'}}})).toBeUndefined();
    expect(liveActivityOf({apns: start})?.push.type).toBe('DeliveryAttributes');
  });
});

describe('live activity delivery', () => {
  it('launches the app for a start, and only when it does not answer for an update', async () => {
    const s = fakeSim(state(), {running: false});
    const r = await deliverLiveActivity(s.host, 'SIM-1', 'com.example.app', {id: 'm1', event: 'start', type: 'DeliveryAttributes', state: {}}, {waitMs: 300});
    expect(r).toMatchObject({launched: true, outcome: {ok: true}});
    expect(s.calls).toEqual(['launch', 'notify dev.pitbox.liveactivity.com.example.app']);
    const sleeping = fakeSim(state(), {running: false});
    const u = await deliverLiveActivity(sleeping.host, 'SIM-1', 'com.example.app', {id: 'm2', event: 'update', activityId: 'A1', state: {}}, {waitMs: 300});
    expect(u.launched).toBe(true);
    expect(sleeping.calls[0]).toMatch(/^notify/);
    const awake = fakeSim(state());
    expect((await deliverLiveActivity(awake.host, 'SIM-1', 'com.example.app', {id: 'm3', event: 'update', activityId: 'A1', state: {}}, {waitMs: 300})).launched).toBe(false);
  });

  it('resolves the activity from its token, refuses the wrong kind of token, and answers in one line', async () => {
    const s = fakeSim(state());
    const c = center(s.host);
    const upd = await c.send({apns: {aps: {timestamp: 2, event: 'update', 'content-state': {status: 'x'}}}, liveActivityToken: 'BB'.repeat(32), fromGateway: true}, 'gateway apns');
    expect(upd).toMatchObject({ok: true, verdict: 'Live Activity updated (stand-in) · DeliveryAttributes A1'});
    expect(s.seen[0]).toMatchObject({event: 'update', activityId: 'A1', type: 'DeliveryAttributes'});
    const wrong = await c.send({apns: {aps: {timestamp: 3, event: 'update', 'content-state': {}}}, liveActivityToken: 'aa'.repeat(32)});
    expect(wrong).toMatchObject({ok: false, verdict: expect.stringMatching(/push-to-start token/)});
    const started = await c.send({apns: start, liveActivityToken: 'aa'.repeat(32)});
    expect(started.verdict).toMatch(/^Live Activity started \(stand-in\) · DeliveryAttributes A-NEW · token abababab…abab$/);
    expect(started.notes).toEqual([expect.stringMatching(/brought to the front for Activity.request/), "a start's alert is not shown by the stand-in"]);
    const dead = await c.send({apns: start, liveActivityToken: 'cc'.repeat(32)});
    expect(dead).toMatchObject({ok: false, reason: 'unregistered'});
  });

  it('takes the only running activity when none is named, and says what the hook could not do', async () => {
    const s = fakeSim(state(), {answer: c => (c.event === 'end' ? {ok: false, error: 'no running DeliveryAttributes activity A1'} : {ok: true, activityId: 'A1'})});
    const c = center(s.host);
    expect((await c.activity({event: 'update', state: '{"status":"y"}'})).verdict).toMatch(/updated/);
    expect((await c.activity({event: 'end', dismissal: 0})).verdict).toBe('the hook could not end it: no running DeliveryAttributes activity A1');
    expect(s.seen[1]!.dismissalDate).toBeGreaterThan(1.7e9);
    await expect(center(fakeSim(state({activities: []})).host).activity({event: 'update', state: '{}'})).rejects.toThrow(/no activity/);
    expect((await c.activity({event: 'start', type: 'Other', state: '{}'})).verdict).toMatch(/Other is not registered/);
  });

  it('answers an app with no hook, and an Android device, without delivering', async () => {
    const none = center(fakeSim(undefined).host);
    expect(await none.send({apns: start})).toMatchObject({ok: false, reason: 'nohook'});
    const android = new PushCenter({target: async () => ({platform: 'android', id: 'emulator-5554', a: {} as never}), online: async () => ({android: ['emulator-5554'], apple: []}), androidApp: () => 'com.example.app', ui: async () => Promise.reject(new Error('x'))});
    expect((await android.send({apns: start})).verdict).toMatch(/iOS-only/);
  });

  it('routes a token to the simulator whose app reports it', async () => {
    const one = fakeSim(state({tokens: []}));
    const two = fakeSim(state());
    const c = new PushCenter({
      target: async () => Promise.reject(new Error('unused')),
      online: async () => ({android: [], apple: ['SIM-1', 'SIM-2']}),
      appleApp: () => 'com.example.app',
      ui: async () => Promise.reject(new Error('unused')),
      liveActivity: () => ({...one.host, container: async udid => (udid === 'SIM-1' ? one.container : two.container)}),
    });
    expect(await c.routeActivity('bb'.repeat(32))).toEqual({device: 'SIM-2'});
    expect(await c.routeActivity('dd'.repeat(32))).toEqual({dead: 'unregistered'});
    expect(await center(fakeSim(undefined).host).routeActivity('bb')).toEqual({dead: 'nohook'});
    expect(await center(fakeSim(state()).host, []).routeActivity('bb')).toEqual({});
  });
});

describe('live activities through the gateway', () => {
  const fake = (route: Awaited<ReturnType<PushCenter['routeActivity']>>, reason?: 'unregistered' | 'nohook') => ({
    sent: [] as unknown[],
    route: async () => ({device: 'SIM-1'}),
    bind: () => undefined,
    routeActivity: async () => route,
    send: async (opts: unknown) => ({id: 'm1', platform: 'apple' as const, device: 'SIM-1', app: 'com.example.app', sent: 'x', ok: !reason, verdict: reason ? 'no' : 'Live Activity updated (stand-in) · DeliveryAttributes A1', ...(reason ? {reason} : {})}),
  });
  const req = {method: 'POST', path: `/3/device/${'bb'.repeat(32)}`, headers: {'apns-topic': 'com.example.app.push-type.liveactivity', 'apns-push-type': 'liveactivity'}, body: JSON.stringify({aps: {timestamp: 1, event: 'update', 'content-state': {}}})};

  it('answers as APNs does for a Live Activity token', async () => {
    expect(await handlePush(fake({device: 'SIM-1'}), req, {})).toMatchObject({status: 200, headers: {'apns-id': 'm1'}});
    expect(await handlePush(fake({dead: 'unregistered'}), req, {})).toMatchObject({status: 410, body: {reason: 'Unregistered'}});
    expect((await handlePush(fake({dead: 'nohook'}), req, {})).status).toBe(500);
    expect((await handlePush(fake({}), req, {})).status).toBe(503);
    expect((await handlePush(fake({device: 'SIM-1'}, 'unregistered'), req, {})).status).toBe(410);
  });
});

describe('push activity on the command line', () => {
  it('maps the event and the fields', () => {
    expect(toCall(parseArgs(['push', 'activity', 'start', 'type=DeliveryAttributes', 'attributes={"order":"1"}', 'state={"a":1}']))).toMatchObject({params: {action: 'activity', event: 'start', type: 'DeliveryAttributes', attributes: '{"order":"1"}', state: '{"a":1}'}});
    expect(toCall(parseArgs(['push', 'activities']))).toMatchObject({params: {action: 'activities'}});
  });
});
