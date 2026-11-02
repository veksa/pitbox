// JS errors from inside the app, as source locations. The in-app script sends the raw stack; frames point into
// the bundle the device runs (bytecode compiled with -O0 keeps the bundle's lines and columns), and the bundler's
// own `/symbolicate` maps them back to files, so pitbox carries no source map code of its own.

import path from 'node:path';

export type RawFrame = {methodName: string; file: string; lineNumber: number; column: number};
export type SourceFrame = RawFrame & {collapse?: boolean};

/** Where the in-app script sits in a served bundle: frames below it are shifted by its line count. */
export type Injection = {line: number; lines: number};

/** Parses Hermes (`at fn (file:line:col)`, `at fn (address at file:line:col)`) and JSC (`fn@file:line:col`) stacks. */
export const parseStack = (stack: string): RawFrame[] => {
  const frames: RawFrame[] = [];
  for (const raw of stack.split('\n')) {
    const l = raw.trim();
    let m = /^at (?:(.+?) \()?(?:address at )?(.+?):(\d+):(\d+)\)?$/.exec(l);
    if (!m) m = /^(?:(.*?)@)?(.+?):(\d+):(\d+)$/.exec(l);
    if (!m || !/^(https?:|\/|[A-Za-z]:|index|main)/.test(m[2]!)) continue;
    frames.push({methodName: m[1] || 'anonymous', file: m[2]!, lineNumber: Number(m[3]), column: Number(m[4])});
  }
  return frames;
};

/** Undoes the in-app script's lines; frames inside the script itself are pitbox's and dropped. */
export const unshift = (frames: RawFrame[], at?: Injection): RawFrame[] => {
  if (!at) return frames;
  return frames.flatMap(f => {
    if (f.lineNumber < at.line) return [f];
    if (f.lineNumber < at.line + at.lines) return [];
    return [{...f, lineNumber: f.lineNumber - at.lines}];
  });
};

/** Line of the splice point (1-based) and the number of lines the script adds. */
export const injectionOf = (text: string, script: string): Injection | undefined => {
  const tail = text.lastIndexOf('\n__r(');
  if (tail < 0) return undefined;
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i <= tail; i = text.indexOf('\n', i + 1)) line++;
  return {line, lines: script.split('\n').length - 1};
};

/** Asks the bundler; on any failure the frames come back as they were. */
export const symbolicate = async (port: number, frames: RawFrame[], timeoutMs = 10_000): Promise<{frames: SourceFrame[]; code?: string; ok: boolean}> => {
  if (!frames.length) return {frames, ok: true};
  try {
    const res = await fetch(`http://127.0.0.1:${port}/symbolicate`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({stack: frames}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return {frames, ok: false};
    const body = (await res.json()) as {stack?: SourceFrame[]; codeFrame?: {content?: string}};
    if (!Array.isArray(body.stack)) return {frames, ok: false};
    return {frames: body.stack, code: codeLine(body.codeFrame?.content), ok: true};
  } catch {
    return {frames, ok: false};
  }
};

// eslint-disable-next-line no-control-regex
const ansi = /\x1b\[[0-9;]*m/g;

/** The offending line of the bundler's code frame (`> 31 | …`), not the whole excerpt. */
const codeLine = (content?: string): string | undefined => {
  const line = content?.replace(ansi, '').split('\n').find(l => l.startsWith('>'));
  return line?.replace(/^>\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 160) || undefined;
};

/** `fn  src/file.ts:31:39`, relative to `root`; the bundler's collapsed frames (framework internals) are left out. */
export const formatFrames = (frames: SourceFrame[], root: string, limit = 8): string[] => {
  const shown = frames.filter(f => !f.collapse);
  const rel = (file: string) => {
    if (/^https?:/.test(file)) return file.replace(/\?.*?(:\d+:\d+)?$/, '');
    const r = path.relative(root, file);
    return (r.startsWith('..') ? file : r).replace(/\\/g, '/');
  };
  const out = (shown.length ? shown : frames).slice(0, limit).map(f => `${f.methodName}  ${rel(f.file)}:${f.lineNumber}:${f.column}`);
  if (shown.length > limit) out.push(`… ${shown.length - limit} more`);
  return out;
};
