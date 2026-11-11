// Home-screen widgets of the app under test: added from the launcher's own widget picker and removed the way a
// person does it, through the device's UI session — by elements of the launcher's tree, never by fixed points.
// Android: Launcher3 and the launchers built on it (AOSP Launcher3, Pixel Launcher). iOS and iPadOS (SpringBoard):
// written, refused until it is checked on a simulator.
// Everything else is refused with the launcher's name instead of being tapped at blindly.

import type {DeviceUi} from './device.ts';
import {tokenize, unquote} from '../flows/flow.ts';
import {interactive, tapPoint, type Bounds, type Snapshot, type UiNode} from './snapshot.ts';

export const WIDGET_USAGE = 'widget add <name> [app=<label>] [size=<WxH|small|medium|large|extra large>] | widget remove <name> | widget list [app]';

export type WidgetOp = {op: 'add' | 'remove' | 'list'; name?: string; app?: string; size?: string};

/** `add "World clock" app=Clock size=4x2` → the operation; `app` and `size` may also come as their own params. */
export const parseWidget = (value: string, extra: {app?: string; size?: string} = {}): WidgetOp => {
  const [op, ...rest] = tokenize(value.trim());
  let {app, size} = extra;
  const words: string[] = [];
  for (const t of rest) {
    const m = /^(app|size)=(.*)$/s.exec(t);
    if (m?.[1] === 'app') app = unquote(m[2]!);
    else if (m?.[1] === 'size') size = unquote(m[2]!);
    else words.push(unquote(t));
  }
  if (op !== 'add' && op !== 'remove' && op !== 'list') throw new Error(WIDGET_USAGE);
  const name = words.join(' ').trim() || undefined;
  if (op === 'list') return {op, app: app || name};
  if (!name) throw new Error(`widget ${op} needs the widget's name\n${WIDGET_USAGE}`);
  return {op, name, ...(app ? {app} : {}), ...(size ? {size: normSize(size)} : {})};
};

const normSize = (s: string) => s.trim().toLowerCase().replace(/\s*[×x*]\s*/, 'x').replace(/\s+/g, ' ');

const norm = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const say = (n: UiNode) => (n.d ?? n.t ?? '').replace(/\s+/g, ' ').trim();
const same = (a?: string, b?: string) => (a ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === (b ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const area = (b: Bounds) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const centre = (b: Bounds) => ({x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2)});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const inside = (b: Bounds, outer: Bounds) => b[0] >= outer[0] && b[1] >= outer[1] && b[2] <= outer[2] && b[3] <= outer[3];

/** One widget the picker offers: the node to press and what it says about itself. */
export type PickerEntry = {index: number; name: string; size: string};

// Launcher3's label of a widget in its picker: "Analog widget, 3 wide by 2 high" and the description after it.
const ENTRY = /^(.+?) widget, (\d+) wide by (\d+) high\b/i;

/**
 * The widgets the Android picker shows. A cell reads "<Name> widget, W wide by H high …" (Android 12 and later);
 * an older cell has no such label and is read from its name and size views (`widget_name`, `widget_dims` "4 × 2").
 */
export const pickerEntries = (snap: Pick<Snapshot, 'nodes'>): PickerEntry[] => {
  const out: PickerEntry[] = [];
  const seen = new Set<string>();
  const add = (index: number, name: string, size: string) => {
    const key = `${name.toLowerCase()} ${size}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({index, name, size});
  };
  snap.nodes.forEach((n, i) => {
    const m = ENTRY.exec(say(n));
    if (m) add(i, m[1]!, `${m[2]}x${m[3]}`);
  });
  snap.nodes.forEach(n => {
    if (n.id !== 'widget_name' || !n.t) return;
    // The cell: the nearest ancestor that holds the size too; pressed and dragged by its preview when it has one.
    let size: string | undefined;
    for (let k = n.p, hops = 0; k >= 0 && hops < 6; k = snap.nodes[k]!.p, hops++) {
      const dims = size ? undefined : snap.nodes.find(m => m.id === 'widget_dims' && m.t && inAncestry(snap.nodes, m, k));
      const wh = dims && /(\d+)\s*[×x]\s*(\d+)/.exec(dims.t!);
      if (wh) size = `${wh[1]}x${wh[2]}`;
      if (!size) continue;
      const preview = snap.nodes.findIndex(m => /^widget_preview/.test(m.id ?? '') && inAncestry(snap.nodes, m, k));
      if (preview >= 0 || hops >= 3) {
        add(preview >= 0 ? preview : k, n.t, size);
        break;
      }
    }
  });
  return out;
};

const inAncestry = (nodes: UiNode[], n: UiNode, ancestor: number) => {
  for (let k = n.p, hops = 0; k >= 0 && hops < 64; k = nodes[k]!.p, hops++) if (k === ancestor) return true;
  return false;
};

/** The entry for a widget by its name (and size, "4x2"); with no size, the first one the picker lists. */
export const pickEntry = (entries: PickerEntry[], name: string, size?: string): PickerEntry | undefined =>
  entries.find(e => same(e.name, name) && (!size || e.size === size));

/**
 * A widget on the home screen: a view whose label is the widget's name and that has no text of its own (an app
 * icon of the same name carries the name as its text). Android labels the host view with the widget's name.
 */
export const homeWidget = (snap: Pick<Snapshot, 'nodes' | 'windows'>, name: string): number | undefined => {
  const i = snap.nodes.findIndex(n => !n.t && same(n.d, name) && snap.windows[n.w]?.type === 'app' && n.id !== 'accessibility_action_view');
  return i >= 0 ? i : undefined;
};

/** The labels of the widgets on the home page on screen. */
export const homeWidgets = (snap: Pick<Snapshot, 'nodes'>, workspace: Bounds): string[] => {
  const out: string[] = [];
  const found: UiNode[] = [];
  for (const n of snap.nodes) {
    if (n.t || !n.d || n.id || !inside(n.b, workspace)) continue;
    // A widget spans at least two cells: an icon's own label sits on a small button.
    if (area(n.b) < area(workspace) * 0.03 || area(n.b) > area(workspace) * 0.8) continue;
    if (/^(home|at a glance)$/i.test(n.d) || ENTRY.test(n.d)) continue;
    found.push(n);
  }
  // A widget's own views can carry labels too: only the outermost labelled view is the widget.
  for (const n of found) if (!found.some(m => m !== n && inside(n.b, m.b) && area(m.b) > area(n.b)) && !out.includes(n.d!)) out.push(n.d!);
  return out;
};

/**
 * A spot on a home page with nothing on it, for a long press that opens the home screen's menu or for a dropped
 * widget: the point of `region` farthest from every icon, widget and bar inside it. Undefined when every point
 * is on something.
 */
export const freeSpot = (snap: Pick<Snapshot, 'nodes' | 'windows'>, region: Bounds, opts: {top?: number} = {}): {x: number; y: number} | undefined => {
  const [l, t0, r, b] = region;
  const t = Math.max(t0, opts.top ?? t0 + Math.round((b - t0) * 0.06));
  const big = area(region) * 0.5;
  const things = snap.nodes
    .filter(n => snap.windows[n.w]?.type === 'app' && area(n.b) > 0 && area(n.b) < big && (interactive(n) || n.t || n.d || n.id))
    .map(n => n.b)
    .filter(nb => nb[0] < r && nb[2] > l && nb[1] < b && nb[3] > t);
  const gap = (x: number, y: number) => Math.min(...things.map(nb => Math.hypot(Math.max(nb[0] - x, 0, x - nb[2]), Math.max(nb[1] - y, 0, y - nb[3]))), Infinity);
  let best: {x: number; y: number; d: number} | undefined;
  const cols = 8;
  const rows = 12;
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = Math.round(l + ((r - l) * (cx + 0.5)) / cols);
      const y = Math.round(t + ((b - t) * (ry + 0.5)) / rows);
      // Away from the screen's edges, where a press starts a system gesture.
      const edge = Math.min(x - l, r - x);
      const d = Math.min(gap(x, y), edge);
      if (d > 0 && (!best || d > best.d)) best = {x, y, d};
    }
  }
  return best && best.d >= 24 ? {x: best.x, y: best.y} : undefined;
};

/** The header of an app's widgets in the picker (Launcher3 `widgets_list_header`, with its `app_title`). */
export const pickerHeader = (snap: Pick<Snapshot, 'nodes'>, app: string): number | undefined => {
  const headers = snap.nodes.flatMap((n, i) => (n.id === 'widgets_list_header' ? [i] : []));
  const titled = headers.find(h => snap.nodes.some(m => (m.id === 'app_title' || !m.id) && same(m.t, app) && inAncestry(snap.nodes, m, h)));
  if (titled !== undefined) return titled;
  // A two-pane picker (tablets) lists apps as rows of their own: the row whose title is the app.
  const title = snap.nodes.findIndex(n => same(n.t, app) && !(n.f ?? '').includes('e'));
  if (title < 0) return headers.length === 1 ? headers[0] : undefined;
  for (let k = title, hops = 0; k >= 0 && hops < 4; k = snap.nodes[k]!.p, hops++) if (interactive(snap.nodes[k]!)) return k;
  return title;
};

type Done = Record<string, unknown>;

/** Runs the steps without recording each into a flow being recorded: the recording gets the one widget step. */
const asOneStep = async <T>(ui: DeviceUi, line: string, run: () => Promise<T>): Promise<T> => {
  const recording = ui.recording;
  ui.recording = undefined;
  try {
    return await run();
  } finally {
    ui.recording = recording;
    ui.recording?.push(line);
  }
};

const stepLine = (w: WidgetOp) =>
  `widget ${w.op}${w.name ? ` ${JSON.stringify(w.name)}` : ''}${w.app && w.op !== 'list' ? ` app=${JSON.stringify(w.app)}` : w.app ? ` ${JSON.stringify(w.app)}` : ''}${w.size ? ` size=${JSON.stringify(w.size)}` : ''}`;

/** A snapshot once two in a row agree, bounds included: a page that is still sliding moves what a finger would hold. */
const steady = async (ui: DeviceUi, ms = 2000): Promise<Snapshot> => {
  const end = Date.now() + ms;
  const shape = (s: Snapshot) => s.nodes.map(n => n.b.join(',')).join(';');
  let snap = await ui.snapshot();
  for (;;) {
    await sleep(200);
    const next = await ui.snapshot();
    if (shape(next) === shape(snap) || Date.now() > end) return next;
    snap = next;
  }
};

/** Polls fresh snapshots until `test` holds, or gives up after `ms`. */
const until = async <T>(ui: DeviceUi, ms: number, test: (s: Snapshot) => T | undefined): Promise<{snap: Snapshot; hit?: T}> => {
  const end = Date.now() + ms;
  for (;;) {
    const snap = await ui.snapshot();
    const hit = test(snap);
    if (hit !== undefined && hit !== false) return {snap, hit};
    if (Date.now() > end) return {snap};
    await sleep(250);
  }
};

const idOf = (snap: Snapshot, id: string) => {
  const i = snap.nodes.findIndex(n => n.id === id);
  return i >= 0 ? i : undefined;
};

const point = (snap: Snapshot, i: number) => {
  const p = tapPoint(snap, i);
  return `${p.x},${p.y}`;
};

// ———————————————————————————————————————— Android ————————————————————————————————————————

const LAUNCHER3 = 'widget works on Launcher3 and the launchers built on it (AOSP Launcher3, Pixel Launcher)';

const launcherPkg = (snap: Snapshot) => snap.windows.find(w => w.type === 'app')?.pkg ?? 'unknown';

/** The home screen of a Launcher3-family launcher, or the reason there is none to drive. */
const androidHome = async (ui: DeviceUi): Promise<{snap: Snapshot; workspace: Bounds; pkg: string}> => {
  await ui.key(['home']);
  let {snap, hit} = await until(ui, 3000, s => idOf(s, 'workspace'));
  // Launcher3 keeps its workspace out of the accessibility tree for a moment after a drag or an undo bar: its
  // own frame (`launcher`, `drag_layer`) is there, and the page comes back.
  if (hit === undefined && snap.nodes.some(n => n.id === 'launcher' || n.id === 'drag_layer')) {
    await ui.key(['home']);
    ({snap, hit} = await until(ui, 6000, s => idOf(s, 'workspace')));
  }
  if (hit === undefined) {
    throw new Error(`launcher ${launcherPkg(snap)} is not supported: ${LAUNCHER3}, and this one shows no Launcher3 workspace on the home screen`);
  }
  return {snap, workspace: snap.nodes[hit]!.b, pkg: snap.windows[snap.nodes[hit]!.w]?.pkg ?? 'unknown'};
};

/** Opens the widget picker from the home screen's menu (a long press on an empty spot, then "Widgets"). */
const androidPicker = async (ui: DeviceUi): Promise<{snap: Snapshot; pkg: string; workspace: Bounds}> => {
  const home = await androidHome(ui);
  const spot = freeSpot(home.snap, home.workspace);
  if (!spot) throw new Error('no empty spot on the home screen to long-press for its menu\nhint: move an icon off the first home page, or open the widget picker by hand');
  await ui.press(`${spot.x},${spot.y}`, 'longpress');
  const menu = await until(ui, 3000, s => s.nodes.findIndex(n => same(n.t ?? n.d, 'widgets')) + 1 || undefined);
  if (menu.hit === undefined) throw new Error(`a long press on the home screen at ${spot.x},${spot.y} showed no "Widgets" item (launcher ${home.pkg})`);
  await ui.press(point(menu.snap, menu.hit - 1));
  const picker = await until(ui, 5000, s => idOf(s, 'widgets_search_bar_edit_text') ?? (pickerEntries(s).length || s.nodes.some(n => n.id === 'widgets_list_header') ? -1 : undefined));
  if (picker.hit === undefined) throw new Error(`"Widgets" opened no widget picker (launcher ${home.pkg})`);
  return {snap: picker.snap, pkg: home.pkg, workspace: home.workspace};
};

/** Narrows the picker to one app and opens its widgets; the snapshot shows them. */
const androidAppWidgets = async (ui: DeviceUi, app: string, want?: (s: Snapshot) => boolean): Promise<Snapshot> => {
  let snap = (await until(ui, 0, () => true)).snap;
  const search = idOf(snap, 'widgets_search_bar_edit_text');
  if (search !== undefined) {
    await ui.fill('id=widgets_search_bar_edit_text', app);
    // The keyboard would cover the list, and a press by text could land on its suggestion strip.
    if ((await ui.snapshot()).windows.some(w => w.type === 'ime')) await ui.key(['back']);
    snap = (await until(ui, 2000, s => (pickerHeader(s, app) !== undefined || pickerEntries(s).length ? true : undefined))).snap;
  }
  const shows = (s: Snapshot) => (want ? want(s) : pickerEntries(s).length > 0);
  if (!shows(snap)) {
    let header = pickerHeader(snap, app);
    if (header === undefined && search === undefined) {
      // An older picker without search: every app's widgets in one long list.
      snap = await scrollPicker(ui, s => pickerHeader(s, app) !== undefined || shows(s));
      header = pickerHeader(snap, app);
    }
    if (!shows(snap) && header !== undefined) {
      await ui.press(point(snap, header));
      snap = (await until(ui, 2000, s => (shows(s) ? true : undefined))).snap;
    }
    if (!shows(snap)) snap = await scrollPicker(ui, shows);
  }
  return snap;
};

/** Scrolls the picker down until `test` holds or the list stops moving. */
const scrollPicker = async (ui: DeviceUi, test: (s: Snapshot) => boolean, max = 12): Promise<Snapshot> => {
  let snap = await ui.snapshot();
  for (let i = 0; i < max && !test(snap); i++) {
    const before = snap.lines.join('\n');
    await ui.swipe('up');
    snap = await ui.snapshot();
    if (snap.lines.join('\n') === before) break;
  }
  return snap;
};

const sizes = (entries: PickerEntry[], name: string) => entries.filter(e => same(e.name, name)).map(e => e.size);

const androidAdd = async (ui: DeviceUi, w: WidgetOp): Promise<Done> => {
  const name = w.name!;
  const app = w.app ?? name;
  const {pkg} = await androidPicker(ui);
  const snap = await androidAppWidgets(ui, app, s => pickEntry(pickerEntries(s), name, w.size) !== undefined);
  const entries = pickerEntries(snap);
  const entry = pickEntry(entries, name, w.size);
  if (!entry) {
    await ui.key(['home']);
    const offered = entries.map(e => `${e.name} ${e.size}`);
    if (sizes(entries, name).length) throw new Error(`no ${w.size} size of the "${name}" widget (it comes in ${sizes(entries, name).join(', ')})`);
    throw new Error(`no widget "${name}" in the picker for "${app}"${offered.length ? ` (it shows: ${offered.join(', ')})` : ''}\nhint: name the app with app=<label> as the picker lists it`);
  }
  // Android 15 and later: a tap on a widget shows an Add button. Older pickers place by dragging only. A first tap
  // can go to the search field instead (it gives up focus, the keyboard leaves): the widget is tapped again.
  let add: {snap: Snapshot; hit?: number} = {snap};
  let current = snap;
  for (let tries = 0; tries < 2 && add.hit === undefined; tries++) {
    const now = pickEntry(pickerEntries(current), name, entry.size);
    if (!now) break;
    await ui.press(point(current, now.index));
    add = await until(ui, 2500, s => idOf(s, 'widget_add_button'));
    current = add.snap;
  }
  let via = 'add button';
  let at: {x: number; y: number} | undefined;
  if (add.hit !== undefined) await ui.press(point(add.snap, add.hit));
  else if (pickEntry(pickerEntries(current), name, entry.size)) {
    via = 'drag';
    at = await dragPreview(ui, name, entry.size);
  } else if (homeWidget(current, name) === undefined && current.windows.find(x => x.type === 'app')?.pkg === pkg && idOf(current, 'workspace') === undefined) {
    throw new Error(`a tap on the "${name}" widget in the picker showed no Add button and the widget left the list\nscreen:\n${current.lines.slice(0, 15).join('\n')}`);
  }
  return androidPlaced(ui, w, pkg, {size: entry.size, via, ...(at ? {at: `${at.x},${at.y}`} : {})});
};

/**
 * Drags a widget's preview out of the picker onto the home screen, for a picker with no Add button: held until
 * the picker gives way to the home screen, then dropped on its emptiest spot.
 */
const dragPreview = async (ui: DeviceUi, name: string, size: string): Promise<{x: number; y: number}> => {
  const snap = await ui.snapshot();
  const entry = pickEntry(pickerEntries(snap), name, size);
  if (!entry) throw new Error(`the "${name}" widget left the picker before it could be dragged`);
  const from = tapPoint(snap, entry.index);
  const touch = (phase: 'down' | 'move' | 'up', x = 0, y = 0) => ui.runner.call('touch', {phase, x, y});
  await touch('down', from.x, from.y);
  let finger = {x: from.x + 12, y: from.y + 12};
  try {
    await sleep(1200);
    await touch('move', finger.x, finger.y);
    // The picker gives way to the home page with the widget under the finger and a Cancel target on top. The
    // workspace leaves the accessibility tree while something is dragged over it: the launcher's own root is the page.
    const drag = await until(ui, 2500, s => (dragging(s) ? true : undefined));
    if (!drag.hit) throw new Error(`holding the "${name}" preview did not start dragging it\nhint: this picker places widgets in a way pitbox does not drive; add it by hand`);
    // Launcher3 says where the widget would land ("Move to row 2 column 1 in Home screen 1 of 1") once the cells
    // under the finger can take it: dropped there, where the launcher chose. Otherwise the finger moves to the
    // emptiest spot of the page and waits for that answer there.
    const hint = (x: Snapshot) => (x.nodes.some(n => /^move to row \d+/i.test(n.d ?? '')) ? true : undefined);
    let ready = await until(ui, 1500, hint);
    if (!ready.hit) {
      const page = ready.snap.nodes[idOf(ready.snap, 'workspace') ?? idOf(ready.snap, 'drag_layer') ?? 0]!.b;
      // What hangs under the finger is the widget itself, not something on the page.
      const under = (n: UiNode) => n.b[0] <= finger.x && finger.x <= n.b[2] && n.b[1] <= finger.y && finger.y <= n.b[3];
      const spot = freeSpot({windows: ready.snap.windows, nodes: ready.snap.nodes.map(n => (under(n) && !n.id ? {...n, b: [0, 0, 0, 0] as Bounds} : n))}, page);
      if (!spot) throw new Error(`no room on the home page for the "${name}" widget`);
      for (let k = 1; k <= 4; k++) await touch('move', Math.round(finger.x + ((spot.x - finger.x) * k) / 4), Math.round(finger.y + ((spot.y - finger.y) * k) / 4));
      finger = spot;
      ready = await until(ui, 2000, hint);
      if (!ready.hit) throw new Error(`the home page has no room the launcher accepts for the "${name}" widget\nhint: make room on the first home page, or add it by hand`);
    }
    await sleep(300);
    await touch('up', finger.x, finger.y);
    return finger;
  } catch (e) {
    // Dropped on Cancel when it is there, so nothing lands where the finger happened to be.
    const s = await ui.snapshot().catch(() => undefined);
    const cancel = s && idOf(s, 'delete_target_text');
    if (s && cancel !== undefined) {
      const c = centre(s.nodes[cancel]!.b);
      await touch('move', c.x, c.y).catch(() => undefined);
      await sleep(400);
      await touch('up', c.x, c.y).catch(() => undefined);
    } else await touch('up', finger.x, finger.y).catch(() => undefined);
    throw e;
  }
};

/** A widget or an item is being dragged over the home screen: the drop targets are up, or the launcher says where it would go. */
export const dragging = (s: Pick<Snapshot, 'nodes'>) =>
  s.nodes.some(n => n.id === 'delete_target_text' || n.id === 'drop_target_bar' || /^move to row \d+/i.test(n.d ?? ''));

/** After the widget went in: its own setup screen, or the widget on the home screen (resize frame closed). */
const androidPlaced = async (ui: DeviceUi, w: WidgetOp, launcher: string, extra: Done): Promise<Done> => {
  const name = w.name!;
  const r = await until(ui, 8000, s => {
    const front = s.windows.find(x => x.type === 'app');
    if (front && front.pkg !== launcher && !/systemui/.test(front.pkg)) return 'setup';
    // Launcher3 leaves a fresh widget in its resize frame, which can hide the widget from the tree: back
    // closes it, as a tap elsewhere would.
    if (idOf(s, 'widget_resize_frame') !== undefined) return 'frame';
    return homeWidget(s, name) !== undefined ? 'home' : undefined;
  });
  if (r.hit === 'frame') {
    await ui.key(['back']);
    const after = await until(ui, 3000, s => (homeWidget(s, name) !== undefined ? true : undefined));
    if (!after.hit) throw new Error(`no "${name}" widget on the home screen after adding it (its resize frame was up)`);
    return {widget: name, ...extra, on: 'home'};
  }
  if (r.hit === 'setup') {
    const front = r.snap.windows.find(x => x.type === 'app')!;
    return {widget: name, ...extra, setup: front.pkg, note: `the widget opened its setup screen (${front.pkg}): finish it, and the widget goes on the home screen`};
  }
  if (r.hit !== 'home') throw new Error(`no "${name}" widget on the home screen after adding it\nhint: the home screen may be full, or the widget's label differs from its name in the picker`);
  return {widget: name, ...extra, on: 'home'};
};

/** Finds a widget on the home pages, swiping through them; the snapshot shows it. */
const androidFind = async (ui: DeviceUi, name: string): Promise<{snap: Snapshot; index: number} | undefined> => {
  await androidHome(ui);
  for (let page = 0; page < 6; page++) {
    const snap = await steady(ui);
    const index = homeWidget(snap, name);
    if (index !== undefined) return {snap, index};
    const before = snap.lines.join('\n');
    await ui.swipe('left');
    if ((await ui.snapshot()).lines.join('\n') === before) break;
  }
  return undefined;
};

const androidRemove = async (ui: DeviceUi, w: WidgetOp): Promise<Done> => {
  const name = w.name!;
  let launcher = 'unknown';
  for (let attempt = 1; ; attempt++) {
    const found = await androidFind(ui, name);
    if (!found) throw new Error(`no "${name}" widget on the home screen\nhint: widget list shows the widgets of the page on screen`);
    launcher = launcherPkg(found.snap);
    if (await dragToRemove(ui, found.snap, found.index)) break;
    // A drag that showed no Remove (a page still settling under the finger, a resize frame that took the touch):
    // the frame closed and the widget found again, once.
    const now = await ui.snapshot();
    if (idOf(now, 'widget_resize_frame') !== undefined) await ui.key(['back']);
    if (attempt >= 2) throw new Error(`dragging the "${name}" widget showed no Remove target (launcher ${launcher})`);
  }
  const gone = await until(ui, 4000, s => (homeWidget(s, name) === undefined ? true : undefined));
  if (!gone.hit) throw new Error(`the "${name}" widget is still on the home screen after dropping it on Remove`);
  return {widget: name, removed: true};
};

/** Holds a home-screen item, starts dragging it and drops it on the launcher's Remove target; false when none showed. */
const dragToRemove = async (ui: DeviceUi, snap: Snapshot, index: number): Promise<boolean> => {
  const at = tapPoint(snap, index);
  const touch = (phase: 'down' | 'move' | 'up', x = 0, y = 0) => ui.runner.call('touch', {phase, x, y});
  // A long press that does not move opens the resize frame; moving while held starts the drag that shows Remove.
  await touch('down', at.x, at.y);
  try {
    await sleep(1000);
    await touch('move', at.x, at.y);
    let target = await until(ui, 1500, s => idOf(s, 'delete_target_text'));
    if (target.hit === undefined) {
      await touch('move', at.x, at.y + 40);
      target = await until(ui, 1500, s => idOf(s, 'delete_target_text'));
    }
    if (target.hit === undefined) {
      await touch('up', at.x, at.y + 40);
      return false;
    }
    const to = centre(target.snap.nodes[target.hit]!.b);
    for (let k = 1; k <= 3; k++) await touch('move', Math.round(at.x + ((to.x - at.x) * k) / 3), Math.round(at.y + ((to.y - at.y) * k) / 3));
    await sleep(400);
    await touch('up', to.x, to.y);
    return true;
  } catch (e) {
    await touch('up').catch(() => undefined);
    throw e;
  }
};

const androidList = async (ui: DeviceUi, w: WidgetOp): Promise<Done> => {
  if (!w.app) {
    // Every home page, swiped through from the first.
    const {workspace} = await androidHome(ui);
    const widgets: string[] = [];
    for (let page = 0; page < 6; page++) {
      const snap = await steady(ui);
      for (const n of homeWidgets(snap, workspace)) if (!widgets.includes(n)) widgets.push(n);
      const before = snap.lines.join('\n');
      await ui.swipe('left');
      if ((await ui.snapshot()).lines.join('\n') === before) break;
    }
    await ui.key(['home']);
    return {widgets};
  }
  await androidPicker(ui);
  const snap = await androidAppWidgets(ui, w.app);
  const widgets = pickerEntries(snap).map(e => `${e.name} ${e.size}`);
  await ui.key(['home']);
  if (!widgets.length) throw new Error(`no widgets of "${w.app}" in the picker\nhint: name the app as the picker lists it`);
  return {app: w.app, widgets};
};

// ———————————————————————————————————————— iOS / iPadOS ————————————————————————————————————————
// SpringBoard is read by what does not change with the system language: the ids of its views and of the SF Symbols
// beside its menu items (`widget.small.badge.plus`, `…application-shortcut-item.remove-widget`), node types and
// where things sit. The words it shows are never matched, except the names the caller gives (the app's label, the
// widget's name), which are in the device's language anyway.

const SPRINGBOARD = 'com.apple.springboard';
const HOME_ICONS = 'Home screen icons';
const ADD_WIDGET_SYMBOL = 'widget.small.badge.plus';
const GALLERY = 'add-sheet-collection-view';
const REMOVE_ITEM = 'com.apple.springboardhome.application-shortcut-item.remove-widget';

export const IOS_FOLDABLE =
  'widget is not supported on a foldable iPhone simulator: its SpringBoard reports the home pages of both screens with frames turned against the lit one, and the simulator ignores the home button, so nothing on its home screen can be pressed where it is drawn\nhint: add the widget by hand';

export const IOS_SIZES = ['small', 'medium', 'large', 'extra large', 'extra large portrait'];

/** A widget on an iOS home page: an icon view with the widget's scrolling content inside (an app icon has none). */
export type IosHomeWidget = {index: number; label: string; stack?: string[]};

/**
 * The widgets on the home page in the tree, in reading order. SpringBoard labels each with its app's name. A widget
 * is an icon view with the widget's content inside; while the page is being edited the content leaves the tree, and
 * a widget is told from an app icon by its size (an icon takes well under 4% of the screen, a small widget about 9%).
 */
export const iosHomeWidgets = (snap: Pick<Snapshot, 'nodes'>): IosHomeWidget[] => {
  const root = snap.nodes.find(n => n.id === HOME_ICONS)?.b;
  const screen = root ? area(root) : Math.max(0, ...snap.nodes.map(n => area(n.b)));
  const out: IosHomeWidget[] = [];
  snap.nodes.forEach((icon, k) => {
    if (icon.c !== 'Icon') return;
    const content = snap.nodes.some(m => m.c === 'ScrollView' && inAncestry(snap.nodes, m, k));
    if (!content && !(screen > 0 && area(icon.b) >= screen * 0.04)) return;
    // A stack names the widgets in it in its own view's id: `widget-stack:<Calendar,News,Photos>`.
    const stackId = snap.nodes.find(m => m.p === k && /^widget-stack:/.test(m.id ?? ''))?.id;
    const stack = stackId ? /^widget-stack:<(.*)>$/.exec(stackId)?.[1]?.split(',') : undefined;
    out.push({index: k, label: (icon.t ?? icon.id ?? '').replace(/\s+/g, ' ').trim(), ...(stack ? {stack} : {})});
  });
  return out.sort((x, y) => snap.nodes[x.index]!.b[1] - snap.nodes[y.index]!.b[1] || snap.nodes[x.index]!.b[0] - snap.nodes[y.index]!.b[0]);
};

/** The home page on screen and how many there are, from the page control's numbers ("Page 2 of 3" in any language). */
export const iosPages = (snap: Pick<Snapshot, 'nodes'>): {page: number; pages: number} => {
  const pc = snap.nodes.find(n => n.id === 'Page control');
  const nums = `${pc?.t ?? ''} ${pc?.d ?? ''}`.match(/\d+/g)?.map(Number) ?? [];
  if (nums.length < 2) return {page: 1, pages: 1};
  const pages = Math.max(nums[0]!, nums[1]!);
  return {page: Math.min(nums[0]!, nums[1]!), pages};
};

/** The home screen is being edited (icons jiggle): every icon has its delete badge. */
const iosEditing = (snap: Pick<Snapshot, 'nodes'>) => snap.nodes.some(n => n.id === 'DeleteButton');

/**
 * The size of a widget in the gallery, from its preview's shape: small and large are square, medium and extra
 * large twice as wide as high, extra large portrait taller than wide; small and medium are one row high, the
 * others two. `ref` is the width of the gallery's content (its Add button).
 */
export const iosSizeOf = (b: Bounds, ref: number): string => {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  if (w <= 0 || h <= 0 || ref <= 0) return 'unknown';
  const aspect = w / h;
  if (aspect < 0.8) return 'extra large portrait';
  if (aspect < 1.4) return w / ref > 0.65 ? 'large' : 'small';
  return h / ref > 0.6 ? 'extra large' : 'medium';
};

/** One page of an app's widget gallery: the widget's preview, its name and size, and the Add button under it. */
export type IosGalleryPage = {preview: number; add?: number; name: string; size: string};

/**
 * The page of the gallery on screen. The preview is a button labelled "<App>, <Widget>" (its value says "Widget,
 * <size>" in the device's language); the Add button is the wide button with no id below it.
 */
export const iosGalleryPage = (snap: Pick<Snapshot, 'nodes'>, app: string): IosGalleryPage | undefined => {
  const prefix = `${norm(app)}, `;
  const preview = snap.nodes.findIndex(n => n.c === 'Button' && !n.id && norm(n.t).startsWith(prefix));
  const alone = preview >= 0 ? preview : snap.nodes.findIndex(n => n.c === 'Button' && !n.id && same(n.t, app) && area(n.b) > 0 && n.b[3] - n.b[1] > 100);
  if (alone < 0) return undefined;
  const pb = snap.nodes[alone]!.b;
  const below = snap.nodes
    .flatMap((n, i) => (n.c === 'Button' && !n.id && i !== alone && n.b[1] >= pb[3] - 4 ? [i] : []))
    .sort((x, y) => (snap.nodes[y]!.b[2] - snap.nodes[y]!.b[0]) - (snap.nodes[x]!.b[2] - snap.nodes[x]!.b[0]));
  const add = below[0];
  const ref = add !== undefined ? snap.nodes[add]!.b[2] - snap.nodes[add]!.b[0] : pb[2] - pb[0];
  const label = (snap.nodes[alone]!.t ?? '').replace(/\s+/g, ' ').trim();
  const name = norm(label).startsWith(prefix) ? label.slice(prefix.length).trim() : label;
  return {preview: alone, ...(add !== undefined ? {add} : {}), name, size: iosSizeOf(pb, ref)};
};

const iosSnap = async (ui: DeviceUi) => steady(ui, 1500);

/**
 * Closes the widget gallery, which home leaves up on some screens: pulled down by its grabber, the short button with
 * no id at the top of the sheet.
 */
const iosCloseSheet = async (ui: DeviceUi, snap: Snapshot) => {
  const {height} = await ui.size();
  const grabber = snap.nodes
    .filter(n => n.c === 'Button' && !n.id && n.b[3] - n.b[1] < 40 && n.b[1] > 0 && n.b[1] < height * 0.4)
    .sort((a, b) => a.b[1] - b.b[1])[0];
  if (!grabber) return;
  const c = centre(grabber.b);
  await ui.swipe(`${c.x},${c.y},${c.x},${Math.round(height * 0.98)}`, 400);
};

/**
 * The first home page, out of editing, with nothing over it. Home leaves editing or a menu first, and goes to the
 * first page when pressed on another one.
 */
const iosHome = async (ui: DeviceUi): Promise<Snapshot> => {
  // A foldable iPhone's SpringBoard lists the home pages of both its screens, with frames turned against the lit
  // one, and the simulator does not take the home button: nothing on it can be found where it is drawn.
  const first = await ui.snapshot();
  if (first.nodes.filter(n => n.id === HOME_ICONS && n.p < 0).length > 1) throw new Error(IOS_FOLDABLE);
  for (let i = 0; i < 5; i++) {
    await ui.key(['home']);
    const {snap, hit} = await until(ui, 2500, s => (s.windows[0]?.pkg === SPRINGBOARD && s.nodes.some(n => n.id === HOME_ICONS) ? true : undefined));
    if (snap.windows[0]?.pkg === SPRINGBOARD && snap.nodes.some(n => n.id === 'PopoverDismissRegion')) {
      await iosCloseSheet(ui, snap);
      continue;
    }
    if (!hit || iosEditing(snap) || snap.nodes.some(n => n.id === GALLERY || n.id === REMOVE_ITEM)) continue;
    let settled = await iosSnap(ui);
    // Home does not always go back to the first page: swiped back to it.
    for (let k = iosPages(settled).page; k > 1; k--) {
      const prev = await iosPrevPage(ui, settled);
      if (!prev) break;
      settled = prev;
    }
    if (iosPages(settled).page === 1) return settled;
  }
  const snap = await ui.snapshot();
  throw new Error(`home did not bring up the home screen (in front: ${snap.windows[0]?.pkg ?? 'nothing'})`);
};

/** Swipes back to the previous home page; undefined when the page did not change. */
const iosPrevPage = async (ui: DeviceUi, snap: Snapshot): Promise<Snapshot | undefined> => {
  const {page} = iosPages(snap);
  const {width, height} = await ui.size();
  await ui.swipe(`${Math.round(width * 0.15)},${Math.round(height * 0.5)},${Math.round(width * 0.85)},${Math.round(height * 0.5)}`);
  const r = await until(ui, 2000, s => (iosPages(s).page !== page ? true : undefined));
  return r.hit ? iosSnap(ui) : undefined;
};

/** Swipes to the next home page; undefined when the page did not change. */
const iosNextPage = async (ui: DeviceUi, snap: Snapshot): Promise<Snapshot | undefined> => {
  const {page} = iosPages(snap);
  const {width, height} = await ui.size();
  await ui.swipe(`${Math.round(width * 0.85)},${Math.round(height * 0.5)},${Math.round(width * 0.15)},${Math.round(height * 0.5)}`);
  const r = await until(ui, 2000, s => (iosPages(s).page !== page ? true : undefined));
  return r.hit ? iosSnap(ui) : undefined;
};

/** Every home page from the first, with the widgets on it. */
const iosEachPage = async (ui: DeviceUi, visit: (snap: Snapshot, page: number) => boolean | void): Promise<void> => {
  let snap = await iosHome(ui);
  for (;;) {
    const {page, pages} = iosPages(snap);
    // Past the last page is the App Library: never swiped into.
    if (visit(snap, page) === true || page >= pages) return;
    const next = await iosNextPage(ui, snap);
    if (!next) return;
    snap = next;
  }
};

/** Matches a home widget by the label the caller gave: its app's name, which is how SpringBoard labels it. */
const iosMatches = (w: IosHomeWidget, label: string) => same(w.label, label);

/** The Edit button of the home screen being edited (its menu holds "Add Widget"), then that item: the gallery opens. */
const iosOpenGallery = async (ui: DeviceUi, spot: {x: number; y: number}): Promise<Snapshot> => {
  // Two buttons with no id of their own stand over the page being edited: Edit and Done (a row at the top of a
  // phone, a column beside a foldable's side dock). Which comes first depends on the language and the screen: the
  // first in reading order is tried, and the other one when that was Done.
  for (const side of ['first', 'last'] as const) {
    await ui.press(`${spot.x},${spot.y}`, 'longpress');
    const edit = await until(ui, 4000, s => {
      if (!iosEditing(s)) return undefined;
      const seen = new Set<string>();
      const bar = s.nodes
        .flatMap((n, i) => (n.c === 'Button' && !n.id && !n.d && n.t && !s.nodes.some(m => m.c === 'Icon' && inAncestry(s.nodes, n, s.nodes.indexOf(m))) ? [i] : []))
        .filter(i => !seen.has(s.nodes[i]!.b.join(',')) && !!seen.add(s.nodes[i]!.b.join(',')))
        .sort((x, y) => s.nodes[x]!.b[1] - s.nodes[y]!.b[1] || s.nodes[x]!.b[0] - s.nodes[y]!.b[0]);
      return bar.length ? (side === 'first' ? bar[0] : bar[bar.length - 1]) : undefined;
    });
    if (edit.hit === undefined) throw new Error(`a long press on the home screen at ${spot.x},${spot.y} did not start editing it`);
    await ui.press(point(edit.snap, edit.hit));
    const item = await until(ui, 2500, s => idOf(s, ADD_WIDGET_SYMBOL));
    if (item.hit !== undefined) {
      await ui.press(point(item.snap, item.hit));
      const gallery = await until(ui, 4000, s => idOf(s, GALLERY));
      if (gallery.hit === undefined) throw new Error('"Add Widget" opened no widget gallery');
      return iosSnap(ui);
    }
    // That was Done: the home screen is out of editing again.
  }
  throw new Error('the home screen\'s Edit menu has no "Add Widget" item');
};

/** A row of the gallery's list of apps: a cell (a button on some versions) with the app's name. */
const galleryRow = (n: UiNode) => (n.c === 'Cell' || n.c === 'Button') && !!n.t;

/** In the gallery's list of apps: the app's row, scrolled to. */
const iosGalleryApp = async (ui: DeviceUi, app: string): Promise<{snap: Snapshot; index?: number; seen: string[]}> => {
  let snap = await iosSnap(ui);
  const seen: string[] = [];
  for (let k = 0; k < 20; k++) {
    const list = idOf(snap, GALLERY);
    if (list === undefined) break;
    const rows = snap.nodes.flatMap((n, i) => (galleryRow(n) && inAncestry(snap.nodes, n, list) ? [i] : []));
    for (const r of rows) if (!seen.includes(snap.nodes[r]!.t!)) seen.push(snap.nodes[r]!.t!);
    const index = rows.find(r => same(snap.nodes[r]!.t, app));
    if (index !== undefined) return {snap, index, seen};
    const lb = snap.nodes[list]!.b;
    const {height} = await ui.size();
    const bottom = Math.min(lb[3], height);
    const x = Math.round((lb[0] + lb[2]) / 2);
    const before = rows.map(r => snap.nodes[r]!.t).join('|');
    await ui.swipe(`${x},${Math.round(lb[1] + (bottom - lb[1]) * 0.8)},${x},${Math.round(lb[1] + (bottom - lb[1]) * 0.25)}`);
    snap = await iosSnap(ui);
    const list2 = idOf(snap, GALLERY);
    if (list2 === undefined) break;
    const after = snap.nodes.flatMap(n => (galleryRow(n) && inAncestry(snap.nodes, n, list2) ? [n.t] : [])).join('|');
    if (after === before) break;
  }
  return {snap, seen};
};

/** Opens the gallery of one app; the snapshot shows its first page. */
const iosAppGallery = async (ui: DeviceUi, app: string, spot: {x: number; y: number}): Promise<Snapshot> => {
  await iosOpenGallery(ui, spot);
  const row = await iosGalleryApp(ui, app);
  if (row.index === undefined) {
    await iosHome(ui);
    const some = row.seen.slice(0, 12);
    throw new Error(`no app "${app}" among the apps the widget gallery offers${some.length ? ` (it lists: ${some.join(', ')}${row.seen.length > some.length ? ', …' : ''})` : ''}\nhint: name the app with app=<label> as the gallery lists it`);
  }
  await ui.press(point(row.snap, row.index));
  const page = await until(ui, 4000, s => iosGalleryPage(s, app));
  if (!page.hit) {
    await iosHome(ui);
    throw new Error(`the gallery of "${app}" showed no widget`);
  }
  return iosSnap(ui);
};

/** Walks the pages of an app's gallery until `stop` holds; every page seen, in order. */
const iosGalleryWalk = async (ui: DeviceUi, app: string, stop: (p: IosGalleryPage) => boolean): Promise<{snap: Snapshot; page?: IosGalleryPage; seen: IosGalleryPage[]}> => {
  let snap = await iosSnap(ui);
  const seen: IosGalleryPage[] = [];
  for (let k = 0; k < 40; k++) {
    const page = iosGalleryPage(snap, app);
    if (!page) break;
    seen.push(page);
    if (stop(page)) return {snap, page, seen};
    const pb = snap.nodes[page.preview]!.b;
    const sig = `${snap.nodes[page.preview]!.t}|${snap.nodes[page.preview]!.d}|${pb.join(',')}|${snap.lines.join('\n')}`;
    const {width} = await ui.size();
    const y = Math.round((pb[1] + pb[3]) / 2);
    await ui.swipe(`${Math.round(width * 0.85)},${y},${Math.round(width * 0.15)},${y}`);
    snap = await iosSnap(ui);
    const next = iosGalleryPage(snap, app);
    if (!next) break;
    const nb = snap.nodes[next.preview]!.b;
    if (`${snap.nodes[next.preview]!.t}|${snap.nodes[next.preview]!.d}|${nb.join(',')}|${snap.lines.join('\n')}` === sig) break;
  }
  return {snap, seen};
};

/** A spot to long-press on the home page in the tree: below the status bar, above the dock. */
const iosSpot = async (ui: DeviceUi, snap: Snapshot) => {
  const {width, height} = await ui.size();
  // The dock and the page dots below the icons; a dock at the side (a foldable's) is just one more thing to avoid.
  const below = (n?: UiNode) => (n && n.b[1] > height / 2 ? n.b[1] : height);
  const dock = snap.nodes.find(n => n.t === 'Dock' || n.id === 'Dock');
  const pc = snap.nodes.find(n => n.id === 'Page control' || n.id === 'spotlight-pill');
  const bottom = Math.min(below(dock), below(pc));
  return freeSpot(snap, [0, Math.round(height * 0.08), width, bottom], {top: Math.round(height * 0.08)});
};

const iosAdd = async (ui: DeviceUi, w: WidgetOp): Promise<Done> => {
  const name = w.name!;
  const app = w.app ?? name;
  // The last home page: the one with room, where a new widget moves the fewest icons.
  // Counted on every page on the way: a full page sends a new widget, or the icons it displaces, to another page.
  const mine = (s: Snapshot) => iosHomeWidgets(s).filter(x => !x.stack && iosMatches(x, app)).length;
  let snap = await iosHome(ui);
  let before = mine(snap);
  while (iosPages(snap).page < iosPages(snap).pages) {
    const next = await iosNextPage(ui, snap);
    if (!next) break;
    snap = next;
    before += mine(snap);
  }
  const {page} = iosPages(snap);
  const spot = await iosSpot(ui, snap);
  if (!spot) throw new Error('no empty spot on the last home page to long-press\nhint: move an icon off it, or add the widget by hand');
  await iosAppGallery(ui, app, spot);
  const walk = await iosGalleryWalk(ui, app, p => same(p.name, name) && (!w.size || p.size === w.size));
  if (!walk.page || walk.page.add === undefined) {
    await iosHome(ui);
    const kinds = walk.seen.filter(p => same(p.name, name)).map(p => p.size);
    if (kinds.length && w.size) throw new Error(`no ${w.size} size of the "${name}" widget (it comes in ${kinds.join(', ')})`);
    const offered = [...new Set(walk.seen.map(p => `${p.name} ${p.size}`))];
    throw new Error(`no widget "${name}" in the gallery of "${app}"${offered.length ? ` (it shows: ${offered.join(', ')})` : ''}`);
  }
  await ui.press(point(walk.snap, walk.page.add));
  await until(ui, 4000, s => (s.nodes.some(n => n.id === HOME_ICONS) && !s.nodes.some(n => n.id === GALLERY) ? true : undefined));
  let after = 0;
  await iosEachPage(ui, s => {
    after += mine(s);
  });
  if (after <= before) throw new Error(`no new "${app}" widget on the home screen after adding "${name}"`);
  await iosHome(ui);
  return {widget: name, size: walk.page.size, label: app, on: `home page ${page}`};
};

/** The plain widgets with the label on every home page: how many, and the first page that has one. */
const iosCount = async (ui: DeviceUi, label: string): Promise<{total: number; first?: number}> => {
  let total = 0;
  let first: number | undefined;
  await iosEachPage(ui, (snap, page) => {
    const n = iosHomeWidgets(snap).filter(x => !x.stack && iosMatches(x, label)).length;
    if (n && first === undefined) first = page;
    total += n;
  });
  return {total, ...(first !== undefined ? {first} : {})};
};

/**
 * Removes the first widget with the label in reading order (pages from the first, top to bottom, left to right),
 * as on Android. A stack is never taken: it holds other widgets too. Removing one lets the next page's icons and
 * widgets flow back, so the check is the count over every page, not the page it was on.
 */
const iosRemove = async (ui: DeviceUi, w: WidgetOp): Promise<Done> => {
  const label = w.app ?? w.name!;
  const before = await iosCount(ui, label);
  if (before.first === undefined) throw new Error(`no "${label}" widget on the home screen\nhint: on iOS a home-screen widget is labelled with its app's name; widget list shows them`);
  let snap = await iosHome(ui);
  while (iosPages(snap).page < before.first) {
    const next = await iosNextPage(ui, snap);
    if (!next) break;
    snap = next;
  }
  const target = iosHomeWidgets(snap).find(x => !x.stack && iosMatches(x, label));
  if (!target) throw new Error(`the "${label}" widget left page ${before.first} before it could be removed`);
  await ui.press(point(snap, target.index), 'longpress');
  const item = await until(ui, 3000, s => idOf(s, REMOVE_ITEM));
  if (item.hit === undefined) {
    await iosHome(ui);
    throw new Error(`a long press on the "${label}" widget showed no Remove Widget item`);
  }
  await ui.press(point(item.snap, item.hit));
  // "Remove "<widget>"?" — the destructive button comes last.
  const alert = await until(ui, 3000, s => {
    const a = s.nodes.findIndex(n => n.c === 'Alert');
    if (a < 0) return undefined;
    const buttons = s.nodes.flatMap((n, i) => (n.c === 'Button' && inAncestry(s.nodes, n, a) ? [i] : []));
    return buttons.length ? buttons[buttons.length - 1] : undefined;
  });
  if (alert.hit !== undefined) await ui.press(point(alert.snap, alert.hit));
  await until(ui, 3000, s => (s.nodes.some(n => n.id === HOME_ICONS) && !s.nodes.some(n => n.c === 'Alert') ? true : undefined));
  const after = await iosCount(ui, label);
  await iosHome(ui);
  if (after.total >= before.total) throw new Error(`the "${label}" widget is still on the home screen after removing it`);
  return {widget: label, removed: true, page: before.first, left: after.total};
};

const iosList = async (ui: DeviceUi, w: WidgetOp): Promise<Done> => {
  if (!w.app) {
    const widgets: string[] = [];
    await iosEachPage(ui, snap => {
      for (const x of iosHomeWidgets(snap)) widgets.push(x.stack ? `${x.label} (stack: ${x.stack.join(', ')})` : x.label);
    });
    await iosHome(ui);
    return {widgets};
  }
  const snap = await iosHome(ui);
  const spot = await iosSpot(ui, snap);
  if (!spot) throw new Error('no empty spot on the first home page to long-press');
  await iosAppGallery(ui, w.app, spot);
  const walk = await iosGalleryWalk(ui, w.app, () => false);
  await iosHome(ui);
  return {app: w.app, widgets: [...new Set(walk.seen.map(p => `${p.name} ${p.size}`))]};
};

// ———————————————————————————————————————— entry ————————————————————————————————————————

export type WidgetPlatform = 'android' | 'ios';

/** Adds, removes or lists home-screen widgets on one device. */
export const widget = (ui: DeviceUi, platform: WidgetPlatform, w: WidgetOp): Promise<Done> =>
  asOneStep(ui, stepLine(w), async () => {
    const t0 = Date.now();
    if (platform === 'android' && w.size && !/^\d+x\d+$/.test(w.size)) throw new Error(`size on Android is the picker's cells, like 4x2${IOS_SIZES.includes(w.size) ? ` (${w.size} is an iOS size)` : ''}`);
    if (platform === 'ios' && w.size && !IOS_SIZES.includes(w.size)) throw new Error(`size on iOS is one of ${IOS_SIZES.join(', ')}`);
    const r =
      platform === 'android'
        ? w.op === 'add' ? await androidAdd(ui, w) : w.op === 'remove' ? await androidRemove(ui, w) : await androidList(ui, w)
        : w.op === 'add' ? await iosAdd(ui, w) : w.op === 'remove' ? await iosRemove(ui, w) : await iosList(ui, w);
    return {serial: ui.serial, ...r, ms: Date.now() - t0};
  });
