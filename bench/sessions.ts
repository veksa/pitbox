// Token baseline from Claude Code transcripts: what device-driving sessions really cost.
// The cost of an agent turn is the context it re-reads, so this sums the usage the API reported
// (cache reads, writes, output) rather than the size of tool responses.
//
//   node bench/sessions.ts [--root ~/.claude/projects] [--tool-prefix mcp__agent-device__] [--min-turns 5] [dir...]
//
// Without dirs every project folder under --root is scanned. A session counts when it called a tool whose
// name starts with --tool-prefix.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const root = opt('root', path.join(os.homedir(), '.claude', 'projects'));
const prefix = opt('tool-prefix', 'mcp__agent-device__');
const minTurns = Number(opt('min-turns', '5'));
const dirs = argv.length ? argv : fs.readdirSync(root);

const walk = (d: string): string[] =>
  fs.readdirSync(d, {withFileTypes: true}).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.jsonl') ? [path.join(d, e.name)] : []);

type Session = {turns: number; cacheRead: number; cacheWrite: number; output: number; maxCtx: number; deviceCalls: number; images: number; deviceResultChars: number};
const sessions: Session[] = [];

for (const dir of dirs) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) continue;
  for (const file of walk(full)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(prefix)) continue;
    const s: Session = {turns: 0, cacheRead: 0, cacheWrite: 0, output: 0, maxCtx: 0, deviceCalls: 0, images: 0, deviceResultChars: 0};
    const deviceIds = new Set<string>();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const u = o?.message?.usage;
      if (o.type === 'assistant' && u) {
        s.turns++;
        s.cacheRead += u.cache_read_input_tokens ?? 0;
        s.cacheWrite += u.cache_creation_input_tokens ?? 0;
        s.output += u.output_tokens ?? 0;
        s.maxCtx = Math.max(s.maxCtx, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
      }
      const content = o?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c.type === 'tool_use' && String(c.name).startsWith(prefix)) {
          s.deviceCalls++;
          deviceIds.add(c.id);
        }
        if (c.type === 'tool_result') {
          const parts = Array.isArray(c.content) ? c.content : [{type: 'text', text: String(c.content ?? '')}];
          for (const part of parts) {
            if (part.type === 'image') s.images++;
            else if (deviceIds.has(c.tool_use_id)) s.deviceResultChars += (part.text ?? '').length;
          }
        }
      }
    }
    if (s.turns >= minTurns && s.deviceCalls > 0) sessions.push(s);
  }
}

const sum = (k: keyof Session) => sessions.reduce((a, s) => a + s[k], 0);
const turns = sum('turns');
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};
const out = {
  sessions: sessions.length,
  turns,
  deviceCalls: sum('deviceCalls'),
  images: sum('images'),
  cacheReadTokens: sum('cacheRead'),
  outputTokens: sum('output'),
  avgContextPerTurn: Math.round(sum('cacheRead') / Math.max(1, turns)),
  medianTurnsPerSession: median(sessions.map(s => s.turns)),
  medianMaxContext: median(sessions.map(s => s.maxCtx)),
  avgDeviceResponseTokens: Math.round(sum('deviceResultChars') / 3.5 / Math.max(1, sum('deviceCalls'))),
  sessionsNearWindow: sessions.filter(s => s.maxCtx > 900_000).length,
};
console.log(JSON.stringify(out, null, 2));
