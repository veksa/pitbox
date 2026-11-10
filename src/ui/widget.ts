// Home-screen widgets of the app under test: added from the launcher's own widget picker and removed the way a
// person does it, through the device's UI session — by elements of the launcher's tree, never by fixed points.
// Android: Launcher3 and the launchers built on it (AOSP Launcher3, Pixel Launcher). iOS and iPadOS: SpringBoard.
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
    // The cell: the nearest ancestor that holds the size too.
    for (let k = n.p, hops = 0; k >= 0 && hops < 6; k = snap.nodes[k]!.p, hops++) {
      const dims = snap.nodes.find(m => m.id === 'widget_dims' && m.t && inAncestry(snap.nodes, m, k));
      if (!dims) continue;
      const wh = /(\d+)\s*[×x]\s*(\d+)/.exec(dims.t!);
      if (wh) add(k, n.t, `${wh[1]}x${wh[2]}`);
      break;
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
  const {snap, hit} = await until(ui, 3000, s => idOf(s, 'workspace'));
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
  await ui.press(point(snap, entry.index));
  // Android 15 and later: a tap on a widget shows an Add button. Older pickers place by dragging only.
  const add = await until(ui, 2500, s => idOf(s, 'widget_add_button'));
  let via = 'add button';
  let at: {x: number; y: number} | undefined;
  if (add.hit !== undefined) await ui.press(point(add.snap, add.hit));
  else {
    via = 'drag';
    at = await dragPreview(ui, name, entry.size);
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
  try {
    await sleep(1200);
    await touch('move', from.x + 12, from.y + 12);
    const home = await until(ui, 2500, s => idOf(s, 'workspace') ?? undefined);
    const ws = home.hit === undefined ? undefined : home.snap.nodes[home.hit]!.b;
    const spot = ws && freeSpot(home.snap, ws);
    if (!ws || !spot) throw new Error(`holding the "${name}" preview did not bring up a home page with room for it\nhint: this picker places widgets in a way pitbox does not drive; add it by hand`);
    for (let k = 1; k <= 4; k++) await touch('move', Math.round(from.x + ((spot.x - from.x) * k) / 4), Math.round(from.y + ((spot.y - from.y) * k) / 4));
    await sleep(700);
    await touch('up', spot.x, spot.y);
    return spot;
  } catch (e) {
    await touch('up').catch(() => undefined);
    throw e;
  }
};

/** After the widget went in: its own setup screen, or the widget on the home screen (resize frame closed). */
const androidPlaced = async (ui: DeviceUi, w: WidgetOp, launcher: string, extra: Done): Promise<Done> => {
  const name = w.name!;
  const r = await until(ui, 8000, s => {
    const front = s.windows.find(x => x.type === 'app');
    if (front && front.pkg !== launcher && !/systemui/.test(front.pkg)) return 'setup';
    return homeWidget(s, name) !== undefined ? 'home' : undefined;
  });
  if (r.hit === 'setup') {
    const front = r.snap.windows.find(x => x.type === 'app')!;
    return {widget: name, ...extra, setup: front.pkg, note: `the widget opened its setup screen (${front.pkg}): finish it, and the widget goes on the home screen`};
  }
  if (r.hit !== 'home') throw new Error(`no "${name}" widget on the home screen after adding it\nhint: the home screen may be full, or the widget's label differs from its name in the picker`);
  // Launcher3 leaves a fresh widget in its resize frame; back closes it, as a tap elsewhere would.
  if (idOf(r.snap, 'widget_resize_frame') !== undefined) await ui.key(['back']);
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

const IOS_SIZES = ['small', 'medium', 'large', 'extra large'];

const iosHome = async (ui: DeviceUi): Promise<Snapshot> => {
  await ui.key(['home']);
  const {snap} = await until(ui, 2000, s => (s.windows[0]?.pkg === 'com.apple.springboard' ? true : undefined));
  if (snap.windows[0]?.pkg !== 'com.apple.springboard') throw new Error(`home did not bring up the home screen (in front: ${snap.windows[0]?.pkg ?? 'nothing'})`);
  return snap;
};

const findLabel = (s: Snapshot, re: RegExp, pred: (n: UiNode) => boolean = () => true) => {
  const i = s.nodes.findIndex(n => re.test(say(n)) && pred(n));
  return i >= 0 ? i : undefined;
};

const iosDone = async (ui: DeviceUi) => {
  const s = await ui.snapshot();
  const done = findLabel(s, /^done$/i, n => n.c === 'Button');
  if (done !== undefined) await ui.press(point(s, done));
};

/** The page of the iOS widget gallery for one size, by the size name the gallery shows under it. */
export const iosSizePage = (snap: Pick<Snapshot, 'nodes'>): string | undefined => {
  for (const n of snap.nodes) {
    const s = say(n).toLowerCase();
    if (IOS_SIZES.includes(s)) return s;
  }
  return undefined;
};

/** A widget on the iOS home screen: SpringBoard labels it with the widget's name (or its app's). */
export const iosHomeWidget = (snap: Pick<Snapshot, 'nodes'>, name: string): number | undefined => {
  const i = snap.nodes.findIndex(n => n.c !== 'Icon' && (same(n.d, name) || same(n.t, name) || same(n.id, name)) && n.c !== 'Button' && n.c !== 'StaticText');
  if (i >= 0) return i;
  const j = snap.nodes.findIndex(n => n.c !== 'Icon' && n.c !== 'StaticText' && (n.id ?? '').toLowerCase().includes('widget') && say(n).toLowerCase().includes(name.toLowerCase()));
  return j >= 0 ? j : undefined;
};

const iosAdd = async (ui: DeviceUi, w: WidgetOp): Promise<Done> => {
  const name = w.name!;
  const app = w.app ?? name;
  const home = await iosHome(ui);
  const {width, height} = await ui.size();
  const spot = freeSpot(home, [0, 0, width, height], {top: Math.round(height * 0.1)});
  if (!spot) throw new Error('no empty spot on the home screen to long-press');
  await ui.press(`${spot.x},${spot.y}`, 'longpress');
  // iOS 18 and later: Edit, then Add Widget; iOS 17: a + button that adds a widget.
  const edit = await until(ui, 3000, s => findLabel(s, /^(edit|add widget)$/i, n => n.c === 'Button'));
  if (edit.hit === undefined) throw new Error('a long press on the home screen did not start editing it (no Edit button)');
  await ui.press(point(edit.snap, edit.hit));
  if (/^edit$/i.test(say(edit.snap.nodes[edit.hit]!))) {
    const add = await until(ui, 3000, s => findLabel(s, /^add widget$/i));
    if (add.hit === undefined) throw new Error('the Edit menu has no "Add Widget" item');
    await ui.press(point(add.snap, add.hit));
  }
  const search = await until(ui, 4000, s => s.nodes.findIndex(n => n.c === 'SearchField' || (n.f ?? '').includes('e')) + 1 || undefined);
  if (search.hit === undefined) {
    await iosDone(ui);
    throw new Error('the widget gallery opened with no search field');
  }
  await ui.fill(point(search.snap, search.hit - 1), app);
  const result = await until(ui, 4000, s => findLabel(s, new RegExp(`^${escape(app)}$`, 'i'), n => n.c !== 'SearchField' && !(n.f ?? '').includes('e')));
  if (result.hit === undefined) {
    await iosDone(ui);
    throw new Error(`no app "${app}" among the widgets the gallery offers\nhint: name the app with app=<label> as the gallery lists it`);
  }
  await ui.press(point(result.snap, result.hit));
  // The app's gallery: one page per widget kind and size, each with its name and size, and an Add Widget button.
  let page = await until(ui, 4000, s => findLabel(s, /^add widget$/i, n => n.c === 'Button'));
  if (page.hit === undefined) {
    await iosDone(ui);
    throw new Error(`the gallery of "${app}" showed no Add Widget button`);
  }
  const want = w.size;
  const matchesPage = (s: Snapshot) => s.nodes.some(n => same(n.t ?? n.d, name)) && (!want || iosSizePage(s) === want);
  for (let k = 0; k < 12 && !matchesPage(page.snap); k++) {
    const before = page.snap.lines.join('\n');
    await ui.swipe('left');
    page = await until(ui, 1500, s => findLabel(s, /^add widget$/i, n => n.c === 'Button'));
    if (page.hit === undefined || page.snap.lines.join('\n') === before) break;
  }
  if (!matchesPage(page.snap) || page.hit === undefined) {
    await iosDone(ui);
    throw new Error(`no "${name}" widget${want ? ` in ${want} size` : ''} in the gallery of "${app}"`);
  }
  const shown = iosSizePage(page.snap);
  await ui.press(point(page.snap, page.hit));
  await sleep(800);
  await iosDone(ui);
  const placed = await until(ui, 5000, s => iosHomeWidget(s, name));
  if (placed.hit === undefined) throw new Error(`no "${name}" widget on the home screen after adding it`);
  return {widget: name, ...(shown ? {size: shown} : {}), on: 'home'};
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const iosFind = async (ui: DeviceUi, name: string): Promise<{snap: Snapshot; index: number} | undefined> => {
  await iosHome(ui);
  for (let page = 0; page < 6; page++) {
    const snap = await ui.snapshot();
    const index = iosHomeWidget(snap, name);
    if (index !== undefined) return {snap, index};
    const before = snap.lines.join('\n');
    await ui.swipe('left');
    if ((await ui.snapshot()).lines.join('\n') === before) break;
  }
  return undefined;
};

const iosRemove = async (ui: DeviceUi, w: WidgetOp): Promise<Done> => {
  const name = w.name!;
  const found = await iosFind(ui, name);
  if (!found) throw new Error(`no "${name}" widget on the home screen`);
  await ui.press(point(found.snap, found.index), 'longpress');
  const item = await until(ui, 3000, s => findLabel(s, /^remove widget$/i));
  if (item.hit === undefined) throw new Error(`a long press on the "${name}" widget showed no "Remove Widget" item`);
  await ui.press(point(item.snap, item.hit));
  const confirm = await until(ui, 3000, s => findLabel(s, /^remove$/i, n => n.c === 'Button'));
  if (confirm.hit !== undefined) await ui.press(point(confirm.snap, confirm.hit));
  await iosDone(ui);
  const gone = await until(ui, 4000, s => (iosHomeWidget(s, name) === undefined ? true : undefined));
  if (!gone.hit) throw new Error(`the "${name}" widget is still on the home screen after removing it`);
  return {widget: name, removed: true};
};

// ———————————————————————————————————————— entry ————————————————————————————————————————

export type WidgetPlatform = 'android' | 'ios';

/** Adds, removes or lists home-screen widgets on one device. */
export const widget = (ui: DeviceUi, platform: WidgetPlatform, w: WidgetOp): Promise<Done> =>
  asOneStep(ui, stepLine(w), async () => {
    const t0 = Date.now();
    if (platform === 'ios' && w.size && !IOS_SIZES.includes(w.size)) throw new Error(`size on iOS is one of ${IOS_SIZES.join(', ')}`);
    if (platform === 'android' && w.size && !/^\d+x\d+$/.test(w.size)) throw new Error('size on Android is the picker\'s cells, like 4x2');
    const r =
      platform === 'android'
        ? w.op === 'add' ? await androidAdd(ui, w) : w.op === 'remove' ? await androidRemove(ui, w) : await androidList(ui, w)
        : w.op === 'add' ? await iosAdd(ui, w) : w.op === 'remove' ? await iosRemove(ui, w) : await iosList(ui, w);
    return {serial: ui.serial, ...r, ms: Date.now() - t0};
  });

const iosList = async (ui: DeviceUi, w: WidgetOp): Promise<Done> => {
  if (w.app) throw new Error('widget list <app> reads the Android picker; on iOS widget list shows the widgets on the home page');
  const snap = await iosHome(ui);
  const widgets = snap.nodes.filter(n => n.c !== 'Icon' && (n.id ?? '').toLowerCase().includes('widget')).map(say).filter(Boolean);
  return {widgets: [...new Set(widgets)]};
};
