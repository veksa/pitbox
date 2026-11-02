// UI automation on one device through its on-device runner: snapshots, actions that settle and answer with what
// changed, waits, scrolling to a target, focus (TV), downscaled screenshots, and recording into a flow. The
// runners of every platform speak the same JSON-lines protocol, so this class does not know which one it drives.

import fs from 'node:fs';
import path from 'node:path';
import {KEYS} from '../drivers/android/driver.ts';
import {keyOf} from '../drivers/android/formfactor.ts';
import type {AppEvent} from '../drivers/android/events.ts';
import {compareFingerprints, type Fingerprint, type Region} from './visual.ts';
import {buildSnapshot, diffSnapshots, keyboardTop, matches, onlyClosedKeyboard, resolveTarget, selectorFor, swipeArea, type Snapshot, type SnapshotDiff, type UiNode, type UiWindow} from './snapshot.ts';

export type ActResult = {action: string; target?: string; /** A hint when the action did something unexpected. */ note?: string; diff: SnapshotDiff; idle: boolean; ms: number; trace?: string; phases?: Record<string, number>; crashes?: AppEvent[]};

export type UiHooks = {
  /** Called before each action; returns the trace id the app will stamp on the requests it causes. */
  beforeAction?: () => string | undefined;
  /** Resolves when the app has no requests in flight (or after `timeoutMs`). */
  networkIdle?: (timeoutMs: number) => Promise<void>;
  /** JS errors the app reported since `since` (ms epoch), symbolicated. */
  jsErrors?: (since: number) => Promise<AppEvent[]>;
};

const quote = (s: string) => JSON.stringify(s);

export type FocusMap = {start: string; reached: number; focusable: number; unreached: string[]; traps: string[]; asymmetric: string[]; presses: number; complete: boolean; ms: number};

export type VisualResult = {name: string; status: 'saved' | 'match' | 'changed'; score?: number; changedShare?: number; regions?: Region[]; baseline: string; current?: string};

export type MediaResult = {target?: string; moving: boolean; black: boolean; playing: boolean; motion: number; luma: number};

/** An on-device runner: one request, one JSON answer. */
export type UiRunner = {
  call<T extends Record<string, unknown> = Record<string, unknown>>(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  stop(): Promise<void>;
};

/** Crashes of the app under test, collected in the background. */
export type CrashSource = {
  start(): void;
  stop(): void;
  /** Called when an action begins with the apps the last snapshot showed, for sources that compare before and after. */
  begin?(front?: string[]): void;
  /** `after`: the apps on screen once the action settled. */
  /** `final`: a failed flow asks; a crash just after the last action still has its report on the way. */
  since(t: number, after?: string[], final?: boolean): AppEvent[] | Promise<AppEvent[]>;
};

const noCrashes: CrashSource = {start: () => undefined, stop: () => undefined, since: () => []};

export class DeviceUi<R extends UiRunner = UiRunner> {
  readonly serial: string;
  readonly runner: R;
  last?: Snapshot;
  #size?: {width: number; height: number};
  /** Flow lines recorded since `record start`, or undefined when not recording. */
  recording?: string[];

  readonly #hooks: UiHooks;
  #trace?: string;

  readonly #crashes: CrashSource;

  constructor(serial: string, runner: R, hooks: UiHooks = {}, crashes: CrashSource = noCrashes) {
    this.#hooks = hooks;
    this.serial = serial;
    this.#crashes = crashes;
    this.#crashes.start();
    this.runner = runner;
  }

  async size() {
    if (!this.#size) {
      const info = await this.runner.call<{width: number; height: number}>('info');
      this.#size = {width: info.width, height: info.height};
    }
    return this.#size;
  }

  record(line: string) {
    this.recording?.push(line);
  }

  async snapshot(opts: {system?: boolean; bounds?: boolean} = {}): Promise<Snapshot> {
    const [tree, size] = await Promise.all([this.runner.call<{windows: UiWindow[]; nodes: UiNode[]}>('tree'), this.size()]);
    this.last = buildSnapshot(tree.windows, tree.nodes, {system: opts.system, bounds: opts.bounds, height: size.height});
    return this.last;
  }

  /**
   * Waits for the UI to go quiet and diffs. An action's effect can start after the first quiet window (a sheet
   * that animates on the next frame, a navigation that waits for a promise), so an unchanged screen is checked
   * again for a little while before it is reported as unchanged.
   */
  /** Where the last action's time went (ms per phase) — reported when the action was slow. */
  phases: Record<string, number> = {};

  #phase(name: string, since: number) {
    this.phases[name] = (this.phases[name] ?? 0) + (Date.now() - since);
    return Date.now();
  }

  async #settle(before: Snapshot | undefined, quietMs = 250, timeoutMs = 1200, graceMs = 1200): Promise<{diff: SnapshotDiff; idle: boolean}> {
    const t0 = Date.now();
    let t = t0;
    const r = await this.runner.call<{idle: boolean}>('idle', {quiet: quietMs, timeout: timeoutMs}, timeoutMs + 5000);
    t = this.#phase('quiet', t);
    if (this.#hooks.networkIdle) await this.#hooks.networkIdle(1500);
    t = this.#phase('network', t);
    let snap = await this.snapshot();
    t = this.#phase('snapshot', t);
    if (!r.idle) {
      // A UI that never goes quiet (a playing video, a looping animation): settled once the snapshot stops
      // changing, instead of waiting for silence that never comes.
      for (let i = 0; i < 4; i++) {
        await new Promise(res => setTimeout(res, 250));
        const next = await this.snapshot();
        const same = next.lines.join('\n') === snap.lines.join('\n');
        snap = next;
        if (same) break;
      }
      t = this.#phase('stabilise', t);
    }
    let diff = diffSnapshots(before, snap);
    while (!diff.changed && Date.now() - t0 < graceMs) {
      await new Promise(res => setTimeout(res, 250));
      diff = diffSnapshots(before, await this.snapshot());
    }
    this.#phase('grace', t);
    return {diff, idle: r.idle};
  }

  /** Resolves against the last snapshot for refs, against a fresh one for everything else. */
  async #target(selector: string) {
    const ref = /^@e\d+$/.test(selector.trim());
    let snap = ref && this.last ? this.last : await this.snapshot();
    // A target under the on-screen keyboard, or pushed out of a window the keyboard shrank (a car's keyboard
    // covers half the screen), is reached by hiding the keyboard first; tapping its coordinates would type a
    // letter instead.
    // Where the keyboard starts; 0 when its window is there but shows no views of its own size (a car's keyboard
    // exposes only its root).
    const imeShown = snap.nodes.some(n => snap.windows[n.w]?.type === 'ime');
    const top = ref || !imeShown ? undefined : (keyboardTop(snap, (await this.size()).height) ?? 0);
    let target: ReturnType<typeof resolveTarget> | undefined;
    try {
      target = resolveTarget(snap, selector);
    } catch (e) {
      if (top === undefined) throw e;
    }
    const covered = top !== undefined && (!target || (target.node && snap.windows[target.node.w]?.type !== 'ime' && target.y >= top));
    if (covered || !target) {
      await this.runner.call('key', {code: 4});
      await this.runner.call('idle', {quiet: 200, timeout: 1500}, 6000);
      snap = await this.snapshot();
      target = resolveTarget(snap, selector);
    }
    return {snap, target};
  }

  /** Crashes, ANRs and JS errors of the app since `since`, for an action's result. */
  async crashesSince(since: number, final = false): Promise<AppEvent[]> {
    const [native, js] = await Promise.all([Promise.resolve(this.#crashes.since(since, this.last?.windows.map(w => w.pkg), final)).catch(() => []), this.#hooks.jsErrors?.(since).catch(() => []) ?? []]);
    return [...native, ...js].sort((a, b) => a.at - b.at);
  }

  async #crashed(since: number) {
    const c = await this.crashesSince(since);
    return c.length ? {crashes: c} : {};
  }

  /** Tells the crash source which apps were on screen just before the input: the snapshot the action used. */
  #front(snap?: Snapshot) {
    this.#crashes.begin?.(snap?.windows.map(w => w.pkg));
  }

  #begin() {
    this.phases = {};
    this.#trace = this.#hooks.beforeAction?.();
    return Date.now();
  }

  async press(selector: string, kind: 'tap' | 'longpress' | 'doubletap' = 'tap'): Promise<ActResult> {
    const t0 = this.#begin();
    const {snap, target} = await this.#target(selector);
    this.#front(snap);
    let t = this.#phase('target', t0);
    await this.runner.call(kind, {x: target.x, y: target.y});
    t = this.#phase('input', t);
    if (target.index !== undefined) this.record(`${kind === 'tap' ? 'press' : kind} ${selectorFor(snap, target.index)}`);
    else this.record(`${kind === 'tap' ? 'press' : kind} ${target.x},${target.y}`);
    const settled = await this.#settle(snap);
    const note = this.last && onlyClosedKeyboard(snap, this.last) ? 'the tap closed the keyboard and nothing else changed: the control may not have got it (a list that spends the first tap on the keyboard; press again)' : undefined;
    return {action: kind, target: target.ref ?? `${target.x},${target.y}`, ...(note ? {note} : {}), ...settled, ms: Date.now() - t0, trace: this.#trace, phases: this.phases, ...(await this.#crashed(t0))};
  }

  async fill(selector: string, text: string): Promise<ActResult> {
    const t0 = this.#begin();
    const {snap, target} = await this.#target(selector);
    this.#front(snap);
    await this.runner.call('tap', {x: target.x, y: target.y});
    await this.runner.call('idle', {quiet: 150, timeout: 1000}, 6000);
    const editable = target.node && (target.node.f ?? '').includes('e');
    const r = await this.runner.call<{set: boolean}>('text', {text, ...(editable ? {bounds: target.node!.b} : {})});
    if (!r.set) throw new Error(`could not set text on "${selector}" — it is not an editable field and no field took focus`);
    this.record(`fill ${target.index !== undefined ? selectorFor(snap, target.index) : `${target.x},${target.y}`} ${quote(text)}`);
    const settled = await this.#settle(snap);
    return {action: 'fill', target: target.ref, ...settled, ms: Date.now() - t0, trace: this.#trace, phases: this.phases, ...(await this.#crashed(t0))};
  }

  async type(text: string): Promise<ActResult> {
    const t0 = this.#begin();
    const before = this.last;
    this.#front(before);
    const r = await this.runner.call<{set: boolean}>('text', {text, append: true});
    if (!r.set) throw new Error('no focused text field to type into');
    this.record(`type ${quote(text)}`);
    return {action: 'type', ...(await this.#settle(before)), ms: Date.now() - t0, trace: this.#trace, phases: this.phases, ...(await this.#crashed(t0))};
  }

  async key(keys: string[]): Promise<ActResult> {
    const t0 = this.#begin();
    const before = this.last ?? (await this.snapshot());
    this.#front(before);
    for (const k of keys) {
      const {code, meta} = keyOf(k, KEYS);
      await this.runner.call('key', meta ? {code, meta} : {code});
    }
    this.record(`key ${keys.join(' ')}`);
    return {action: 'key', target: keys.join(' '), ...(await this.#settle(before)), ms: Date.now() - t0, trace: this.#trace, phases: this.phases, ...(await this.#crashed(t0))};
  }

  /**
   * A mouse, for tablets, desktops and headsets: `right` clicks the secondary button on a target (context menus),
   * `hover` moves the pointer over it (tooltips, hover states), `wheel` turns the wheel `steps` notches up or down
   * over a target or the middle of the app's scroller.
   */
  async mouse(action: 'right' | 'hover' | 'wheel', selector?: string, opts: {direction?: 'up' | 'down'; steps?: number} = {}): Promise<ActResult> {
    const t0 = this.#begin();
    const before = this.last ?? (await this.snapshot());
    this.#front(before);
    let x: number;
    let y: number;
    let label: string;
    if (selector) {
      const {snap, target} = await this.#target(selector);
      x = target.x;
      y = target.y;
      label = target.index !== undefined ? selectorFor(snap, target.index) : `${x},${y}`;
    } else {
      if (action !== 'wheel') throw new Error(`mouse ${action} needs a target`);
      const {width, height} = await this.size();
      const [ax, ay, ax2, ay2] = swipeArea(before, width, height);
      x = Math.round((ax + ax2) / 2);
      y = Math.round((ay + ay2) / 2);
      label = '';
    }
    if (action === 'wheel') {
      const steps = Math.max(1, Math.min(opts.steps ?? 3, 50));
      // One notch per event, as a wheel sends them; negative scrolls the content down.
      for (let i = 0; i < steps; i++) await this.runner.call('mouse', {action: 'wheel', x, y, amount: opts.direction === 'up' ? 1 : -1});
      this.record(`mouse wheel ${opts.direction ?? 'down'} ${steps}${label ? ` ${label}` : ''}`);
    } else {
      await this.runner.call('mouse', {action, x, y});
      this.record(`mouse ${action} ${label}`);
    }
    return {action: `mouse ${action}`, target: label || undefined, ...(await this.#settle(before)), ms: Date.now() - t0, trace: this.#trace, phases: this.phases, ...(await this.#crashed(t0))};
  }

  /**
   * A watch crown or rotating bezel turned `steps` detents; `down` moves the content as a swipe up would. The
   * events go to the focused view: a scroller that never takes focus does not move (the app's bug, not the tool's).
   */
  async rotary(direction: 'up' | 'down', steps = 3): Promise<ActResult> {
    const t0 = this.#begin();
    const before = this.last ?? (await this.snapshot());
    this.#front(before);
    // Scrolling views read a positive AXIS_SCROLL as "towards the top".
    await this.runner.call('rotary', {amount: direction === 'down' ? -1 : 1, steps: Math.max(1, Math.min(steps, 50))}, 15_000);
    this.record(`rotary ${direction} ${steps}`);
    const settled = await this.#settle(before);
    const note = settled.diff.changed ? undefined : 'nothing moved: crown events go to the focused view, and no scroller has focus (a Wear OS app calls requestFocus() on it)';
    return {action: 'rotary', target: `${direction} ${steps}`, note, ...settled, ms: Date.now() - t0, trace: this.#trace, phases: this.phases, ...(await this.#crashed(t0))};
  }

  /**
   * Clicks a node of the system UI by its id, through accessibility rather than a tap: on XR each panel and its
   * caption have coordinates of their own, so a tap at a caption's bounds would land in the app. False when no
   * such node is on screen.
   */
  async clickSystem(id: string): Promise<boolean> {
    const tree = await this.runner.call<{windows: UiWindow[]; nodes: UiNode[]}>('tree', {all: true}, 30_000);
    const n = tree.nodes.find(x => x.id === id && tree.windows[x.w]?.pkg !== undefined);
    if (!n) return false;
    const r = await this.runner.call<{done: boolean}>('node-action', {window: n.w, bounds: n.b, action: 16}, 15_000);
    this.last = undefined;
    await new Promise(res => setTimeout(res, 800));
    return r.done;
  }

  /**
   * A touchpad that navigates rather than points (the temple of AI glasses): `forward`/`back`/`up`/`down`
   * swipes move the focus as D-pad keys would, `tap` presses the focused control.
   */
  async touchpad(gesture: 'forward' | 'back' | 'up' | 'down' | 'tap'): Promise<ActResult> {
    const t0 = this.#begin();
    const before = this.last ?? (await this.snapshot());
    this.#front(before);
    await this.runner.call('touchnav', {gesture});
    this.record(`touchpad ${gesture}`);
    return {action: 'touchpad', target: gesture, ...(await this.#settle(before)), ms: Date.now() - t0, trace: this.#trace, phases: this.phases, ...(await this.#crashed(t0))};
  }

  /** The screen changed shape (folded, rotated, resized): the next action measures it again. */
  screenChanged() {
    this.#size = undefined;
    this.last = undefined;
  }

  async swipe(spec: string, durationMs = 300): Promise<ActResult> {
    const t0 = this.#begin();
    const before = this.last ?? (await this.snapshot());
    this.#front(before);
    const {width, height} = await this.size();
    const [ax, ay, ax2, ay2] = swipeArea(before, width, height);
    const w = ax2 - ax;
    const h = ay2 - ay;
    const dirs: Record<string, [number, number, number, number]> = {
      up: [ax + w / 2, ay + h * 0.8, ax + w / 2, ay + h * 0.2],
      down: [ax + w / 2, ay + h * 0.2, ax + w / 2, ay + h * 0.8],
      left: [ax + w * 0.85, ay + h / 2, ax + w * 0.15, ay + h / 2],
      right: [ax + w * 0.15, ay + h / 2, ax + w * 0.85, ay + h / 2],
    };
    const coords = dirs[spec] ?? (spec.split(/[\s,]+/).map(Number) as [number, number, number, number]);
    if (coords.length !== 4 || coords.some(n => !Number.isFinite(n))) throw new Error('swipe up|down|left|right or "x1,y1,x2,y2"');
    const [x1, y1, x2, y2] = coords.map(Math.round) as [number, number, number, number];
    await this.runner.call('swipe', {x1, y1, x2, y2, duration: durationMs}, durationMs + 10_000);
    this.record(`swipe ${spec}${durationMs !== 300 ? ` ${durationMs}` : ''}`);
    return {action: 'swipe', target: spec, ...(await this.#settle(before)), ms: Date.now() - t0, trace: this.#trace, phases: this.phases, ...(await this.#crashed(t0))};
  }

  /**
   * A finger held between calls: `down` on a target, `move` to another, `up`. Each answers with what changed,
   * so a state that exists only while the finger is down (a scrubber's time label) can be seen.
   */
  async touch(phase: 'down' | 'move' | 'up', selector?: string): Promise<ActResult> {
    const t0 = this.#begin();
    let x = 0;
    let y = 0;
    let target: string | undefined;
    const before = this.last ?? (await this.snapshot());
    this.#front(before);
    if (phase !== 'up') {
      if (!selector) throw new Error(`touch ${phase} needs a target`);
      const r = await this.#target(selector);
      x = r.target.x;
      y = r.target.y;
      target = r.target.ref ?? `${x},${y}`;
    }
    await this.runner.call('touch', {phase, x, y});
    this.record(`touch ${phase}${selector ? ` ${selector}` : ''}`);
    const settled = await this.#settle(before, 150, 800, 300);
    return {action: `touch ${phase}`, target, ...settled, ms: Date.now() - t0, trace: this.#trace, phases: this.phases, ...(await this.#crashed(t0))};
  }

  /** Swipes in `direction` until `selector` is on screen or the content stops moving. */
  async scrollUntil(direction: string, selector: string, max = 25): Promise<ActResult> {
    const t0 = Date.now();
    const start = this.last;
    let snap = await this.snapshot();
    this.#front(snap);
    const swipeDir = {down: 'up', up: 'down', left: 'right', right: 'left'}[direction] ?? direction;
    for (let i = 0; i < max && !matches(snap, selector); i++) {
      const prev = snap.lines.join('\n');
      await this.runner.call('swipe', await this.#dirCoords(swipeDir, snap), 12_000);
      await this.runner.call('idle', {quiet: 200, timeout: 1500}, 6000);
      snap = await this.snapshot();
      if (snap.lines.join('\n') === prev) break;
    }
    if (!matches(snap, selector)) throw new Error(`scrolled ${direction} but "${selector}" never appeared`);
    this.record(`scroll ${direction} until ${selector}`);
    return {action: 'scroll', target: selector, diff: diffSnapshots(start, snap), idle: true, ms: Date.now() - t0, trace: this.#trace, phases: this.phases, ...(await this.#crashed(t0))};
  }

  async #dirCoords(dir: string, snap?: Snapshot) {
    const {width, height} = await this.size();
    const [ax, ay, ax2, ay2] = swipeArea(snap, width, height);
    const w = ax2 - ax;
    const h = ay2 - ay;
    // Shorter than a page: content that moved stays recognisable between snapshots.
    const c: Record<string, number[]> = {
      up: [ax + w / 2, ay + h * 0.75, ax + w / 2, ay + h * 0.3],
      down: [ax + w / 2, ay + h * 0.3, ax + w / 2, ay + h * 0.75],
      left: [ax + w * 0.8, ay + h / 2, ax + w * 0.3, ay + h / 2],
      right: [ax + w * 0.3, ay + h / 2, ax + w * 0.8, ay + h / 2],
    };
    const [x1, y1, x2, y2] = (c[dir] ?? c.up!).map(Math.round);
    // Unhurried: a short, fast drag starts no scroll on some screens (a 4K desktop display), while this one moves
    // the content everywhere.
    return {x1, y1, x2, y2, duration: 450};
  }

  /** A system dialog over everything ("System UI isn't responding", "… keeps stopping"), if there is one. */
  systemDialog(snap: Snapshot = this.last!): string | undefined {
    return snap?.windows.find(w => /isn.t responding|keeps stopping|has stopped/i.test(w.title))?.title;
  }

  /** Dismisses a system dialog: waits on a frozen app, closes a crashed one. */
  async dismissSystemDialog(): Promise<string | undefined> {
    const snap = await this.snapshot({system: true});
    const title = this.systemDialog(snap);
    if (!title) return undefined;
    // Wait keeps a frozen process alive; Close app only when there is nothing to wait for.
    const button = ['wait', 'close app', 'ok'].map(label => snap.nodes.find(n => (n.t ?? '').toLowerCase() === label)).find(Boolean);
    if (!button) return `"${title}" has no Wait / Close app button`;
    const x = Math.round((button.b[0] + button.b[2]) / 2);
    const y = Math.round((button.b[1] + button.b[3]) / 2);
    await this.runner.call('tap', {x, y});
    return `dismissed "${title}" with ${button.t}`;
  }

  /** Waits until `selector` matches (or stops matching with `gone`). */
  async wait(selector: string, opts: {gone?: boolean; timeoutMs?: number} = {}): Promise<{ms: number; snapshot: Snapshot}> {
    const t0 = Date.now();
    const deadline = t0 + (opts.timeoutMs ?? 10_000);
    let snap = await this.snapshot();
    let waitedOut = 0;
    while (matches(snap, selector) === !!opts.gone) {
      // A loaded machine makes the system UI miss its deadline ("System UI isn't responding"); Wait is what a
      // person would press, and the dialog would otherwise hide the screen until the wait times out.
      if (waitedOut < 3 && /isn.t responding/i.test(this.systemDialog(snap) ?? '')) {
        waitedOut++;
        await this.dismissSystemDialog().catch(() => undefined);
      }
      if (Date.now() > deadline) {
        const dialog = this.systemDialog(snap);
        throw new Error(`timed out after ${Math.round((opts.timeoutMs ?? 10_000) / 1000)}s waiting for ${opts.gone ? `"${selector}" to go` : `"${selector}"`}${dialog ? ` — a system dialog is on top: "${dialog}" (doctor fix=true dismisses it)` : ''}`);
      }
      await new Promise(r => setTimeout(r, 300));
      snap = await this.snapshot();
    }
    this.record(`wait ${opts.gone ? 'gone ' : ''}${selector}`);
    return {ms: Date.now() - t0, snapshot: snap};
  }

  /**
   * Is the region of a node (or the screen) moving, and is it black? Frames are compared on the device.
   * playing: something moves and it is not black; paused: nothing moves.
   */
  async media(selector?: string, opts: {count?: number; intervalMs?: number} = {}): Promise<MediaResult> {
    let bounds: [number, number, number, number] | undefined;
    let target: string | undefined;
    if (selector) {
      const {target: t} = await this.#target(selector);
      if (!t.node) throw new Error('media needs a node, not a point');
      bounds = t.node.b;
      target = t.ref;
    }
    const r = await this.runner.call<{luma: number[]; diff: number[]}>('frames', {bounds, count: opts.count ?? 4, interval: opts.intervalMs ?? 400}, 30_000);
    const motion = Math.max(0, ...r.diff);
    const luma = r.luma.reduce((a, b) => a + b, 0) / Math.max(1, r.luma.length);
    const black = luma < 8;
    const moving = motion > 1.5;
    return {target, moving, black, playing: moving && !black, motion: Math.round(motion * 10) / 10, luma: Math.round(luma)};
  }

  /**
   * Walks the screen with the D-pad from the current focus: from every node it reaches it tries the four
   * directions and steps back. Reports focusable nodes never reached, nodes focus cannot leave, and moves that
   * do not reverse (right goes to B, left from B does not come back). Bounded by `maxPresses`.
   */
  async focusMap(maxPresses = 150): Promise<FocusMap> {
    const t0 = Date.now();
    const text = (n: UiNode) => n.t ?? n.d;
    const label = (n?: UiNode) => (n ? (n.id ? `#${n.id}${text(n) ? ` ${JSON.stringify(text(n))}` : ''}` : n.t ? JSON.stringify(n.t) : n.d ? `(${n.d})` : `@[${n.b.join(',')}]`) : 'nothing');
    // Ids are stable while a rail scrolls; bounds are not.
    // Ids and texts are stable while a list or rail scrolls under the focus; bounds are not. The text also tells
    // apart cells that share one id (a grid of `AppCell`s). Bounds only for a node with neither.
    const keyOf = (n?: UiNode) => (n ? (n.id ? `#${n.id}|${text(n) ?? ''}` : text(n) ? `"${text(n)}"` : `@${n.b.join(',')}`) : 'none');
    const opposite: Record<string, string> = {up: 'down', down: 'up', left: 'right', right: 'left'};
    const codes: Record<string, number> = {up: 19, down: 20, left: 21, right: 22};
    let presses = 0;
    const current = async () => (await this.runner.call<{input?: UiNode}>('focus')).input;
    const press = async (dir: string) => {
      presses++;
      await this.runner.call('key', {code: codes[dir]});
      await this.runner.call('idle', {quiet: 120, timeout: 700}, 5000);
      return current();
    };
    const seen = new Map<string, UiNode>();
    const edges = new Map<string, Map<string, string>>();
    const asymmetric: string[] = [];
    const start = await current();
    if (!start) throw new Error('nothing has input focus — press a D-pad key first, or this screen has no focusable nodes');
    seen.set(keyOf(start), start);
    const visit = async (node: UiNode): Promise<void> => {
      const k = keyOf(node);
      const out = new Map<string, string>();
      edges.set(k, out);
      for (const dir of ['right', 'down', 'left', 'up']) {
        if (presses >= maxPresses) return;
        const next = await press(dir);
        const nk = keyOf(next);
        out.set(dir, nk);
        if (nk === k || !next) continue;
        const isNew = !seen.has(nk);
        seen.set(nk, next);
        if (isNew) await visit(next);
        if (presses >= maxPresses) return;
        // Step back to where this direction started.
        const back = await press(opposite[dir]!);
        if (keyOf(back) !== k) {
          asymmetric.push(`${label(node)} —${dir}→ ${label(next)}, but ${opposite[dir]} from there → ${label(back)}`);
          return;
        }
      }
    };
    await visit(start);
    const snap = await this.snapshot();
    const focusable = snap.nodes.filter(n => (n.f ?? '').includes('f') && !(n.f ?? '').includes('d'));
    const unreached = focusable.filter(n => !seen.has(keyOf(n)));
    const traps = [...edges.entries()].filter(([k, out]) => out.size === 4 && [...out.values()].every(v => v === k)).map(([k]) => label(seen.get(k)));
    return {start: label(start), reached: seen.size, focusable: focusable.length, unreached: unreached.map(label), traps, asymmetric, presses, complete: presses < maxPresses, ms: Date.now() - t0};
  }

  /**
   * Compares the screen with a stored baseline (`dir/name.json` plus a JPEG to look at), or stores it when there
   * is none or `update` is set. Masked targets (a video, a clock) are blanked on both sides.
   */
  async visual(name: string, dir: string, opts: {update?: boolean; masks?: string[]} = {}): Promise<VisualResult> {
    const snap = await this.snapshot();
    const masks = (opts.masks ?? []).map(m => {
      const t = resolveTarget(snap, m);
      if (!t.node) throw new Error(`mask "${m}" must be a node`);
      return t.node.b;
    });
    const fp = await this.runner.call<Fingerprint>('fingerprint', {cols: 54, masks}, 20_000);
    const base = path.join(dir, `${name}.json`);
    fs.mkdirSync(dir, {recursive: true});
    if (opts.update || !fs.existsSync(base)) {
      fs.writeFileSync(base, JSON.stringify({cols: fp.cols, rows: fp.rows, width: fp.width, height: fp.height, grid: fp.grid}));
      await this.screenshot(path.join(dir, `${name}.jpg`), 0.5, 75);
      this.record(`visual ${name}${(opts.masks ?? []).map(m => ` mask ${m}`).join('')}`);
      return {name, status: 'saved', baseline: base};
    }
    const diff = compareFingerprints(JSON.parse(fs.readFileSync(base, 'utf8')) as Fingerprint, fp);
    this.record(`visual ${name}${(opts.masks ?? []).map(m => ` mask ${m}`).join('')}`);
    if (diff.same) return {name, status: 'match', score: diff.score, changedShare: diff.changedShare, baseline: base};
    const current = path.join(dir, `${name}.current.jpg`);
    await this.screenshot(current, 0.5, 75);
    return {name, status: 'changed', score: diff.score, changedShare: diff.changedShare, regions: diff.regions, baseline: base, current};
  }

  async focus(): Promise<{input?: UiNode; accessibility?: UiNode}> {
    return this.runner.call('focus');
  }

  async screenshot(file: string, scale = 0.4, quality = 70): Promise<{file: string; width: number; height: number; kb: number}> {
    const r = await this.runner.call<{jpeg: string; width: number; height: number}>('screenshot', {scale, quality}, 20_000);
    const buf = Buffer.from(r.jpeg, 'base64');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, buf);
    return {file, width: r.width, height: r.height, kb: Math.round(buf.length / 1024)};
  }

  async stop() {
    this.#crashes.stop();
    await this.runner.stop();
  }
}
