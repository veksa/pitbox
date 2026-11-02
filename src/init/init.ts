// `pitbox init`: a first config from what the project's files say, and the one change an Android debug build
// usually needs to reach a local stand. Runs without a daemon (there is no config yet).

import fs from 'node:fs';
import path from 'node:path';
import {CONFIG_NAMES} from '../config/load.ts';
import {avdKind, listAvds} from '../drivers/android/sdk.ts';
import {allowCleartextInDebug, cleartextOf, detectProject, type Project} from './project.ts';

export type InitOptions = {cwd: string; force?: boolean; dryRun?: boolean};
export type InitReport = {lines: string[]; wrote?: string};

const q = (s: string) => `'${s.replace(/\\/g, '/').replace(/'/g, "\\'")}'`;

/** The config text: detected values filled in, the rest as commented examples to adapt. */
export const configText = (p: Project | undefined, cwd: string, avd?: string): string => {
  const rel = p ? path.relative(cwd, p.appRoot).replace(/\\/g, '/') : '';
  const app = [
    p?.applicationId ? `android: ${q(p.applicationId)}` : `android: 'com.example.app'`,
    ...(p?.scheme ? [`scheme: ${q(p.scheme)}`] : []),
  ].join(', ');
  const devserver = p?.adapter
    ? `  devserver: {adapter: '${p.adapter}'${rel ? `, root: ${q(rel)}` : ''}${p.start && p.start !== 'yarn start --port {port}' ? `, start: ${q(p.start)}` : ''}},\n`
    : '';
  return `import {defineConfig} from '@veksa/pitbox';

// Every field: docs/config.md in the pitbox package.
export default defineConfig({
  app: {${app}},
${avd ? `  android: {avd: ${q(avd)}},\n` : ''}${devserver}  services: {
    // db: {start: 'docker compose up -d db', stop: 'docker compose stop db', health: 'docker:db'},
    // api: {start: 'yarn start', cwd: 'server', health: 'http://localhost:3000/health', expose: 3000, dependsOn: ['db']},
  },
  tools: {
    // sql: {description: 'SQL in the stand database', run: 'docker exec -i db psql -U app -qAt -c {query}', params: {query: 'SQL statement'}},
  },
  // routes: {product: 'myapp://product/{id}'},
});
`;
};

export const init = (opts: InitOptions): InitReport => {
  const lines: string[] = [];
  const existing = CONFIG_NAMES.map(n => path.join(opts.cwd, n)).find(f => fs.existsSync(f));
  const p = detectProject(opts.cwd);
  if (p) {
    const what = [p.framework === 'native' ? 'native Android app' : p.framework === 'unknown' ? 'app' : `${p.framework === 'expo' ? 'Expo' : 'React Native'} app (${p.adapter})`];
    lines.push(`found: ${what} in ${path.relative(opts.cwd, p.appRoot) || '.'}${p.applicationId ? `, ${p.applicationId}` : ''}${p.scheme ? `, scheme ${p.scheme}` : ''}`);
  } else {
    lines.push('found: no app here or one level down — the config gets placeholders');
  }
  const avds = (() => {
    try {
      return listAvds();
    } catch {
      return [];
    }
  })();
  if (avds.length) lines.push(`emulators: ${avds.join(', ')}`);

  let wrote: string | undefined;
  if (existing && !opts.force) lines.push(`kept ${path.basename(existing)} (--force rewrites it)`);
  else {
    const file = existing ?? path.join(opts.cwd, 'pitbox.config.ts');
    // A phone by default: the first AVD by name is as likely a TV or a foldable.
    if (!opts.dryRun) fs.writeFileSync(file, configText(p, opts.cwd, avds.find(a => avdKind(a) === 'phone') ?? avds[0]));
    wrote = file;
    lines.push(`${opts.dryRun ? 'would write' : 'wrote'} ${path.basename(file)}`);
  }

  if (p?.appModule) {
    const c = cleartextOf(p.appModule);
    if (c.status === 'blocked') lines.push(opts.dryRun ? `would allow cleartext in debug builds: ${c.reason}` : `cleartext: ${c.reason} → ${allowCleartextInDebug(p.appModule)}`);
    else if (c.status === 'config') lines.push(`cleartext: ${c.reason}`);
    else if (c.status === 'allowed') lines.push(`cleartext: ok (${c.reason})`);
  }

  const gitignore = path.join(opts.cwd, '.gitignore');
  const ignored = fs.existsSync(gitignore) && /^\/?\.pitbox\/?\s*$/m.test(fs.readFileSync(gitignore, 'utf8'));
  if (!ignored && (fs.existsSync(gitignore) || fs.existsSync(path.join(opts.cwd, '.git')))) {
    if (!opts.dryRun) fs.appendFileSync(gitignore, `${fs.existsSync(gitignore) && !fs.readFileSync(gitignore, 'utf8').endsWith('\n') ? '\n' : ''}.pitbox/\n`);
    lines.push(`${opts.dryRun ? 'would add' : 'added'} .pitbox/ to .gitignore`);
  }

  const next: string[] = [];
  if (p?.adapter && !p.hasPitbox) next.push(`add pitbox to the app (${path.relative(opts.cwd, p.appRoot) || '.'}): yarn add -D @veksa/pitbox — its connect library autolinks into debug builds, rebuild once`);
  next.push('fill in services and tools, then: pitbox up && pitbox doctor');
  next.push('for agents, .mcp.json: {"mcpServers": {"pitbox": {"command": "npx", "args": ["pitbox", "mcp"]}}}');
  lines.push('next:', ...next.map(n => `  ${n}`));
  return {lines, wrote};
};
