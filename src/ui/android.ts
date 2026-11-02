// UI automation on one Android device through the runner: snapshots, actions that settle and answer with what
// changed, waits, scrolling to a target, focus (TV), downscaled screenshots, and recording into a flow.

import fs from 'node:fs';
import path from 'node:path';
import {KEYS, type AndroidDriver} from '../drivers/android/driver.ts';
import {AndroidRunner} from '../drivers/android/runner.ts';
import {buildSnapshot, diffSnapshots, matches, resolveTarget, selectorFor, type Snapshot, type SnapshotDiff, type UiNode, type UiWindow} from './snapshot.ts';

export type ActResult = {action: string; target?: string; diff: SnapshotDiff; idle: boolean; ms: number};

const quote = (s: string) => JSON.stringify(s);

export class AndroidUi {
  readonly serial: string;
  readonly runner: AndroidRunner;
  last?: Snapshot;
  #size?: {width: number; height: number};
  /** Flow lines recorded since `record start`, or undefined when not recording. */
  recording?: string[];

  constructor(driver: AndroidDriver, serial: string) {
    this.serial = serial;
    this.runner = new AndroidRunner(driver, serial);
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

  async snapshot(opts: {system?: boolean} = {}): Promise<Snapshot> {
    const [tree, size] = await Promise.all([this.runner.call<{windows: UiWindow[]; nodes: UiNode[]}>('tree'), this.size()]);
    this.last = buildSnapshot(tree.windows, tree.nodes, {system: opts.system, height: size.height});
    return this.last;
  }

  /**
   * Waits for the UI to go quiet and diffs. An action's effect can start after the first quiet window (a sheet
   * that animates on the next frame, a navigation that waits for a promise), so an unchanged screen is checked
   * again for a little while before it is reported as unchanged.
   */
  async #settle(before: Snapshot | undefined, quietMs = 250, timeoutMs = 2500, graceMs = 1200): Promise<{diff: SnapshotDiff; idle: boolean}> {
    const t0 = Date.now();
    const r = await this.runner.call<{idle: boolean}>('idle', {quiet: quietMs, timeout: timeoutMs}, timeoutMs + 5000);
    let diff = diffSnapshots(before, await this.snapshot());
    while (!diff.changed && Date.now() - t0 < graceMs) {
      await new Promise(res => setTimeout(res, 200));
      await this.runner.call('idle', {quiet: 150, timeout: 1500}, 6000);
      diff = diffSnapshots(before, await this.snapshot());
    }
    return {diff, idle: r.idle};
  }

  /** Resolves against the last snapshot for refs, against a fresh one for everything else. */
  async #target(selector: string) {
    const snap = /^@e\d+$/.test(selector.trim()) && this.last ? this.last : await this.snapshot();
    return {snap, target: resolveTarget(snap, selector)};
  }

  async press(selector: string, kind: 'tap' | 'longpress' | 'doubletap' = 'tap'): Promise<ActResult> {
    const t0 = Date.now();
    const {snap, target} = await this.#target(selector);
    await this.runner.call(kind, {x: target.x, y: target.y});
    if (target.index !== undefined) this.record(`${kind === 'tap' ? 'press' : kind} ${selectorFor(snap, target.index)}`);
    else this.record(`${kind === 'tap' ? 'press' : kind} ${target.x},${target.y}`);
    const settled = await this.#settle(snap);
    return {action: kind, target: target.ref ?? `${target.x},${target.y}`, ...settled, ms: Date.now() - t0};
  }

  async fill(selector: string, text: string): Promise<ActResult> {
    const t0 = Date.now();
    const {snap, target} = await this.#target(selector);
    await this.runner.call('tap', {x: target.x, y: target.y});
    await this.runner.call('idle', {quiet: 150, timeout: 1000}, 6000);
    const editable = target.node && (target.node.f ?? '').includes('e');
    const r = await this.runner.call<{set: boolean}>('text', {text, ...(editable ? {bounds: target.node!.b} : {})});
    if (!r.set) throw new Error(`could not set text on "${selector}" — it is not an editable field and no field took focus`);
    this.record(`fill ${target.index !== undefined ? selectorFor(snap, target.index) : `${target.x},${target.y}`} ${quote(text)}`);
    const settled = await this.#settle(snap);
    return {action: 'fill', target: target.ref, ...settled, ms: Date.now() - t0};
  }

  async type(text: string): Promise<ActResult> {
    const t0 = Date.now();
    const before = this.last;
    const r = await this.runner.call<{set: boolean}>('text', {text, append: true});
    if (!r.set) throw new Error('no focused text field to type into');
    this.record(`type ${quote(text)}`);
    return {action: 'type', ...(await this.#settle(before)), ms: Date.now() - t0};
  }

  async key(keys: string[]): Promise<ActResult> {
    const t0 = Date.now();
    const before = this.last ?? (await this.snapshot());
    for (const k of keys) {
      const code = KEYS[k.toLowerCase()] ?? Number(k);
      if (!Number.isInteger(code)) throw new Error(`unknown key: ${k} (known: ${Object.keys(KEYS).join(', ')} or a keycode)`);
      await this.runner.call('key', {code});
    }
    this.record(`key ${keys.join(' ')}`);
    return {action: 'key', target: keys.join(' '), ...(await this.#settle(before)), ms: Date.now() - t0};
  }

  async swipe(spec: string, durationMs = 300): Promise<ActResult> {
    const t0 = Date.now();
    const before = this.last ?? (await this.snapshot());
    const {width: w, height: h} = await this.size();
    const dirs: Record<string, [number, number, number, number]> = {
      up: [w / 2, h * 0.72, w / 2, h * 0.28],
      down: [w / 2, h * 0.28, w / 2, h * 0.72],
      left: [w * 0.8, h / 2, w * 0.2, h / 2],
      right: [w * 0.2, h / 2, w * 0.8, h / 2],
    };
    const coords = dirs[spec] ?? (spec.split(/[\s,]+/).map(Number) as [number, number, number, number]);
    if (coords.length !== 4 || coords.some(n => !Number.isFinite(n))) throw new Error('swipe up|down|left|right or "x1,y1,x2,y2"');
    const [x1, y1, x2, y2] = coords.map(Math.round) as [number, number, number, number];
    await this.runner.call('swipe', {x1, y1, x2, y2, duration: durationMs}, durationMs + 10_000);
    this.record(`swipe ${spec}${durationMs !== 300 ? ` ${durationMs}` : ''}`);
    return {action: 'swipe', target: spec, ...(await this.#settle(before)), ms: Date.now() - t0};
  }

  /** Swipes in `direction` until `selector` is on screen or the content stops moving. */
  async scrollUntil(direction: string, selector: string, max = 8): Promise<ActResult> {
    const t0 = Date.now();
    const start = this.last;
    let snap = await this.snapshot();
    const swipeDir = {down: 'up', up: 'down', left: 'right', right: 'left'}[direction] ?? direction;
    for (let i = 0; i < max && !matches(snap, selector); i++) {
      const prev = snap.lines.join('\n');
      await this.runner.call('swipe', await this.#dirCoords(swipeDir), 12_000);
      await this.runner.call('idle', {quiet: 200, timeout: 1500}, 6000);
      snap = await this.snapshot();
      if (snap.lines.join('\n') === prev) break;
    }
    if (!matches(snap, selector)) throw new Error(`scrolled ${direction} but "${selector}" never appeared`);
    this.record(`scroll ${direction} until ${selector}`);
    return {action: 'scroll', target: selector, diff: diffSnapshots(start, snap), idle: true, ms: Date.now() - t0};
  }

  async #dirCoords(dir: string) {
    const {width: w, height: h} = await this.size();
    const c: Record<string, number[]> = {up: [w / 2, h * 0.7, w / 2, h * 0.35], down: [w / 2, h * 0.35, w / 2, h * 0.7], left: [w * 0.8, h / 2, w * 0.3, h / 2], right: [w * 0.3, h / 2, w * 0.8, h / 2]};
    const [x1, y1, x2, y2] = (c[dir] ?? c.up!).map(Math.round);
    return {x1, y1, x2, y2, duration: 250};
  }

  /** Waits until `selector` matches (or stops matching with `gone`). */
  async wait(selector: string, opts: {gone?: boolean; timeoutMs?: number} = {}): Promise<{ms: number; snapshot: Snapshot}> {
    const t0 = Date.now();
    const deadline = t0 + (opts.timeoutMs ?? 10_000);
    let snap = await this.snapshot();
    while (matches(snap, selector) === !!opts.gone) {
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${Math.round((opts.timeoutMs ?? 10_000) / 1000)}s waiting for ${opts.gone ? `"${selector}" to go` : `"${selector}"`}`);
      }
      await new Promise(r => setTimeout(r, 300));
      snap = await this.snapshot();
    }
    this.record(`wait ${opts.gone ? 'gone ' : ''}${selector}`);
    return {ms: Date.now() - t0, snapshot: snap};
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
    await this.runner.stop();
  }
}
