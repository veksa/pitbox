// Summarize a V8 .cpuprofile: where the wall time went, by package and by function, plus idle time.
//
//   node bench/cpuprofile.ts <file.cpuprofile> [top=25]

import fs from 'node:fs';

type Node = {id: number; callFrame: {functionName: string; url: string; lineNumber: number}; children?: number[]};
type Profile = {nodes: Node[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number};

const [file, topArg] = process.argv.slice(2);
if (!file) throw new Error('usage: cpuprofile.ts <file> [top]');
const top = Number(topArg ?? 25);
const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Profile;

const byId = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map<number, number>();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const selfUs = new Map<number, number>();
p.samples.forEach((id, i) => selfUs.set(id, (selfUs.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));

const pkgOf = (url: string) => {
  if (!url) return '(native)';
  const m = url.replace(/\\/g, '/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g);
  if (m) return m[m.length - 1].replace('node_modules/', '');
  if (url.startsWith('node:')) return url;
  return '(app)';
};

const bySelfFn = new Map<string, number>();
const bySelfPkg = new Map<string, number>();
// Inclusive time per package: count each sample once per distinct package on its stack.
const byInclPkg = new Map<string, number>();
for (const [id, us] of selfUs) {
  const n = byId.get(id)!;
  const fn = `${n.callFrame.functionName || '(anon)'} ${pkgOf(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;
  bySelfFn.set(fn, (bySelfFn.get(fn) ?? 0) + us);
  bySelfPkg.set(pkgOf(n.callFrame.url), (bySelfPkg.get(pkgOf(n.callFrame.url)) ?? 0) + us);
  const seen = new Set<string>();
  for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
    const pk = pkgOf(byId.get(cur)!.callFrame.url);
    if (!seen.has(pk)) {
      seen.add(pk);
      byInclPkg.set(pk, (byInclPkg.get(pk) ?? 0) + us);
    }
  }
}

const total = (p.endTime - p.startTime) / 1000;
const print = (title: string, m: Map<string, number>) => {
  console.log(`\n${title}`);
  for (const [k, us] of [...m].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`${(us / 1000).toFixed(0).padStart(8)} ms ${((us / 1000 / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
};
console.log(`wall ${total.toFixed(0)} ms, samples ${p.samples.length}`);
print('self time by package', bySelfPkg);
print('inclusive time by package', byInclPkg);
print('self time by function', bySelfFn);
