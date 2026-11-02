// Finding and loading the project config.

import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {configSchema, type PitboxConfig} from './schema.ts';

export const CONFIG_NAMES = ['pitbox.config.ts', 'pitbox.config.mts', 'pitbox.config.mjs', 'pitbox.config.js', 'pitbox.config.json'];

export type LoadedConfig = {
  /** Directory the config lives in; relative paths in the config resolve against it. */
  root: string;
  file: string;
  config: PitboxConfig;
  /** Where pitbox keeps logs and runtime state for this project. */
  stateDir: string;
};

/** Walks up from `from` to the first directory holding a config file. */
export const findConfig = (from: string): string | undefined => {
  let dir = path.resolve(from);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

export const formatIssues = (error: {issues: {path: PropertyKey[]; message: string}[]}) =>
  error.issues.map(i => `  ${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('\n');

export const loadConfig = async (opts: {file?: string; cwd?: string} = {}): Promise<LoadedConfig> => {
  const file = opts.file ? path.resolve(opts.file) : findConfig(opts.cwd ?? process.cwd());
  if (!file || !fs.existsSync(file)) {
    throw new Error(`no ${CONFIG_NAMES[0]} found from ${opts.cwd ?? process.cwd()} upwards — create one or pass --config`);
  }
  let raw: unknown;
  if (file.endsWith('.json')) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    // Cache-busting query so a long-lived daemon picks up edits on reload.
    const mod = await import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`);
    raw = mod.default ?? mod.config;
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid config ${file}:\n${formatIssues(parsed.error)}`);
  }
  const config = parsed.data;
  for (const [name, tool] of Object.entries(config.tools ?? {})) {
    const declared = new Set(Object.keys(tool.params ?? {}));
    const missing = [...tool.run.matchAll(/\{(\w+)\}/g)].map(m => m[1]).filter(p => p && !declared.has(p));
    if (missing.length) throw new Error(`invalid config ${file}:\n  tools.${name}.params: missing ${[...new Set(missing)].join(', ')}`);
  }
  const root = path.dirname(file);
  return {root, file, config, stateDir: path.join(root, '.pitbox')};
};

/** Resolves a path from the config against the config's directory. */
export const resolveFrom = (root: string, p: string | undefined) => (p ? path.resolve(root, p) : root);
