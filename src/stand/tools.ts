// Project tools: named commands from the config (a protocol call, an SQL query, a seed script) exposed to
// the CLI and as MCP tools, with parameters quoted for the shell and output kept short.

import path from 'node:path';
import type {ToolConfig} from '../config/schema.ts';
import {quoteArg, resolveShell, runShell} from '../util/proc.ts';
import {clipMiddle, renderTemplate} from '../util/text.ts';
import type {StandContext} from './services.ts';

export type ToolResult = {code: number | null; ms: number; output: string; timedOut: boolean};

export const runTool = async (ctx: StandContext, name: string, tool: ToolConfig, params: Record<string, string>, maxChars = 6000): Promise<ToolResult> => {
  const shell = resolveShell(ctx.shell);
  const command = renderTemplate(tool.run, params, v => quoteArg(v, shell.kind));
  const r = await runShell(command, {
    cwd: tool.cwd ? path.resolve(ctx.root, tool.cwd) : ctx.root,
    env: {...process.env, ...ctx.env, ...tool.env},
    timeoutMs: (tool.timeout ?? 120) * 1000,
    shell: ctx.shell,
  });
  const out = [r.stdout.trimEnd(), r.code !== 0 && r.stderr.trim() ? `[stderr]\n${r.stderr.trimEnd()}` : ''].filter(Boolean).join('\n');
  return {code: r.code, ms: r.ms, output: clipMiddle(out, maxChars), timedOut: r.timedOut};
};

export const describeTool = (name: string, tool: ToolConfig) => ({name, description: tool.description ?? tool.run, params: tool.params ?? {}});
