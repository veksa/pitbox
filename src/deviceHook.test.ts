// A debug hook's exchange with an app on a physical device, where pitbox reaches the container one file at a time:
// the command copied in with a deadline, the answer copied back, the app launched when nobody answers, and a push
// turned into the hook's `deliver` command.

import {describe, expect, it} from 'vitest';
import type {HookFiles} from './drivers/apple/driver.ts';
import {deliverToHook, readLiveActivityState, type LiveActivityHost} from './push/liveactivity.ts';
import {PushCenter} from './push/push.ts';
import {notificationDir, notificationNotice} from './push/respond.ts';

const UDID = '00008150-0000000000000000';
const where = {dir: notificationDir, notice: notificationNotice('com.example.app')};

/** A device's container as a map of files, and an app whose hook answers each command it is notified of. */
const fakeDevice = (opts: {running: boolean}) => {
  const files = new Map<string, string>();
  const calls: string[] = [];
  let running = opts.running;
  const drain = () => {
    if (!running) return;
    for (const [rel, text] of [...files]) {
      const m = /^Library\/Caches\/pitbox\/notification\/in\/(.+)\.json$/.exec(rel);
      if (!m) continue;
      files.delete(rel);
      const cmd = JSON.parse(text) as {id: string; deadline: number; deliver?: {aps?: {alert?: {title?: string}}}};
      const late = cmd.deadline * 1000 < Date.now();
      files.set(`Library/Caches/pitbox/notification/out/${m[1]}.json`, JSON.stringify(late ? {ok: false, error: 'late'} : {ok: true, notification: cmd.id, title: cmd.deliver?.aps?.alert?.title}));
    }
  };
  const io: HookFiles = {
    put: async (rel, text) => void (calls.push(`put ${rel}`), files.set(rel, text)),
    get: async rel => files.get(rel),
  };
  const host: LiveActivityHost = {
    container: async () => {
      throw new Error('a device has no container on this disk');
    },
    notify: async (_udid, name) => void (calls.push(`notify ${name}`), drain()),
    launch: async () => void (calls.push('launch'), (running = true), drain()),
    files: udid => (udid === UDID ? io : undefined),
  };
  return {host, files, calls};
};

describe('a debug hook on a physical device', () => {
  it('copies the command in and the answer out, with a deadline the hook checks', async () => {
    const d = fakeDevice({running: true});
    const before = Date.now();
    const {outcome, launched} = await deliverToHook<{ok: boolean; title?: string}>(d.host, UDID, 'com.example.app', where, {id: 'p1', deliver: {aps: {alert: {title: 'Hi'}}}}, {waitMs: 500, afterLaunchMs: 500});
    expect(outcome).toEqual({ok: true, notification: 'p1', title: 'Hi'});
    expect(launched).toBe(false);
    expect(d.calls).toEqual(['put Library/Caches/pitbox/notification/in/p1.json', 'notify dev.pitbox.notification.com.example.app']);
    expect(Date.now() - before).toBeLessThan(2000);
  });

  it('launches the app when nobody answers, where the hook drains its folder', async () => {
    const d = fakeDevice({running: false});
    const {outcome, launched} = await deliverToHook<{ok: boolean}>(d.host, UDID, 'com.example.app', where, {id: 'p2', deliver: {aps: {alert: 'x'}}}, {waitMs: 300, afterLaunchMs: 500});
    expect(launched).toBe(true);
    expect(outcome?.ok).toBe(true);
    expect(d.calls).toContain('launch');
  });

  it('gives up without an answer when the app has no hook', async () => {
    const d = fakeDevice({running: false});
    d.host.launch = async () => void d.calls.push('launch');
    const {outcome, launched} = await deliverToHook(d.host, UDID, 'com.example.app', where, {id: 'p3'}, {waitMs: 200, afterLaunchMs: 200});
    expect(outcome).toBeUndefined();
    expect(launched).toBe(true);
    // The command stays in in/ with its deadline: a hook that starts later answers it as late, not applied.
    const left = JSON.parse(d.files.get('Library/Caches/pitbox/notification/in/p3.json')!) as {deadline: number};
    expect(left.deadline * 1000).toBeGreaterThan(Date.now());
    expect(left.deadline * 1000).toBeLessThan(Date.now() + 15_000);
  });
});

describe('push status and clear on a device', () => {
  const center = new PushCenter({
    target: async () => ({platform: 'apple', id: UDID, s: {} as never}),
    online: async () => ({android: [], apple: [UDID]}),
    appleApp: () => 'com.example.app',
    ui: async () => Promise.reject(new Error('no runner')),
  });

  it('names the hook as the way in, not simctl', async () => {
    const r = await center.status({});
    expect(r.lines[0]).toMatch(/notification hook \(PitboxNotifications/);
    expect(r.lines.join('\n')).not.toMatch(/simctl/);
    await expect(center.clear({})).rejects.toThrow(/unsupported on an iPhone or iPad/);
  });
});

describe('live activity state on a device', () => {
  it('copies the hook\'s state off the device, and reads none when the app has no hook', async () => {
    const files = new Map([['Library/Caches/pitbox/liveactivity/state.json', JSON.stringify({version: 1, types: ['DeliveryAttributes'], tokens: [], activities: []})]]);
    const host = {
      container: async () => Promise.reject(new Error('no simulator container on a device')),
      notify: async () => undefined,
      launch: async () => undefined,
      files: () => ({put: async () => undefined, get: async (rel: string) => files.get(rel)}),
    } as LiveActivityHost;
    expect((await readLiveActivityState(host, UDID, 'com.example.app'))?.types).toEqual(['DeliveryAttributes']);
    files.clear();
    expect(await readLiveActivityState(host, UDID, 'com.example.app')).toBeUndefined();
  });
});
