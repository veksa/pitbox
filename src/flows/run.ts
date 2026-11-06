// Executes a flow against a host (the daemon's engine). Stops at the first failing step and reports it with
// what is on screen, so the caller can act without taking another snapshot.

import type {DeviceUi} from '../ui/device.ts';
import {closest, matches, resolveTarget, type Snapshot} from '../ui/snapshot.ts';
import {checkBudgets, parseBudget, type PerfData} from './budget.ts';
import {kvArgs, parseFlow, unquote, validateFlow, type Step} from './flow.ts';
import {seconds as fmtSeconds} from '../util/text.ts';

export type FlowHost = {
  ui: () => Promise<DeviceUi>;
  /** Opens the app; a cold start reports how long the activity and the JS took to come up. */
  open: (target: string | undefined, relaunch: boolean) => Promise<{activityMs?: number; jsMs?: number} | void>;
  goto: (route: string, params: Record<string, string>) => Promise<void>;
  signIn: (user: string) => Promise<FlowResult>;
  tool: (name: string, params: Record<string, string>) => Promise<{code: number | null; output: string}>;
  loadFlow: (name: string) => string;
  state: (name: string) => Promise<void>;
  /** Moves the following steps to another device (serial, AVD name or model). */
  setDevice: (name: string) => Promise<void>;
  visual: (name: string, masks: string[]) => Promise<{status: string; score?: number; regions?: number[][]; current?: string}>;
  screenshot: (name?: string, full?: boolean) => Promise<string>;
  /** Folds, rotates or re-windows the device (Android): posture, rotate, window. */
  reshape: (op: 'posture' | 'rotate' | 'window' | 'wear' | 'xr' | 'car', value: string) => Promise<unknown>;
  /** Starts a perf window (`reset`), or ends it with the numbers and their text as `perf` prints it. */
  perf: (reset: boolean, trace?: boolean) => Promise<{data: PerfData; text: string}>;
  /** JS errors the app reported since `since`: a passing flow still mentions them. */
  jsErrors?: (since: number) => Promise<{summary: string; lines: string[]}[]>;
};

export type FlowResult = {
  ok: boolean;
  steps: number;
  ms: number;
  failed?: {line: number; step: string; error: string; /** The step with the selector that broke swapped for the one control on screen most like it: a suggestion to check, never applied. */ fix?: string; screen?: string[]; screenshot?: string; crashes?: {kind: string; summary: string; lines: string[]}[]};
  notes: string[];
};

const DEFAULT_EXPECT_SECONDS = 5;

const seconds = (s: string | undefined, fallback: number) => {
  const n = s === undefined ? NaN : Number(s);
  return Number.isFinite(n) ? n * 1000 : fallback * 1000;
};

/** A cold start (`open!`) waiting for the first check after it, which marks the first screen. */
type ColdStart = {pending?: {t0: number; activityMs?: number; jsMs?: number}};

const coldNote = (c: NonNullable<ColdStart['pending']>, first?: Step) =>
  `cold start: ${[
    c.activityMs !== undefined ? `activity ${c.activityMs} ms` : '',
    c.jsMs !== undefined ? `JS running at ${fmtSeconds(c.jsMs)}` : '',
    first ? `${first.text} at ${fmtSeconds(Date.now() - c.t0)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')}`;

/** A step's argument that names something (a device, a window, a state): quotes are the flow's, not the name's. */
const words = (a: string[]): string => a.map(unquote).join(' ');

const runStep = async (host: FlowHost, s: Step, notes: string[], depth: number, cold: ColdStart = {}): Promise<void> => {
  const a = s.args;
  switch (s.cmd) {
    case 'open':
    case 'open!': {
      const t0 = Date.now();
      const r = await host.open(a[0] ? unquote(a[0]) : undefined, s.cmd === 'open!');
      if (s.cmd === 'open!') cold.pending = {t0, activityMs: r?.activityMs, jsMs: r?.jsMs};
      return;
    }
    case 'goto':
      return host.goto(unquote(a[0]!), kvArgs(a.slice(1)));
    case 'posture':
    case 'rotate':
    case 'window':
    case 'wear':
    case 'xr':
    case 'car':
      await host.reshape(s.cmd, words(a));
      return;
    case 'touchpad':
      await (await host.ui()).touchpad(a[0] as 'forward' | 'back' | 'up' | 'down' | 'tap');
      return;
    case 'rotary':
      await (await host.ui()).rotary(a[0] === 'up' ? 'up' : 'down', a[1] ? Number(a[1]) : 3);
      return;
    case 'mouse': {
      const ui = await host.ui();
      if (a[0] === 'wheel') {
        const steps = /^\d+$/.test(a[2] ?? '') ? Number(a[2]) : undefined;
        await ui.mouse('wheel', a.slice(steps === undefined ? 2 : 3).join(' ') || undefined, {direction: a[1] === 'up' ? 'up' : 'down', steps});
      } else await ui.mouse(a[0] as 'right' | 'hover', a.slice(1).join(' '));
      return;
    }
    case 'as': {
      const r = await host.signIn(unquote(a[0]!));
      if (!r.ok) throw new Error(`sign-in as ${a[0]} failed at line ${r.failed?.line}: ${r.failed?.error}`);
      return;
    }
    case 'press':
    case 'longpress':
    case 'doubletap':
      {
        const r = await (await host.ui()).press(a.join(' '), s.cmd === 'press' ? 'tap' : s.cmd);
        if (r?.note) notes.push(`line ${s.line} (${s.text}): ${r.note}`);
      }
      return;
    case 'press?': {
      // A sheet that may or may not come (a permission prompt, a one-time tip): pressed when it shows within the seconds given (default 3), skipped otherwise.
      const last = a[a.length - 1];
      const hasTimeout = a.length > 1 && /^\d+(\.\d+)?$/.test(last ?? '');
      const selector = (hasTimeout ? a.slice(0, -1) : a).join(' ');
      const ui = await host.ui();
      try {
        await ui.wait(selector, {timeoutMs: seconds(hasTimeout ? last : undefined, 3)});
      } catch {
        return;
      }
      await ui.press(selector, 'tap');
      return;
    }
    case 'fill':
      await (await host.ui()).fill(a.slice(0, -1).join(' '), unquote(a[a.length - 1]!));
      return;
    case 'type':
      await (await host.ui()).type(unquote(a.join(' ')));
      return;
    case 'key': {
      const r = await (await host.ui()).key(a);
      if (r?.note) notes.push(`line ${s.line} (${s.text}): ${r.note}`);
      return;
    }
    case 'touch':
      await (await host.ui()).touch(a[0] as 'down' | 'move' | 'up', a.slice(1).join(' ') || undefined);
      return;
    case 'swipe': {
      const ms = a.length > 1 && /^\d+$/.test(a[a.length - 1]!) && !a[0]!.includes(',') ? Number(a[a.length - 1]) : 300;
      await (await host.ui()).swipe(a[0]!, ms);
      return;
    }
    case 'scroll':
      await (await host.ui()).scrollUntil(a[0]!, a.slice(2).join(' '));
      return;
    case 'wait': {
      const gone = a[0] === 'gone';
      const rest = gone ? a.slice(1) : a;
      const last = rest[rest.length - 1];
      const hasTimeout = rest.length > 1 && /^\d+(\.\d+)?$/.test(last ?? '');
      await (await host.ui()).wait((hasTimeout ? rest.slice(0, -1) : rest).join(' '), {gone, timeoutMs: seconds(hasTimeout ? last : undefined, 10)});
      return;
    }
    case 'perf':
      await host.perf(true, a[0] === 'trace');
      return;
    case 'expect': {
      if (a[0] === 'perf') {
        const budgets = a.slice(1).map(parseBudget);
        const {data, text} = await host.perf(false);
        const r = checkBudgets(data, budgets);
        if (!r.ok) throw new Error(`over budget: ${r.lines.filter(l => !l.includes(' ✓ ')).join('; ')}\n${text}`);
        notes.push(`perf: ${r.lines.join(' · ')}`);
        return;
      }
      const ui = await host.ui();
      if (a[0] === 'focus') {
        const want = resolveTarget(await ui.snapshot(), a.slice(1).join(' '));
        const f = await ui.focus();
        const b = f.input?.b;
        if (!b || !want.node || b.join() !== want.node.b.join()) {
          throw new Error(`focus is on ${f.input ? JSON.stringify({id: f.input.id, t: f.input.t, d: f.input.d}) : 'nothing'}, expected ${a.slice(1).join(' ')}`);
        }
        return;
      }
      if (a[0] === 'playing' || a[0] === 'paused') {
        const sel = a.slice(1).join(' ') || undefined;
        // A player needs a moment to start; give "playing" a few tries.
        let m = await ui.media(sel);
        for (let i = 0; a[0] === 'playing' && !m.playing && i < 3; i++) m = await ui.media(sel);
        if (a[0] === 'playing' && !m.playing) throw new Error(`not playing: ${m.black ? 'black' : 'no motion'} (motion ${m.motion}, brightness ${m.luma})`);
        if (a[0] === 'paused' && m.moving) throw new Error(`still moving (motion ${m.motion})`);
        return;
      }
      const gone = a[0] === 'gone';
      const sel = (gone ? a.slice(1) : a).join(' ');
      const snap = await ui.snapshot();
      if (matches(snap, sel) !== gone) return;
      await ui.wait(sel, {gone, timeoutMs: DEFAULT_EXPECT_SECONDS * 1000});
      return;
    }
    case 'tool': {
      const i = a.indexOf('contains');
      const params = kvArgs(i >= 0 ? a.slice(1, i) : a.slice(1));
      const r = await host.tool(unquote(a[0]!), params);
      if (r.code !== 0) throw new Error(`tool ${a[0]} exited ${r.code}: ${r.output.split('\n').slice(-3).join(' ')}`);
      if (i >= 0) {
        const want = unquote(a.slice(i + 1).join(' '));
        if (!r.output.includes(want)) throw new Error(`tool ${a[0]} output does not contain ${JSON.stringify(want)}: ${r.output.slice(0, 300)}`);
      }
      return;
    }
    case 'visual': {
      // visual <name> [mask <selector>]…
      const masks: string[] = [];
      for (let i = 1; i < a.length; i++) if (a[i] === 'mask' && a[i + 1]) masks.push(a[++i]!);
      const r = await host.visual(unquote(a[0]!), masks);
      if (r.status === 'changed') throw new Error(`screen differs from baseline ${a[0]} (score ${r.score}; regions ${(r.regions ?? []).map(x => `[${x.join(',')}]`).join(' ')}); current: ${r.current}`);
      if (r.status === 'saved') notes.push(`baseline saved: ${a[0]}`);
      return;
    }
    case 'device':
      await host.setDevice(words(a));
      return;
    case 'state':
      await host.state(unquote(a[0]!));
      return;
    case 'sleep':
      await new Promise(r => setTimeout(r, Number(a[0])));
      return;
    case 'screenshot':
      notes.push(`screenshot: ${await host.screenshot(a[0] === undefined ? undefined : unquote(a[0]), a[1] === 'full')}`);
      return;
    case 'run': {
      if (depth > 5) throw new Error('flows nested too deep');
      const r = await runFlow(host, host.loadFlow(unquote(a[0]!)), kvArgs(a.slice(1)), depth + 1);
      if (!r.ok) throw new Error(`${a[0]} failed at line ${r.failed?.line} (${r.failed?.step}): ${r.failed?.error}`);
      return;
    }
    default:
      throw new Error(`unknown step "${s.cmd}"`);
  }
};

/** The selector a step's error says matched nothing, or never showed up in time. */
const missedSelector = (error: string): string | undefined => /^(?:nothing matches|timed out after \d+s waiting for) "(.*?)"(?= — |$)/.exec(error)?.[1];

/**
 * The failed step with its selector replaced by the control on screen most like it, when one stands out from the
 * rest. Only a suggestion: a step is never run against a control it did not name.
 */
export const suggestFix = (step: Step, error: string, snap: Snapshot): string | undefined => {
  const sel = missedSelector(error);
  if (!sel || !step.text.includes(sel)) return undefined;
  const [best, next] = closest(snap, sel, 2);
  if (!best?.selector || (next && best.score - next.score < 0.1)) return undefined;
  return step.text.replace(sel, best.selector);
};

export const runFlow = async (host: FlowHost, source: string, params: Record<string, string> = {}, depth = 0): Promise<FlowResult> => {
  const t0 = Date.now();
  const notes: string[] = [];
  const steps = parseFlow(source, params);
  const errors = validateFlow(steps);
  if (errors.length) return {ok: false, steps: 0, ms: 0, failed: {line: 0, step: 'validate', error: errors.join('; ')}, notes};
  let done = 0;
  const cold: ColdStart = {};
  for (const s of steps) {
    try {
      await runStep(host, s, notes, depth, cold);
      done++;
      if (cold.pending && (s.cmd === 'wait' || s.cmd === 'expect') && s.args[0] !== 'gone') {
        notes.push(coldNote(cold.pending, s));
        cold.pending = undefined;
      }
    } catch (e) {
      const failed: NonNullable<FlowResult['failed']> = {line: s.line, step: s.text, error: (e as Error).message};
      if (depth === 0) {
        try {
          const ui = await host.ui();
          const crashes = await ui.crashesSince(t0, true);
          if (crashes.length) failed.crashes = crashes;
          const snap = await ui.snapshot();
          failed.screen = snap.lines.slice(0, 40);
          const fix = suggestFix(s, failed.error, snap);
          if (fix) failed.fix = `line ${s.line}: ${fix}`;
          failed.screenshot = await host.screenshot(`failed-line-${s.line}`);
        } catch {
          // the device itself may be the problem
        }
      }
      return {ok: false, steps: done, ms: Date.now() - t0, failed, notes};
    }
  }
  if (cold.pending) notes.push(coldNote(cold.pending));
  if (depth === 0 && host.jsErrors) {
    for (const e of await host.jsErrors(t0).catch(() => [])) notes.push(`! JS error: ${e.summary}`, ...e.lines.slice(0, 3).map(l => `    ${l}`));
  }
  return {ok: true, steps: done, ms: Date.now() - t0, notes};
};
