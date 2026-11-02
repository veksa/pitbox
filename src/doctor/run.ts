// Runs doctor rules, optionally applying fixes.

import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {builtinRules} from './rules.ts';
import type {DoctorContext, Finding, Rule} from './types.ts';

export type DoctorReport = {checked: number; findings: {rule: string; severity: string; message: string; hint?: string; fixable: boolean; fixed?: string}[]};

export const loadProjectRules = async (root: string, modulePath?: string): Promise<Rule[]> => {
  if (!modulePath) return [];
  const mod = await import(pathToFileURL(path.resolve(root, modulePath)).href);
  const rules = (mod.default ?? mod.rules) as Rule[];
  if (!Array.isArray(rules)) throw new Error(`${modulePath}: default export must be an array of rules`);
  return rules;
};

export const runDoctor = async (ctx: DoctorContext, opts: {fix?: boolean; only?: string[]; extra?: Rule[]} = {}): Promise<DoctorReport> => {
  const rules = [...builtinRules, ...(opts.extra ?? [])].filter(r => !opts.only?.length || opts.only.includes(r.id));
  const results = await Promise.all(
    rules.map(async r => {
      try {
        return await r.check(ctx);
      } catch (e) {
        return [{rule: r.id, severity: 'warn', message: `rule failed: ${(e as Error).message}`} satisfies Finding];
      }
    }),
  );
  const findings: DoctorReport['findings'] = [];
  for (const f of results.flat()) {
    let fixed: string | undefined;
    if (opts.fix && f.fix) {
      try {
        fixed = await f.fix();
      } catch (e) {
        fixed = `fix failed: ${(e as Error).message}`;
      }
    }
    findings.push({rule: f.rule, severity: f.severity, message: f.message, hint: f.hint, fixable: !!f.fix, ...(fixed ? {fixed} : {})});
  }
  const order = {error: 0, warn: 1, info: 2} as const;
  findings.sort((a, b) => order[a.severity as keyof typeof order] - order[b.severity as keyof typeof order]);
  return {checked: rules.length, findings};
};
