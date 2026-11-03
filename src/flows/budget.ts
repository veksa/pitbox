// Performance budgets in flows: `perf` opens a measurement window, `expect perf janky<5 js<300 renders:Row<=40`
// closes it and checks the numbers, so a regression fails a run instead of waiting for someone to look.

export type Budget = {metric: string; op: '<' | '<=' | '>' | '>='; value: number; text: string};

/** Metrics a budget can name, with their unit as shown. `renders:<Component>` counts one component's renders. */
export const METRICS: Record<string, string> = {
  janky: '%',
  p50: 'ms',
  p90: 'ms',
  p99: 'ms',
  memory: 'MB',
  js: 'ms',
  commits: '',
  rendering: 'ms',
  heap: 'MB',
  allocated: 'MB',
};

export const parseBudget = (token: string): Budget => {
  const m = /^([a-z0-9]+(?::[\w$.]+)?)(<=|>=|<|>)([\d.]+)(%|ms|s|mb|MB)?$/.exec(token);
  if (!m) throw new Error(`a budget is <metric><op><number>, like janky<5 or js<=300ms, not "${token}"`);
  const [, metric, op, num, unit] = m;
  if (!(metric! in METRICS) && !metric!.startsWith('renders:')) throw new Error(`unknown perf metric "${metric}" (${[...Object.keys(METRICS), 'renders:<Component>'].join(', ')})`);
  const value = Number(num) * (unit === 's' ? 1000 : 1);
  if (!Number.isFinite(value)) throw new Error(`"${num}" is not a number`);
  return {metric: metric!, op: op as Budget['op'], value, text: token};
};

/** The perf result as the daemon answers it (frames, JS profile, React commits and heap). */
export type PerfData = {
  janky?: number;
  p50?: number;
  p90?: number;
  p99?: number;
  memoryMb?: number;
  js?: {busyMs?: number; note?: string};
  react?: {commits?: number; renderMs?: number; counts?: Record<string, number>; react?: boolean; heap?: {liveBefore: number; liveAfter: number; allocated: number}};
};

const MB = 1048576;

export const measure = (d: PerfData, metric: string): number | undefined => {
  if (metric.startsWith('renders:')) return d.react && d.react.react !== false ? (d.react.counts?.[metric.slice(8)] ?? 0) : undefined;
  const h = d.react?.heap;
  switch (metric) {
    case 'janky':
      return d.janky;
    case 'p50':
    case 'p90':
    case 'p99':
      return d[metric];
    case 'memory':
      return d.memoryMb;
    case 'js':
      return d.js?.note ? undefined : d.js?.busyMs;
    case 'commits':
      return d.react?.react === false ? undefined : d.react?.commits;
    case 'rendering':
      return d.react?.react === false ? undefined : d.react?.renderMs;
    case 'heap':
      return h ? Math.round(((h.liveAfter - h.liveBefore) / MB) * 10) / 10 : undefined;
    case 'allocated':
      return h ? Math.round((h.allocated / MB) * 10) / 10 : undefined;
    default:
      return undefined;
  }
};

const holds = (v: number, b: Budget) => (b.op === '<' ? v < b.value : b.op === '<=' ? v <= b.value : b.op === '>' ? v > b.value : v >= b.value);

/** Each budget with what was measured; a metric this device or app cannot measure fails rather than passing unseen. */
export const checkBudgets = (d: PerfData, budgets: Budget[]): {ok: boolean; lines: string[]} => {
  const lines: string[] = [];
  let ok = true;
  for (const b of budgets) {
    const v = measure(d, b.metric);
    const unit = METRICS[b.metric] ?? '';
    if (v === undefined) {
      ok = false;
      lines.push(`${b.metric}: not measured here (${b.metric.startsWith('renders:') || ['commits', 'rendering', 'heap', 'allocated', 'js'].includes(b.metric) ? 'needs a dev build through the dev server' : 'this device has no counter for it'})`);
      continue;
    }
    const pass = holds(v, b);
    if (!pass) ok = false;
    lines.push(`${b.metric} ${v}${unit} ${pass ? '✓' : '✗'} ${b.op} ${b.value}${unit}`);
  }
  return {ok, lines};
};
