// Project tools: named commands from the config (a protocol call, an SQL query, a seed script) exposed to
// the CLI and as MCP tools, with parameters quoted for the shell and output kept short.

import path from 'node:path';
import {isDevicePlaceholder, toolParams, type DevicePlaceholder, type ToolConfig} from '../config/schema.ts';
import {quoteArg, resolveShell, runShell} from '../util/proc.ts';
import {clipMiddle, renderTemplate, templateParams} from '../util/text.ts';
import type {StandContext} from './services.ts';

/** The device placeholders a tool's command uses. */
export const toolDevicePlaceholders = (tool: ToolConfig): DevicePlaceholder[] => templateParams(tool.run).filter(isDevicePlaceholder);

export type ToolResult = {code: number | null; ms: number; output: string; timedOut: boolean};

/** `devices` fills the device placeholders; a caller cannot pass them as parameters. */
export const runTool = async (
  ctx: StandContext,
  name: string,
  tool: ToolConfig,
  params: Record<string, string>,
  maxChars = 6000,
  devices: Partial<Record<DevicePlaceholder, string>> = {},
): Promise<ToolResult> => {
  const shell = resolveShell(ctx.shell);
  const filled: Record<string, string> = Object.fromEntries(Object.entries(params).filter(([k]) => !isDevicePlaceholder(k)));
  for (const p of toolDevicePlaceholders(tool)) {
    if (!devices[p]) throw new Error(`tool ${name} runs on {${p}}, the device this session holds, and none was given`);
    filled[p] = devices[p];
  }
  const dropped = new Set<string>();
  for (const p of toolParams(tool)) {
    if (filled[p.name] !== undefined || !p.optional) continue;
    if (p.default !== undefined) filled[p.name] = p.default;
    else dropped.add(p.name);
  }
  // An optional parameter with no value and no default leaves no argument behind, not an empty one.
  const run = tool.run.replace(/\{(\w+)\}/g, (m, key: string) => (dropped.has(key) ? '' : m));
  const command = renderTemplate(run, filled, v => quoteArg(v, shell.kind));
  const r = await runShell(command, {
    cwd: tool.cwd ? path.resolve(ctx.root, tool.cwd) : ctx.root,
    env: {...process.env, ...ctx.env, ...tool.env},
    timeoutMs: (tool.timeout ?? 120) * 1000,
    shell: ctx.shell,
  });
  const out = [r.stdout.trimEnd(), r.code !== 0 && r.stderr.trim() ? `[stderr]\n${r.stderr.trimEnd()}` : ''].filter(Boolean).join('\n');
  return {code: r.code, ms: r.ms, output: clipMiddle(out, maxChars), timedOut: r.timedOut};
};

export const describeTool = (name: string, tool: ToolConfig) => ({name, description: tool.description ?? tool.run, params: toolParams(tool)});
