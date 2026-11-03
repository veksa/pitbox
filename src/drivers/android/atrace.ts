// The platform's own trace of an app over a measurement window, summed up: how long each of its threads spent
// in traced work, and the longest slices with what took the time inside them (`Choreographer#doFrame > traversal
// > draw`). Captured with atrace, which works on user builds for debuggable apps, as text that is read here — no
// trace processor on the host.

/** Long slices of one kind (same thread, same chain of names): how often, the longest, the sum. */
export type TraceSlice = {thread: string; name: string; path: string[]; count: number; ms: number; totalMs: number; at: number};

export type TraceSummary = {
  ms: number;
  /** Time in top-level slices per thread, busiest first. */
  threads: {thread: string; ms: number; slices: number; longest: number}[];
  /** Top-level slices of at least `longMs`, grouped by kind, longest first. */
  long: TraceSlice[];
  longMs: number;
};

type Open = {name: string; start: number; children: {name: string; ms: number; path: string[]}[]};

// `  RenderThread-10028   (  10014) [002] .....  3628.484330: tracing_mark_write: B|10014|DrawFrame`
const LINE = /^\s*(.+?)-(\d+)\s+\(\s*(\d+|-+)\)\s+\[\d+\]\s+\S+\s+([\d.]+):\s+tracing_mark_write:\s+([BE])\|(\d+)(?:\|(.*))?$/;

/** Thread labels: the app's main thread is "main" (its name is the package's tail), the rest by their name. */
const label = (comm: string, tid: number, pid: number) => (tid === pid ? 'main' : comm.trim());

/** A slice name without the frame numbers and coordinates the platform puts in it (`DrawFrames 1740884`). */
export const sliceName = (s: string) => s.replace(/\s+-?[\d.]+(?=\s|$)/g, '').trim() || s.trim();

export const summarizeAtrace = (text: string, pid: number, opts: {longMs?: number; long?: number} = {}): TraceSummary => {
  const longMs = opts.longMs ?? 16;
  const stacks = new Map<number, Open[]>();
  const names = new Map<number, string>();
  const busy = new Map<string, {ms: number; slices: number; longest: number}>();
  const long = new Map<string, TraceSlice>();
  let first = Infinity;
  let last = -Infinity;
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const t = Number(m[4]) * 1000;
    if (t < first) first = t;
    if (t > last) last = t;
    if (Number(m[6]) !== pid) continue;
    const tid = Number(m[2]);
    names.set(tid, label(m[1]!, tid, pid));
    let stack = stacks.get(tid);
    if (!stack) stacks.set(tid, (stack = []));
    if (m[5] === 'B') {
      stack.push({name: sliceName(m[7] ?? '') || '(unnamed)', start: t, children: []});
      continue;
    }
    const open = stack.pop();
    if (!open) continue;
    const ms = t - open.start;
    // What took the time inside: the heaviest child, then its heaviest child.
    const heaviest = open.children.reduce<{name: string; ms: number; path: string[]} | undefined>((a, c) => (!a || c.ms > a.ms ? c : a), undefined);
    const path = heaviest ? [heaviest.name, ...heaviest.path].slice(0, 3) : [];
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push({name: open.name, ms, path});
      continue;
    }
    const thread = names.get(tid)!;
    const b = busy.get(thread) ?? {ms: 0, slices: 0, longest: 0};
    b.ms += ms;
    b.slices++;
    b.longest = Math.max(b.longest, ms);
    busy.set(thread, b);
    if (ms >= longMs) {
      const key = [thread, open.name, ...path].join('>');
      const g = long.get(key);
      if (!g) long.set(key, {thread, name: open.name, path, count: 1, ms, totalMs: ms, at: Math.round(open.start - first)});
      else {
        g.count++;
        g.totalMs += ms;
        if (ms > g.ms) Object.assign(g, {ms, at: Math.round(open.start - first)});
      }
    }
  }
  const threads = [...busy.entries()].map(([thread, b]) => ({thread, ms: Math.round(b.ms), slices: b.slices, longest: Math.round(b.longest * 10) / 10})).sort((a, b) => b.ms - a.ms);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const groups = [...long.values()].map(g => ({...g, ms: r1(g.ms), totalMs: r1(g.totalMs)})).sort((a, b) => b.ms - a.ms);
  return {ms: Number.isFinite(first) ? Math.round(last - first) : 0, threads, long: groups.slice(0, opts.long ?? 6), longMs};
};
