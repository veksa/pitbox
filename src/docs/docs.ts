// Cheap reading of a project's long documents (checklists, knowledge bases): only the lines a step needs.

import fs from 'node:fs';

export type Heading = {line: number; level: number; text: string};

const headingRe = /^(#{1,6})\s+(.*)$/;

export const headings = (text: string): Heading[] => {
  const out: Heading[] = [];
  let fence = false;
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    const m = headingRe.exec(l);
    if (m) out.push({line: i + 1, level: m[1]!.length, text: m[2]!.trim()});
  });
  return out;
};

export const toc = (text: string, maxLevel = 3): string[] => headings(text).filter(h => h.level <= maxLevel).map(h => `${String(h.line).padStart(5)} ${'  '.repeat(h.level - 1)}${h.text}`);

/** The section whose heading contains `query` (case-insensitive), up to the next heading of the same or higher level. */
export const section = (text: string, query: string, maxLines = 120): string[] => {
  const lines = text.split(/\r?\n/);
  const hs = headings(text);
  const q = query.toLowerCase();
  const hit = hs.find(h => h.text.toLowerCase() === q) ?? hs.find(h => h.text.toLowerCase().includes(q));
  if (!hit) {
    const near = hs.filter(h => h.text.toLowerCase().split(/\W+/).some(w => w && q.includes(w))).slice(0, 5);
    throw new Error(`no heading contains "${query}"${near.length ? `; close: ${near.map(h => h.text).join(' | ')}` : ''}`);
  }
  const next = hs.find(h => h.line > hit.line && h.level <= hit.level);
  const body = lines.slice(hit.line - 1, next ? next.line - 1 : lines.length);
  while (body.length && body[body.length - 1]!.trim() === '') body.pop();
  return body.length > maxLines ? [...body.slice(0, maxLines), `… ${body.length - maxLines} more lines (lines ${hit.line + maxLines}–${hit.line + body.length - 1})`] : body;
};

/** Matching lines with line numbers and optional context. */
export const grep = (text: string, pattern: string, context = 0, max = 30): string[] => {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(pattern, 'i');
  const out: string[] = [];
  let hits = 0;
  let lastPrinted = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i]!)) continue;
    hits++;
    if (hits > max) continue;
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length - 1, i + context);
    if (lastPrinted >= 0 && from > lastPrinted + 1) out.push('--');
    for (let j = Math.max(from, lastPrinted + 1); j <= to; j++) out.push(`${String(j + 1).padStart(5)}${j === i ? ':' : '-'} ${lines[j]}`);
    lastPrinted = to;
  }
  if (hits > max) out.push(`… ${hits - max} more matches`);
  return out;
};

export const lineRange = (text: string, from: number, to: number): string[] =>
  text
    .split(/\r?\n/)
    .slice(Math.max(0, from - 1), to)
    .map((l, i) => `${String(from + i).padStart(5)}  ${l}`);

export const readDoc = (file: string) => fs.readFileSync(file, 'utf8');
