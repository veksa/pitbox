// A JS CPU profile as a few lines an agent can act on: how busy the JS thread was, the functions that took the
// time themselves, and the app's own functions with what they called. The runtime's sampling profiler gives a
// call tree in bundle positions; the bundler maps the few functions shown back to source files.

export type ProfileNode = {
  id: number;
  callFrame: {functionName: string; url: string; lineNumber: number; columnNumber: number};
  children?: number[];
};

export type CpuProfile = {nodes: ProfileNode[]; samples?: number[]; startTime: number; endTime: number};

/** A function as the profile names it: bundle position (0-based, as the debugger protocol counts). */
export type ProfiledFn = {name: string; url: string; line: number; column: number};

export type ProfileSummary = {
  ms: number;
  busyMs: number;
  samples: number;
  /** Functions by the time spent in their own code, longest first. */
  self: {fn: ProfiledFn; ms: number}[];
  /** Functions by the time spent in them and what they called, longest first (wider list, filtered later). */
  total: {fn: ProfiledFn; ms: number}[];
};

/** Samples that are the thread waiting, not running JS. */
const IDLE = /^(\[root\]|\(root\)|\(idle\)|\(program\))$/;

const keyOf = (f: ProfiledFn) => `${f.name}|${f.url}|${f.line}|${f.column}`;

export const summarizeProfile = (p: CpuProfile, opts: {self?: number; total?: number} = {}): ProfileSummary => {
  const samples = p.samples ?? [];
  const ms = Math.max(0, (p.endTime - p.startTime) / 1000);
  const per = samples.length ? ms / samples.length : 0;
  const byId = new Map(p.nodes.map(n => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const fnOf = (n: ProfileNode): ProfiledFn => ({name: n.callFrame.functionName || '(anonymous)', url: n.callFrame.url, line: n.callFrame.lineNumber, column: n.callFrame.columnNumber});
  const idle = (n: ProfileNode) => IDLE.test(n.callFrame.functionName);

  const self = new Map<string, {fn: ProfiledFn; n: number}>();
  const total = new Map<string, {fn: ProfiledFn; n: number}>();
  let busy = 0;
  for (const id of samples) {
    const leaf = byId.get(id);
    if (!leaf || idle(leaf)) continue;
    busy++;
    const lf = fnOf(leaf);
    const s = self.get(keyOf(lf)) ?? {fn: lf, n: 0};
    s.n++;
    self.set(keyOf(lf), s);
    // Each function once per sample, however deep it recurses.
    const seen = new Set<string>();
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const node = byId.get(cur);
      if (!node || idle(node)) continue;
      const f = fnOf(node);
      const k = keyOf(f);
      if (seen.has(k)) continue;
      seen.add(k);
      const t = total.get(k) ?? {fn: f, n: 0};
      t.n++;
      total.set(k, t);
    }
  }
  const top = (m: Map<string, {fn: ProfiledFn; n: number}>, k: number) =>
    [...m.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, k)
      .map(x => ({fn: x.fn, ms: Math.round(x.n * per)}));
  return {ms: Math.round(ms), busyMs: Math.round(busy * per), samples: samples.length, self: top(self, opts.self ?? 8), total: top(total, opts.total ?? 40)};
};

/** Host functions have no bundle position: they are named, not mapped. */
export const isHostFn = (f: ProfiledFn) => !/^https?:/.test(f.url);
