// Text helpers that keep agent-facing output small.

// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Removes terminal colour and cursor codes — they cost tokens and carry nothing. */
export const stripAnsi = (text: string) => text.replace(ANSI, '');

/** The last `n` lines of a text, optionally only those matching a pattern. */
export const tailLines = (text: string, n: number, grep?: string): string[] => {
  let lines = stripAnsi(text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (grep) {
    const re = new RegExp(grep, 'i');
    lines = lines.filter(l => re.test(l));
  }
  return lines.slice(-n);
};

/** Cuts a text to `max` characters, saying how much was dropped. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n… ${text.length - max} more chars`;

/** Cuts every line to `width` characters. */
export const clipLines = (lines: string[], width = 240): string[] => lines.map(l => (l.length > width ? `${l.slice(0, width)}…` : l));

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Replaces `{key}` placeholders; values go through `quote`. Unknown keys are an error, not an empty string. */
export const renderTemplate = (template: string, params: Record<string, string | number | undefined>, quote: (v: string) => string): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`missing parameter {${key}}`);
    return quote(String(value));
  });

/** Placeholder names used in a template, in order of appearance. */
export const templateParams = (template: string): string[] => [...new Set([...template.matchAll(/\{(\w+)\}/g)].map(m => m[1] as string))];
