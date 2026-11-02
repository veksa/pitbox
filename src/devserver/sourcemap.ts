// From a source line to where it runs in the bundle. The runtime's debugger only knows bundle positions (the
// debugger front end normally does this mapping), so a logpoint at `src/Home.tsx:42` needs the bundle's source
// map. Plain and indexed (`sections`, one per module, as Metro serves them) maps are read; nothing else from the
// source map format is needed.

export type RawSourceMap = {
  sources?: string[];
  mappings?: string;
  sections?: {offset: {line: number; column: number}; map: RawSourceMap}[];
};

/** A generated position (0-based line and column, as the debugger protocol counts). */
export type BundlePos = {line: number; column: number};

export type SourceHit = {source: string; line: number; at: BundlePos};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) DIGIT[B64.charCodeAt(i)] = i;

/** Decodes one segment's base64 VLQ fields. */
export const decodeSegment = (seg: string): number[] => {
  const out: number[] = [];
  let n = 0;
  let shift = 0;
  for (let i = 0; i < seg.length; i++) {
    const d = DIGIT[seg.charCodeAt(i)] ?? -1;
    if (d < 0) throw new Error(`bad source map segment "${seg}"`);
    n += (d & 31) * 2 ** shift;
    if (d & 32) shift += 5;
    else {
      out.push(n % 2 ? -Math.floor(n / 2) : n / 2);
      n = 0;
      shift = 0;
    }
  }
  return out;
};

const norm = (p: string) => p.replace(/\\/g, '/');

/** A source path as people read it: without a bundler's root placeholder (`/[metro-project]/App.tsx`). */
export const displayPath = (p: string) => norm(p).replace(/^\/?\[[\w-]+\]\//, '');

/** Sources whose path ends with `file` (a path from the app root or just a file name). */
export const sourcesMatching = (map: RawSourceMap, file: string): string[] => {
  const want = norm(file).replace(/^\.\//, '');
  const all = new Set<string>();
  const add = (m: RawSourceMap) => {
    for (const s of m.sources ?? []) {
      const n = norm(s);
      if (n === want || n.endsWith(`/${want}`)) all.add(s);
    }
    for (const sec of m.sections ?? []) add(sec.map);
  };
  add(map);
  return [...all];
};

/**
 * Every bundle position that maps to `source` at one of `lines` (1-based), keyed by line. One pass over the
 * mappings of the sections that mention the source.
 */
const positionsOf = (map: RawSourceMap, source: string, lines: Set<number>): Map<number, BundlePos[]> => {
  const found = new Map<number, BundlePos[]>();
  const walk = (m: RawSourceMap, offset: {line: number; column: number}) => {
    if (m.sections) {
      for (const sec of m.sections) walk(sec.map, {line: offset.line + sec.offset.line, column: sec.offset.line === 0 ? offset.column + sec.offset.column : sec.offset.column});
      return;
    }
    const si = (m.sources ?? []).indexOf(source);
    if (si < 0 || !m.mappings) return;
    let gl = offset.line;
    let src = 0;
    let ol = 0;
    let oc = 0;
    let first = true;
    for (const line of m.mappings.split(';')) {
      let gc = first ? offset.column : 0;
      first = false;
      if (line) {
        for (const seg of line.split(',')) {
          if (!seg) continue;
          const v = decodeSegment(seg);
          gc += v[0]!;
          if (v.length < 4) continue;
          src += v[1]!;
          ol += v[2]!;
          oc += v[3]!;
          if (src === si && lines.has(ol + 1)) {
            const list = found.get(ol + 1) ?? [];
            list.push({line: gl, column: gc});
            found.set(ol + 1, list);
          }
        }
      }
      gl++;
    }
  };
  walk(map, {line: 0, column: 0});
  return found;
};

/**
 * Where `file:line` runs: the first bundle position of that line, or of the next line with code within `ahead`
 * lines (a blank line, a comment or a closing brace has none). Throws with the candidates when the file name is
 * ambiguous, and when the file is not in this map.
 */
export const bundlePosition = (map: RawSourceMap, file: string, line: number, ahead = 5): SourceHit => {
  const sources = sourcesMatching(map, file);
  if (!sources.length) throw new Error(`${file} is not in the bundle`);
  if (sources.length > 1) throw new Error(`${file} matches ${sources.length} files: ${sources.slice(0, 5).map(displayPath).join(', ')} — give more of the path`);
  const source = sources[0]!;
  const want = new Set(Array.from({length: ahead + 1}, (_, i) => line + i));
  const found = positionsOf(map, source, want);
  for (let l = line; l <= line + ahead; l++) {
    const list = found.get(l);
    if (!list?.length) continue;
    const at = list.reduce((a, b) => (b.line < a.line || (b.line === a.line && b.column < a.column) ? b : a));
    return {source: displayPath(source), line: l, at};
  }
  throw new Error(`no code at ${file}:${line} or in the ${ahead} lines after it`);
};
