// Native builds made once and shared. A build is keyed by a fingerprint of its native inputs; the artifact (an .apk
// or an .app) is kept under ~/Library/Caches/pitbox/builds, shared by every checkout and worktree of the app and
// every session on the machine. A fingerprint built before is installed from the cache in seconds; a missing one is
// built by one process while the others wanting it wait for it (single flight), and native builds of any kind run
// one at a time on the machine, as several at once only make each slower.
//
// For an app with a JS dev server (React Native and the like) the JS is not a native input: the debug build loads it
// from the dev server, so a JS-only change reuses the build. The default inputs are then the platform's folder, the
// package manifests and lock files and the app's config; a native app takes every file git sees.
//
// Beyond the files git sees, a build may declare environment variables (`env`) and files outside the checkout or
// ignored by git (`files`) as inputs: a variant of the build (a probe, an architecture, a config preset) is then a
// fingerprint of its own. Old builds are dropped by `keep`, per variant, never one used in the last minutes.

import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {machineLock} from '../lease/lease.ts';
import {runShell} from '../util/proc.ts';

export type NativePlatform = 'android' | 'ios';

export type NativeBuildSpec = {
  /** The shell command that builds the app, run in the project root. */
  command: string;
  /** What it leaves, relative to the root: an .apk, or an .app folder. */
  output: string;
  /** Globs (relative to the root) whose files are the build's inputs; defaults per kind of app. */
  inputs?: string[];
  /** Seconds the build may take. Default 1800. */
  timeout?: number;
  /**
   * Environment variables that are inputs of the build: names, or globs on names (`APP_*`); a `!name` or `!glob`
   * entry, wherever it stands, leaves variables out (`['APP_*', '!APP_DEV_PORT']`). Their values are in the
   * fingerprint (an unset name and an empty one differ), and the build runs with the caller's values of them.
   * `{name, default}` declares a name with the value the build gets when the caller leaves it unset: unset and the
   * default are then one build.
   */
  env?: BuildEnvEntry[];
  /**
   * Run the build with its declared variables and the toolchain baseline (`STRICT_ENV`) only, all from the caller:
   * nothing undeclared reaches it from the daemon or the caller, and the toolchain roots are in the fingerprint.
   */
  envStrict?: boolean;
  /**
   * Files or folders read by the build that git does not list: absolute, `~/…`, relative to the root (ignored files),
   * or `$NAME…` with `NAME` a variable of `env`. Their content is in the fingerprint; a missing one counts as absent,
   * a `$NAME` that points at nothing is an error.
   */
  files?: string[];
  /** Which old builds stay: `count` newest per variant (default 5), none unused for `days` (default 30), `mb` in all. */
  keep?: BuildKeep;
};

/** A declared variable: a name, a glob on names, `!name` / `!glob` to leave out, or a name with a default. */
export type BuildEnvEntry = string | {name: string; default?: string};

export type BuildKeep = {count?: number; days?: number; mb?: number};

const MANIFESTS = ['package.json', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'app.json', 'app.config.*', 'eas.json', 'react-native.config.js', 'patches/**', '.yarnrc.yml'];

/** Inputs of a build whose JS comes from a dev server: the platform's folder, manifests, lock files, app config. */
export const jsAppInputs = (platform: NativePlatform): string[] => [platform === 'ios' ? 'ios/**' : 'android/**', ...MANIFESTS];

/**
 * The inputs of a build: its own globs, or the defaults for the kind of app. `!glob` entries exclude paths; a list
 * of exclusions only (`['!docs/**']`) keeps the default inputs and excludes from them.
 */
export const buildInputs = (spec: Pick<NativeBuildSpec, 'inputs'>, platform: NativePlatform, devserver: boolean): string[] => {
  const defaults = devserver ? jsAppInputs(platform) : ['**'];
  if (!spec.inputs) return defaults;
  return spec.inputs.length > 0 && spec.inputs.every(g => g.startsWith('!')) ? [...defaults, ...spec.inputs] : spec.inputs;
};

/** A glob (`**`, `*`, `?`, `{a,b}`) as a regular expression over a `/`-separated relative path. */
export const globRe = (glob: string): RegExp => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` matches no folder or any number of them; a trailing `**` everything below.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
};

const SKIP = new Set(['.git', 'node_modules', 'build', 'Pods', '.gradle', 'DerivedData', '.cxx', '.idea']);

/** The project's files as git sees them (tracked and untracked, not ignored); a walk without git. */
export const listFiles = (root: string): string[] => {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {cwd: root, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore']});
    return out.split('\0').filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(root, rel), {withFileTypes: true})) {
        if (SKIP.has(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else if (e.isFile()) out.push(r);
      }
    };
    walk('');
    return out;
  }
};

export type Fingerprint = {hash: string; files: number; ms: number; variant?: string};

const GLOB_CHARS = /[*?{]/;
const nameMatcher = (patterns: string[]) => {
  const res = patterns.filter(p => GLOB_CHARS.test(p)).map(globRe);
  const names = new Set(patterns.filter(p => !GLOB_CHARS.test(p)));
  return (name: string) => names.has(name) || res.some(r => r.test(name));
};

/**
 * A build's `env` read: which variables it declares (a name or glob, less every `!name` / `!glob` entry wherever it
 * stands in the list), the plain names among them, which count as unset when not set, and their defaults.
 */
export const parseEnv = (entries: BuildEnvEntry[] = []) => {
  const pos: string[] = [];
  const nots: string[] = [];
  const defaults = new Map<string, string>();
  for (const e of entries) {
    if (typeof e !== 'string') {
      if (!/^\w+$/.test(e.name)) throw new BuildError(`build env: ${e.name} takes a default, so it must be a plain name`);
      pos.push(e.name);
      if (e.default !== undefined) defaults.set(e.name, e.default);
    } else if (e.startsWith('!')) nots.push(e.slice(1));
    else pos.push(e);
  }
  const not = nameMatcher(nots);
  const yes = nameMatcher(pos);
  for (const n of [...defaults.keys()]) if (not(n)) defaults.delete(n);
  return {
    declared: (name: string) => yes(name) && !not(name),
    names: pos.filter(p => !GLOB_CHARS.test(p) && !not(p)),
    defaults,
    any: pos.length > 0,
  };
};

/**
 * What a strict build gets besides its declared variables, from the caller: what a shell, Node, Gradle, xcodebuild
 * and CocoaPods need to start and to reach the network — the search path, the user and home, locale, temp folders,
 * the toolchain roots, the package managers' homes, the proxies, and the Windows system variables. None of them is
 * meant to change what a build makes; one that does (an SDK chosen by a variable) belongs in `env`.
 */
export const STRICT_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_*', 'TERM',
  'DEVELOPER_DIR', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT', 'ANDROID_USER_HOME', 'GRADLE_USER_HOME',
  'NVM_DIR', 'VOLTA_HOME', 'COREPACK_*', 'GEM_HOME', 'GEM_PATH', 'RBENV_ROOT', 'ASDF_DIR', 'ASDF_DATA_DIR', 'MISE_DATA_DIR',
  'SSH_AUTH_SOCK', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
];
/** The baseline variables that choose a toolchain: a strict build's fingerprint takes their values. */
export const TOOLCHAIN_ROOTS = ['DEVELOPER_DIR', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT'];
// Upper-cased: Windows spells its variables in any case (`Path`, `SystemRoot`), and so may a proxy (`https_proxy`).
const strictBaseline = nameMatcher(STRICT_ENV);
const inBaseline = (name: string) => strictBaseline(name.toUpperCase());

/** The environment with the declared defaults filled in where a variable is unset. */
const withDefaults = (env: NodeJS.ProcessEnv, defaults: Map<string, string>): NodeJS.ProcessEnv => {
  if (![...defaults.keys()].some(k => env[k] === undefined)) return env;
  const out = {...env};
  for (const [k, v] of defaults) if (out[k] === undefined) out[k] = v;
  return out;
};

/**
 * The environment a build runs with: the daemon's own, with the declared variables taken from the caller's
 * environment when one is given — set as the caller has them, unset when the caller has not — and a declared
 * default for each one left unset. A variable a declared pattern names never comes from the daemon when a caller is
 * given. With `envStrict`, only the declared variables and the baseline, all from the caller.
 */
export const buildEnv = (spec: Pick<NativeBuildSpec, 'env' | 'envStrict'>, base: NodeJS.ProcessEnv, caller?: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const {declared, any, defaults} = parseEnv(spec.env);
  if (spec.envStrict) {
    // Strict: the declared variables and the baseline, from the caller (the daemon's own when no caller is given).
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(caller ?? base)) if (typeof v === 'string' && (declared(k) || inBaseline(k))) env[k] = v;
    return withDefaults(env, defaults);
  }
  if (!caller || !any) return withDefaults(base, defaults);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!declared(k)) env[k] = v;
  for (const [k, v] of Object.entries(caller)) if (declared(k) && typeof v === 'string') env[k] = v;
  return withDefaults(env, defaults);
};

/**
 * The declared variables as fingerprint entries, sorted: `NAME=value`, or `NAME` unset for a plain name not set. A
 * name with a default left unset is `NAME=default`, the entry of the name set to it.
 */
export const envEntries = (patterns: BuildEnvEntry[], given: NodeJS.ProcessEnv): string[] => {
  const {declared, names, defaults} = parseEnv(patterns);
  const env = withDefaults(given, defaults);
  const out = new Map<string, string>();
  for (const p of names) out.set(p, env[p] === undefined ? `${p}\0unset` : `${p}=${env[p]}`);
  for (const [k, v] of Object.entries(env)) if (v !== undefined && declared(k)) out.set(k, `${k}=${v}`);
  return [...out.keys()].sort().map(k => out.get(k)!);
};

/** Where a declared file is: `~` is the home folder, `$NAME` a declared variable, a relative path is under the root. */
export const resolveBuildFile = (entry: string, root: string, env: NodeJS.ProcessEnv, declaredEnv: BuildEnvEntry[] = []): string | undefined => {
  const v = /^\$(?:\{(\w+)\}|(\w+))(.*)$/.exec(entry);
  if (v) {
    const name = (v[1] ?? v[2])!;
    if (!parseEnv(declaredEnv).declared(name)) throw new BuildError(`build files: ${entry} names $${name}, which is not in the build's env`);
    const value = env[name];
    if (!value) return undefined;
    const file = path.resolve(root, `${value}${v[3]}`);
    if (!fs.existsSync(file)) throw new BuildError(`build files: $${name} points at ${file}, which does not exist`);
    return file;
  }
  if (entry === '~' || entry.startsWith('~/')) return path.join(os.homedir(), entry.slice(1));
  return path.resolve(root, entry);
};

const walkFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === '.git' || e.name === '.DS_Store') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out;
};

/**
 * The fingerprint of a build: its command and output, the toolchain, and the path and content of every input file.
 * A file listed by git but gone from the disk (deleted, not yet staged) counts as absent. Declared variables and
 * files are added after them, so a build that declares none keeps the fingerprint it had before they existed.
 */
export const fingerprint = (root: string, spec: NativeBuildSpec, inputs: string[], toolchain = '', given: NodeJS.ProcessEnv = process.env): Fingerprint => {
  const t0 = Date.now();
  const env = withDefaults(given, parseEnv(spec.env).defaults);
  const res = inputs.filter(g => !g.startsWith('!')).map(globRe);
  const not = inputs.filter(g => g.startsWith('!')).map(g => globRe(g.slice(1)));
  const files = listFiles(root)
    .filter(f => res.some(r => r.test(f)) && !not.some(r => r.test(f)))
    .sort();
  const h = crypto.createHash('sha256');
  h.update(`${spec.command}\0${spec.output}\0${toolchain}\0`);
  let n = 0;
  for (const f of files) {
    let body: Buffer;
    try {
      body = fs.readFileSync(path.join(root, f));
    } catch {
      continue;
    }
    h.update(`${f}\0${body.length}\0`);
    h.update(body);
    n++;
  }
  let variant: string | undefined;
  if (spec.env && parseEnv(spec.env).any) {
    const entries = envEntries(spec.env, env);
    h.update(`\0env\0${entries.join('\0')}\0`);
    variant = crypto.createHash('sha256').update(entries.join('\0')).digest('hex').slice(0, 8);
  }
  if (spec.envStrict) {
    // Added only when asked for, so a build that is not strict keeps its fingerprint.
    const roots = TOOLCHAIN_ROOTS.map(k => [k, Object.entries(env).find(([n]) => n.toUpperCase() === k)?.[1]] as const);
    h.update(`\0strict\0${roots.map(([k, v]) => (v === undefined ? `${k}\0unset` : `${k}=${v}`)).join('\0')}\0`);
  }
  for (const entry of spec.files ?? []) {
    h.update(`\0file\0${entry}\0`);
    const file = resolveBuildFile(entry, root, env, spec.env);
    const st = file ? fs.statSync(file, {throwIfNoEntry: false}) : undefined;
    if (!file || !st) {
      h.update('absent\0');
      continue;
    }
    for (const rel of st.isDirectory() ? walkFiles(file) : ['']) {
      const body = fs.readFileSync(rel ? path.join(file, rel) : file);
      h.update(`${rel}\0${body.length}\0`);
      h.update(body);
      n++;
    }
  }
  return {hash: h.digest('hex').slice(0, 16), files: n, ms: Date.now() - t0, ...(variant ? {variant} : {})};
};

/** Where an app's builds for a platform are kept: by the app's id, so every checkout of it shares them. */
export const buildsDir = (app: string, platform: NativePlatform, cacheRoot = path.join(os.homedir(), 'Library', 'Caches', 'pitbox', 'builds')) =>
  path.join(cacheRoot, app.replace(/[^\w.-]/g, '_'), platform);

const DONE = 'build.json';
/** Builds kept per variant (the values of the declared variables) of an app and platform. */
export const KEEP_BUILDS = 5;
/** Days a build stays unused before it goes. */
export const KEEP_DAYS = 30;
/** A build used (built or reused) this recently is never dropped: another session may be installing it. */
export const IN_USE_MS = 15 * 60_000;

type Done = {builtAt: number; ms: number; command: string; artifact: string; variant?: string};

const readDone = (dir: string): Done | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, DONE), 'utf8')) as Done;
  } catch {
    return undefined;
  }
};

/** A copy of a file or an .app folder; a clone on APFS, so a 200 MB app costs no space and no time. */
const copy = (from: string, to: string) => {
  if (process.platform === 'darwin') execFileSync('cp', ['-cR', from, to], {stdio: 'ignore'});
  else fs.cpSync(from, to, {recursive: true});
};

const folderBytes = (p: string): number => {
  const st = fs.lstatSync(p, {throwIfNoEntry: false});
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of fs.readdirSync(p)) n += folderBytes(path.join(p, e));
  return n;
};

/**
 * Drops old builds of the folder: beyond the `count` most recently used of each variant, unused for `days`, or past
 * `mb` in all (the least recently used go first). Never `current`, nor one used in the last `inUseMs`: another
 * session may be installing it. A build goes by a rename first, so a reader sees it whole or not at all.
 */
export const gcBuilds = (dir: string, current: string, keep: number | BuildKeep = {}, o: {now?: number; inUseMs?: number} = {}): string[] => {
  const k = typeof keep === 'number' ? {count: keep} : keep;
  const count = k.count ?? KEEP_BUILDS;
  const days = k.days ?? KEEP_DAYS;
  const now = o.now ?? Date.now();
  const inUseMs = o.inUseMs ?? IN_USE_MS;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const built = names
    .filter(n => !n.includes('.'))
    .map(n => {
      const done = readDone(path.join(dir, n));
      const st = fs.statSync(path.join(dir, n, DONE), {throwIfNoEntry: false});
      return done && st ? {n, used: Math.max(done.builtAt, st.mtimeMs), variant: done.variant ?? ''} : undefined;
    })
    .filter((x): x is {n: string; used: number; variant: string} => !!x)
    .sort((a, b) => b.used - a.used);
  const drop = new Set<string>();
  const seen = new Map<string, number>();
  for (const x of built) {
    const i = (seen.get(x.variant) ?? 0) + 1;
    seen.set(x.variant, i);
    if (i > count || now - x.used > days * 86_400_000) drop.add(x.n);
  }
  if (k.mb !== undefined) {
    let bytes = 0;
    for (const x of built) {
      if (drop.has(x.n)) continue;
      bytes += folderBytes(path.join(dir, x.n));
      if (bytes > k.mb * 1024 * 1024) drop.add(x.n);
    }
  }
  const gone: string[] = [];
  for (const x of built) {
    if (!drop.has(x.n) || x.n === current || now - x.used < inUseMs) continue;
    const away = path.join(dir, `${x.n}.gone-${process.pid}`);
    try {
      fs.renameSync(path.join(dir, x.n), away);
    } catch {
      continue; // dropped by another process meanwhile
    }
    fs.rmSync(away, {recursive: true, force: true});
    gone.push(x.n);
  }
  return gone;
};

export type BuildResult = {
  platform: NativePlatform;
  fingerprint: string;
  /** Taken from the cache: built before, here or by another checkout or session. */
  reused: boolean;
  /** The cached artifact, to install. */
  artifact: string;
  ms: number;
  /** For a reused build: when it was built. For a new one: how long the build took. */
  builtAt: number;
  buildMs: number;
  /** Ms waited for another process building the same fingerprint, or for the machine's build slot. */
  waitedMs?: number;
  inputs: number;
  /** The variant, a hash of the declared variables' values, when the build declares any. */
  variant?: string;
  /** Old builds dropped after this one was built. */
  dropped?: number;
};

export class BuildError extends Error {}

/**
 * The build of `spec` for its current inputs: from the cache, or built now. Builds of one fingerprint are single
 * flight across processes; native builds of any app take turns on the machine (`native-build` lock).
 */
export const ensureBuild = async (o: {root: string; app: string; platform: NativePlatform; spec: NativeBuildSpec; inputs: string[]; toolchain?: string; cacheRoot?: string; shell?: string; callerEnv?: Record<string, string | undefined>}): Promise<BuildResult> => {
  const t0 = Date.now();
  const env = buildEnv(o.spec, process.env, o.callerEnv);
  const fp = fingerprint(o.root, o.spec, o.inputs, o.toolchain, env);
  const variant = fp.variant ? {variant: fp.variant} : {};
  const dir = buildsDir(o.app, o.platform, o.cacheRoot);
  const slot = path.join(dir, fp.hash);
  const name = path.basename(o.spec.output);
  const hit = (waitedMs?: number): BuildResult | undefined => {
    const done = readDone(slot);
    if (!done || !fs.existsSync(path.join(slot, name))) return undefined;
    fs.utimesSync(path.join(slot, DONE), new Date(), new Date());
    return {platform: o.platform, fingerprint: fp.hash, reused: true, artifact: path.join(slot, name), ms: Date.now() - t0, builtAt: done.builtAt, buildMs: done.ms, inputs: fp.files, ...variant, ...(waitedMs ? {waitedMs} : {})};
  };
  const cached = hit();
  if (cached) return cached;
  const timeoutMs = (o.spec.timeout ?? 1800) * 1000;
  fs.mkdirSync(dir, {recursive: true});
  const lockName = `build-${o.app.replace(/[^\w.-]/g, '_')}-${o.platform}-${fp.hash}`;
  const tWait = Date.now();
  return machineLock(
    lockName,
    async () => {
      // Built by another process while this one waited.
      const other = hit(Date.now() - tWait);
      if (other) return other;
      return machineLock(
        'native-build',
        async () => {
          const waitedMs = Date.now() - tWait;
          const tb = Date.now();
          const r = await runShell(o.spec.command, {cwd: o.root, env, timeoutMs, ...(o.shell ? {shell: o.shell} : {})});
          const buildMs = Date.now() - tb;
          if (r.code !== 0) {
            const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).filter(l => l.trim()).slice(-8).join('\n');
            throw new BuildError(`the build failed (exit ${r.code} after ${Math.round(buildMs / 1000)}s): ${o.spec.command}\n${tail}`);
          }
          const out = path.resolve(o.root, o.spec.output);
          if (!fs.existsSync(out)) throw new BuildError(`the build left no ${o.spec.output}`);
          // Filled beside the slot and renamed into it: a slot is whole or absent.
          const tmp = `${slot}.tmp-${process.pid}`;
          fs.rmSync(tmp, {recursive: true, force: true});
          fs.mkdirSync(tmp, {recursive: true});
          copy(out, path.join(tmp, name));
          const done: Done = {builtAt: Date.now(), ms: buildMs, command: o.spec.command, artifact: name, ...variant};
          fs.writeFileSync(path.join(tmp, DONE), JSON.stringify(done));
          fs.rmSync(slot, {recursive: true, force: true});
          fs.renameSync(tmp, slot);
          // A build that rewrites its own inputs (`pod install` updating Podfile.lock, codegen into a tracked file)
          // is kept under the fingerprint it leaves as well: the next request asks for that one.
          const after = fingerprint(o.root, o.spec, o.inputs, o.toolchain, env).hash;
          if (after !== fp.hash) {
            const again = path.join(dir, after);
            const tmp2 = `${again}.tmp-${process.pid}`;
            fs.rmSync(tmp2, {recursive: true, force: true});
            fs.mkdirSync(tmp2, {recursive: true});
            copy(path.join(slot, name), path.join(tmp2, name));
            fs.writeFileSync(path.join(tmp2, DONE), JSON.stringify(done));
            fs.rmSync(again, {recursive: true, force: true});
            fs.renameSync(tmp2, again);
          }
          const dropped = gcBuilds(dir, fp.hash, o.spec.keep).length;
          return {platform: o.platform, fingerprint: fp.hash, reused: false, artifact: path.join(slot, name), ms: Date.now() - t0, builtAt: done.builtAt, buildMs, inputs: fp.files, ...variant, ...(waitedMs > 1000 ? {waitedMs} : {}), ...(dropped ? {dropped} : {})};
        },
        timeoutMs + 60 * 60_000,
      );
    },
    timeoutMs * 2 + 60 * 60_000,
  );
};
