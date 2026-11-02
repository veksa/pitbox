// Executes a flow against a host (the daemon's engine). Stops at the first failing step and reports it with
// what is on screen, so the caller can act without taking another snapshot.

import type {AndroidUi} from '../ui/android.ts';
import {matches, resolveTarget} from '../ui/snapshot.ts';
import {kvArgs, parseFlow, unquote, validateFlow, type Step} from './flow.ts';

export type FlowHost = {
  ui: () => Promise<AndroidUi>;
  open: (target: string | undefined, relaunch: boolean) => Promise<void>;
  goto: (route: string, params: Record<string, string>) => Promise<void>;
  signIn: (user: string) => Promise<FlowResult>;
  tool: (name: string, params: Record<string, string>) => Promise<{code: number | null; output: string}>;
  loadFlow: (name: string) => string;
  screenshot: (name?: string) => Promise<string>;
};

export type FlowResult = {
  ok: boolean;
  steps: number;
  ms: number;
  failed?: {line: number; step: string; error: string; screen?: string[]; screenshot?: string};
  notes: string[];
};

const DEFAULT_EXPECT_SECONDS = 5;

const seconds = (s: string | undefined, fallback: number) => {
  const n = s === undefined ? NaN : Number(s);
  return Number.isFinite(n) ? n * 1000 : fallback * 1000;
};

const runStep = async (host: FlowHost, s: Step, notes: string[], depth: number): Promise<void> => {
  const a = s.args;
  switch (s.cmd) {
    case 'open':
    case 'open!':
      return host.open(a[0] ? unquote(a[0]) : undefined, s.cmd === 'open!');
    case 'goto':
      return host.goto(a[0]!, kvArgs(a.slice(1)));
    case 'as': {
      const r = await host.signIn(unquote(a[0]!));
      if (!r.ok) throw new Error(`sign-in as ${a[0]} failed at line ${r.failed?.line}: ${r.failed?.error}`);
      return;
    }
    case 'press':
    case 'longpress':
    case 'doubletap':
      await (await host.ui()).press(a.join(' '), s.cmd === 'press' ? 'tap' : s.cmd);
      return;
    case 'fill':
      await (await host.ui()).fill(a.slice(0, -1).join(' '), unquote(a[a.length - 1]!));
      return;
    case 'type':
      await (await host.ui()).type(unquote(a.join(' ')));
      return;
    case 'key':
      await (await host.ui()).key(a);
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
    case 'expect': {
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
      const r = await host.tool(a[0]!, params);
      if (r.code !== 0) throw new Error(`tool ${a[0]} exited ${r.code}: ${r.output.split('\n').slice(-3).join(' ')}`);
      if (i >= 0) {
        const want = unquote(a.slice(i + 1).join(' '));
        if (!r.output.includes(want)) throw new Error(`tool ${a[0]} output does not contain ${JSON.stringify(want)}: ${r.output.slice(0, 300)}`);
      }
      return;
    }
    case 'sleep':
      await new Promise(r => setTimeout(r, Number(a[0])));
      return;
    case 'screenshot':
      notes.push(`screenshot: ${await host.screenshot(a[0])}`);
      return;
    case 'run': {
      if (depth > 5) throw new Error('flows nested too deep');
      const r = await runFlow(host, host.loadFlow(a[0]!), kvArgs(a.slice(1)), depth + 1);
      if (!r.ok) throw new Error(`${a[0]} failed at line ${r.failed?.line} (${r.failed?.step}): ${r.failed?.error}`);
      return;
    }
    default:
      throw new Error(`unknown step "${s.cmd}"`);
  }
};

export const runFlow = async (host: FlowHost, source: string, params: Record<string, string> = {}, depth = 0): Promise<FlowResult> => {
  const t0 = Date.now();
  const notes: string[] = [];
  const steps = parseFlow(source, params);
  const errors = validateFlow(steps);
  if (errors.length) return {ok: false, steps: 0, ms: 0, failed: {line: 0, step: 'validate', error: errors.join('; ')}, notes};
  let done = 0;
  for (const s of steps) {
    try {
      await runStep(host, s, notes, depth);
      done++;
    } catch (e) {
      const failed: NonNullable<FlowResult['failed']> = {line: s.line, step: s.text, error: (e as Error).message};
      if (depth === 0) {
        try {
          const ui = await host.ui();
          failed.screen = (await ui.snapshot()).lines.slice(0, 40);
          failed.screenshot = await host.screenshot(`failed-line-${s.line}`);
        } catch {
          // the device itself may be the problem
        }
      }
      return {ok: false, steps: done, ms: Date.now() - t0, failed, notes};
    }
  }
  return {ok: true, steps: done, ms: Date.now() - t0, notes};
};
