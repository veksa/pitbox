// Notification responses without a device: the iOS command handed to a fake hook through a real folder and its answer
// read back, the Android notification's actions read from dumpsys and its button found in the shade, and the CLI.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {parseArgs, toCall} from './cli.ts';
import {formatResult} from './format.ts';
import {parseNotifications, pickAction, shadeButton, shadeRow} from './push/android.ts';
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
    // The hook's waits, shortened: the fake answers at once or never.
    hookWait: {waitMs: 200, afterLaunchMs: 300, takenMs: 300},
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
  });
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

  it("finds a messaging notification by the newest message the shade shows, not by its first text", () => {
    const messaging = `  Notification List:
    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=2 tag=m importance=4 key=0|com.example.app|2|m|1: Notification(channel=messages flags=AUTO_CANCEL actions=2 vis=PRIVATE))
          extras={
                android.title=String (Ann)
                android.text=String (Lunch?)
                android.messages=Parcelable[] (2)
                  [0] Bundle[{extras=Bundle[{}], sender_person=android.app.Person@1, sender=Ann, text=Lunch?, time=1000}]
                  [1] Bundle[{extras=Bundle[{}], text=On my way, time=2000}]
          }
      mUpdateTimeMs=2000
  Notification attention state:
`;
    const [n] = parseNotifications(messaging, 'com.example.app');
    expect(n).toMatchObject({title: 'Ann', text: 'Lunch?', messages: ['Lunch?', 'On my way']});
    const shade = {
      windows: [{pkg: 'com.android.systemui'}],
      nodes: [
        {p: -1, w: 0, b: [0, 100, 1080, 400] as [number, number, number, number], f: 'c'},
        {p: 0, w: 0, b: [40, 120, 400, 170] as [number, number, number, number], t: 'Ann'},
        {p: 0, w: 0, b: [40, 180, 900, 230] as [number, number, number, number], t: 'On my way'},
      ],
    };
    expect(shadeRow(shade, n!)?.row.b).toEqual([0, 100, 1080, 400]);
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
    // Given the notification's row, a button outside it (the next notification's) is not its own.
    expect(shadeButton(tree, {w: 0, b: [40, 100, 1040, 200]}, 'Reply', {w: 0, b: [0, 80, 1080, 210]})).toBeUndefined();
    expect(shadeButton(tree, {w: 0, b: [40, 100, 1040, 200]}, 'Reply', {w: 0, b: [0, 80, 1080, 320]})).toEqual({w: 0, b: [40, 220, 300, 300]});
  });

  /**
   * The app's two notifications in one group: 0, the group collapsed, only its own row takes a click; 1, the group
   * open, Bob's notification expanded with its button, Ann's collapsed above it; 2, Ann's expanded too. A swipe on a
   * row dismisses what it holds.
   */
  const groupedShade = () => {
    type B4 = [number, number, number, number];
    const rec = (id: number, title: string, text: string, at: number) =>
      `    NotificationRecord(0x${id}: pkg=com.example.app user=UserHandle{0} id=${id} tag=t${id} importance=4 key=0|com.example.app|${id}|t${id}|1: Notification(channel=messages flags=AUTO_CANCEL actions=2 vis=PRIVATE))\n          extras={\n                android.title=String (${title})\n                android.text=String (${text})\n          }\n          actions={\n            [0] "Mark as read" -> PendingIntent{1: PendingIntentRecord{2 com.example.app broadcastIntent}}\n          }\n      mUpdateTimeMs=${at}\n`;
    const GROUP: B4 = [0, 100, 1080, 700];
    const ANN: B4 = [0, 200, 1080, 400];
    const node = (p: number, b: B4, o: {t?: string; f?: string} = {}) => ({p, w: 0, c: 'View', b, ...o});
    const trees = [
      [node(-1, GROUP, {f: 'c'}), node(0, ANN), node(1, [40, 220, 400, 270], {t: 'Ann'}), node(1, [40, 280, 900, 330], {t: 'Lunch?'}), node(0, [0, 400, 1080, 700]), node(4, [40, 420, 400, 470], {t: 'Bob'}), node(4, [40, 480, 900, 530], {t: 'Call me'})],
      [node(-1, GROUP, {f: 'c'}), node(0, ANN, {f: 'c'}), node(1, [40, 220, 400, 270], {t: 'Ann'}), node(1, [40, 280, 900, 330], {t: 'Lunch?'}), node(0, [0, 400, 1080, 700], {f: 'c'}), node(4, [40, 420, 400, 470], {t: 'Bob'}), node(4, [40, 480, 900, 530], {t: 'Call me'}), node(4, [40, 600, 300, 680], {t: 'Mark as read', f: 'c'})],
      [node(-1, [0, 100, 1080, 800], {f: 'c'}), node(0, [0, 200, 1080, 500], {f: 'c'}), node(1, [40, 220, 400, 270], {t: 'Ann'}), node(1, [40, 280, 900, 330], {t: 'Lunch?'}), node(1, [40, 420, 300, 490], {t: 'Mark as read', f: 'c'}), node(0, [0, 500, 1080, 800], {f: 'c'}), node(5, [40, 520, 400, 570], {t: 'Bob'}), node(5, [40, 580, 900, 630], {t: 'Call me'}), node(5, [40, 700, 300, 780], {t: 'Mark as read', f: 'c'})],
    ];
    const st = {stage: 0, posted: ['Ann', 'Bob'], taps: [] as {x: number; y: number}[]};
    const a = {
      shell: async (_serial: string, cmd: string) => {
        if (cmd.startsWith('dumpsys notification')) return `  Notification List:\n${st.posted.includes('Ann') ? rec(1, 'Ann', 'Lunch?', 2000) : ''}${st.posted.includes('Bob') ? rec(2, 'Bob', 'Call me', 1000) : ''}  Notification attention state:\n`;
        if (cmd.startsWith('pidof')) return '123\n---\n  topResumedActivity=ActivityRecord{1 u0 com.android.launcher3/.Launcher}\n---\nstopped=false';
        return '';
      },
    };
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'tree') return {windows: [{pkg: 'com.android.systemui'}], nodes: trees[st.stage]};
        if (cmd === 'node-action') {
          const b = JSON.stringify(args.bounds);
          if (st.stage === 0 && b === JSON.stringify(GROUP)) st.stage = 1;
          else if (st.stage === 1 && b === JSON.stringify(ANN)) st.stage = 2;
        }
        if (cmd === 'tap') st.taps.push(args as {x: number; y: number});
        if (cmd === 'swipe') {
          const y = args.y1 as number;
          if (st.stage === 0 && y > GROUP[1] && y < GROUP[3]) st.posted = [];
          else if (y > ANN[1] && y < ANN[3]) st.posted = st.posted.filter(t => t !== 'Ann');
        }
        return {};
      },
    };
    const ui = {runner, screenChanged: () => undefined, snapshot: async () => ({lines: []})};
    const center = new PushCenter({
      target: async () => ({platform: 'android', id: 'emulator-5554', a}) as never,
      online: async () => ({android: ['emulator-5554'], apple: []}),
      androidApp: () => 'com.example.app',
      ui: async () => ui as never,
    });
    return {st, center};
  };

  it("expands a collapsed group, then the notification in it, and presses that notification's own button", {timeout: 20_000}, async () => {
    const {st, center} = groupedShade();
    const r = await center.respond({action: 'mark as read', title: 'Ann'});
    expect(r).toMatchObject({ok: true, answered: 'Mark as read', notification: 'Ann'});
    expect(st.stage).toBe(2);
    // Ann's own button, not Bob's that showed below her collapsed notification.
    expect(st.taps).toEqual([{x: 170, y: 455}]);
  });

  it('dismisses one notification of a collapsed group, not the whole group', {timeout: 20_000}, async () => {
    const {st, center} = groupedShade();
    const r = await center.respond({action: 'dismiss', title: 'Ann'});
    expect(r).toMatchObject({ok: true, verdict: 'dismissed "Ann"'});
    expect(st.posted).toEqual(['Bob']);
  });

  it('maps the command line', () => {
    expect(toCall(parseArgs(['push', 'respond', 'Reply', 'title=New', 'text=On my way']))).toMatchObject({method: 'push', params: {action: 'respond', value: 'Reply', title: 'New', text: 'On my way'}});
    expect(toCall(parseArgs(['push', 'respond']))).toMatchObject({params: {action: 'respond', value: undefined}});
  });
});
