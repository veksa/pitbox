// Notification responses without a device: the iOS command handed to a fake hook through a real folder and its answer
// read back, the Android notification's actions read from dumpsys and its button found in the shade, and the CLI.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {parseArgs, toCall} from './cli.ts';
import {formatResult} from './format.ts';
import {parseNotifications, pickAction, shadeButton} from './push/android.ts';
import type {LiveActivityHost} from './push/liveactivity.ts';
import {PushCenter} from './push/push.ts';
import {notificationDir, notificationNotice, type NotificationResponseOutcome} from './push/respond.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

type Cmd = {id: string; action?: string; title?: string; text?: string; notification?: string};

/** A simulator whose app answers like PitboxNotifications (`running`: it takes a command before a launch). */
const fakeSim = (answer: (c: Cmd) => NotificationResponseOutcome | undefined, running = true) => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-nr-'));
  dirs.push(container);
  const dir = notificationDir(container);
  const seen: Cmd[] = [];
  const calls: string[] = [];
  let up = running;
  const drain = () => {
    if (!up) return;
    const inbox = path.join(dir, 'in');
    for (const f of fs.existsSync(inbox) ? fs.readdirSync(inbox).sort() : []) {
      const c = JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8')) as Cmd;
      fs.rmSync(path.join(inbox, f));
      seen.push(c);
      const o = answer(c);
      if (!o) continue;
      fs.mkdirSync(path.join(dir, 'out'), {recursive: true});
      fs.writeFileSync(path.join(dir, 'out', `${c.id}.json`), JSON.stringify(o));
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
  return {host, seen, calls};
};

const center = (host: LiveActivityHost) =>
  new PushCenter({
    target: async device => ({platform: 'apple', id: device ?? 'SIM-1', s: {} as never}),
    online: async () => ({android: [], apple: ['SIM-1']}),
    appleApp: () => 'com.example.app',
    ui: async () => Promise.reject(new Error('no runner')),
    liveActivity: () => host,
  });

describe('notification responses on iOS', () => {
  it('hands the action to the hook, brings the app forward for a foreground one, and reads the answer', async () => {
    const sim = fakeSim(c => ({ok: true, notification: 'n1', title: 'New message', action: c.action === 'Reply' ? 'REPLY' : c.action, foreground: false, completed: true, actions: ['REPLY "Reply"']}));
    const r = await center(sim.host).respond({action: 'Reply', title: 'New', text: 'On my way'});
    expect(sim.seen[0]).toMatchObject({action: 'Reply', title: 'New', text: 'On my way'});
    expect(sim.calls).toEqual([`notify ${notificationNotice('com.example.app')}`]);
    expect(r).toMatchObject({ok: true, answered: 'REPLY', notification: 'New message'});
    expect(formatResult('push', {action: 'respond', ...r})).toMatch(/^✓ answered with REPLY "New message" \(text "On my way"\) — the app's notification delegate got it$/);

    const open = fakeSim(() => ({ok: true, title: 'Hi', action: 'com.apple.UNNotificationDefaultActionIdentifier', foreground: true, completed: true}));
    const o = await center(open.host).respond({});
    expect(open.seen[0]!.action).toBe('open');
    expect(open.calls.at(-1)).toBe('launch');
    expect(o.verdict).toMatch(/^opened "Hi"/);
  });

  it('says which actions there are when the one asked for is not, and what to wire when no hook answers', async () => {
    const sim = fakeSim(() => ({ok: false, title: 'New message', error: 'the category MSG has no action "archive"', actions: ['REPLY "Reply"', 'READ "Mark as read"']}));
    const r = await center(sim.host).respond({action: 'archive'});
    expect(formatResult('push', {action: 'respond', ...r})).toBe('✗ the category MSG has no action "archive"\n  actions: REPLY "Reply", READ "Mark as read"');

    const none = fakeSim(() => undefined, false);
    const n = await center(none.host).respond({action: 'Reply'});
    expect(n.ok).toBe(false);
    expect(n.verdict).toMatch(/PitboxNotifications\.start\(\)/);
    // Launched once to let the hook drain; the command it never answered is taken back.
    expect(none.calls.filter(c => c === 'launch')).toHaveLength(1);
  }, 20_000);
});

describe('notification actions on Android', () => {
  const dump = `NOTIFICATION MANAGER (dumpsys notification)
  Notification List:
    NotificationRecord(0x0a1b2c3d: pkg=com.example.app user=UserHandle{0} id=3 tag=null importance=3 key=0|com.example.app|3|null|10213: Notification(channel=messages shortcut=null contentView=null vibrate=null sound=null defaults=0 flags=AUTO_CANCEL color=0x00000000 actions=2 vis=PRIVATE))
      uid=10213 userId=0
          extras={
                android.title=String (New message)
                android.text=String (From Ann)
          }
          actions={
            [0] "Reply" -> PendingIntent{1234abc: PendingIntentRecord{5678 com.example.app broadcastIntent}}
            [1] "Mark as read" -> PendingIntent{9abc: PendingIntentRecord{def0 com.example.app broadcastIntent}}
          }
      mUpdateTimeMs=2000
  Notification attention state:
`;

  it('reads the action titles of a posted notification and picks one by title', () => {
    const [n] = parseNotifications(dump, 'com.example.app');
    expect(n).toMatchObject({title: 'New message', text: 'From Ann', actions: ['Reply', 'Mark as read'], updated: 2000});
    expect(pickAction(n!.actions!, 'mark as read')).toBe('Mark as read');
    expect(pickAction(n!.actions!, 'read')).toBe('Mark as read');
    expect(pickAction(n!.actions!, 'archive')).toBeUndefined();
  });

  it("finds the button nearest below the notification's text, not another notification's of the same name", () => {
    const tree = {
      windows: [{pkg: 'com.android.systemui'}, {pkg: 'com.example.app'}],
      nodes: [
        {p: -1, w: 1, b: [0, 0, 1080, 2400] as [number, number, number, number], t: 'REPLY', f: 'c'},
        {p: -1, w: 0, b: [40, 100, 1040, 200] as [number, number, number, number], t: 'Order shipped'},
        {p: -1, w: 0, b: [40, 220, 300, 300] as [number, number, number, number], t: 'Reply', f: 'c'},
        {p: -1, w: 0, b: [40, 400, 1040, 500] as [number, number, number, number], t: 'New message'},
        {p: -1, w: 0, b: [40, 520, 300, 600] as [number, number, number, number], t: 'REPLY', f: 'c'},
      ],
    };
    expect(shadeButton(tree, {w: 0, b: [40, 400, 1040, 500]}, 'Reply')).toEqual({w: 0, b: [40, 520, 300, 600]});
    expect(shadeButton(tree, {w: 0, b: [40, 400, 1040, 500]}, 'Archive')).toBeUndefined();
  });

  it('maps the command line', () => {
    expect(toCall(parseArgs(['push', 'respond', 'Reply', 'title=New', 'text=On my way']))).toMatchObject({method: 'push', params: {action: 'respond', value: 'Reply', title: 'New', text: 'On my way'}});
    expect(toCall(parseArgs(['push', 'respond']))).toMatchObject({params: {action: 'respond', value: undefined}});
  });
});
