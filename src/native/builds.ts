// Native builds made once and shared. A build is keyed by a fingerprint of its native inputs; the artifact (an .apk
// or an .app) is kept under ~/Library/Caches/pitbox/builds, shared by every checkout and worktree of the app and
// every session on the machine. A fingerprint built before is installed from the cache in seconds; a missing one is
// built by one process while the others wanting it wait for it (single flight), and native builds of any kind run
// one at a time on the machine, as several at once only make each slower.
//
// For an app with a JS dev server (React Native and the like) the JS is not a native input: the debug build loads it
// from the dev server, so a JS-only change reuses the build. The default inputs are then the platform's folder, the
// package manifests and lock files and the app's config; a native app takes every file git sees.

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
};

const MANIFESTS = ['package.json', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'app.json', 'app.config.*', 'eas.json', 'react-native.config.js', 'patches/**', '.yarnrc.yml'];

/** Inputs of a build whose JS comes from a dev server: the platform's folder, manifests, lock files, app config. */
export const jsAppInputs = (platform: NativePlatform): string[] => [platform === 'ios' ? 'ios/**' : 'android/**', ...MANIFESTS];

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

export type Fingerprint = {hash: string; files: number; ms: number};

/**
 * The fingerprint of a build: its command and output, the toolchain, and the path and content of every input file.
 * A file listed by git but gone from the disk (deleted, not yet staged) counts as absent.
 */
export const fingerprint = (root: string, spec: NativeBuildSpec, inputs: string[], toolchain = ''): Fingerprint => {
  const t0 = Date.now();
  const res = inputs.map(globRe);
  const files = listFiles(root)
    .filter(f => res.some(r => r.test(f)))
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
  return {hash: h.digest('hex').slice(0, 16), files: n, ms: Date.now() - t0};
};

/** Where an app's builds for a platform are kept: by the app's id, so every checkout of it shares them. */
export const buildsDir = (app: string, platform: NativePlatform, cacheRoot = path.join(os.homedir(), 'Library', 'Caches', 'pitbox', 'builds')) =>
  path.join(cacheRoot, app.replace(/[^\w.-]/g, '_'), platform);

const DONE = 'build.json';
export const KEEP_BUILDS = 3;

type Done = {builtAt: number; ms: number; command: string; artifact: string};

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

/** Drops all but the `keep` newest builds of the folder, never `current`. */
export const gcBuilds = (dir: string, current: string, keep = KEEP_BUILDS): string[] => {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const built = names
    .map(n => ({n, at: readDone(path.join(dir, n))?.builtAt}))
    .filter((x): x is {n: string; at: number} => typeof x.at === 'number')
    .sort((a, b) => b.at - a.at);
  const gone: string[] = [];
  for (const x of built.slice(keep)) {
    if (x.n === current) continue;
    fs.rmSync(path.join(dir, x.n), {recursive: true, force: true});
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
};

export class BuildError extends Error {}

/**
 * The build of `spec` for its current inputs: from the cache, or built now. Builds of one fingerprint are single
 * flight across processes; native builds of any app take turns on the machine (`native-build` lock).
 */
export const ensureBuild = async (o: {root: string; app: string; platform: NativePlatform; spec: NativeBuildSpec; inputs: string[]; toolchain?: string; cacheRoot?: string; shell?: string}): Promise<BuildResult> => {
  const t0 = Date.now();
  const fp = fingerprint(o.root, o.spec, o.inputs, o.toolchain);
  const dir = buildsDir(o.app, o.platform, o.cacheRoot);
  const slot = path.join(dir, fp.hash);
  const name = path.basename(o.spec.output);
  const hit = (waitedMs?: number): BuildResult | undefined => {
    const done = readDone(slot);
    if (!done || !fs.existsSync(path.join(slot, name))) return undefined;
    fs.utimesSync(path.join(slot, DONE), new Date(), new Date());
    return {platform: o.platform, fingerprint: fp.hash, reused: true, artifact: path.join(slot, name), ms: Date.now() - t0, builtAt: done.builtAt, buildMs: done.ms, inputs: fp.files, ...(waitedMs ? {waitedMs} : {})};
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
          const r = await runShell(o.spec.command, {cwd: o.root, timeoutMs, ...(o.shell ? {shell: o.shell} : {})});
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
          const done: Done = {builtAt: Date.now(), ms: buildMs, command: o.spec.command, artifact: name};
          fs.writeFileSync(path.join(tmp, DONE), JSON.stringify(done));
          fs.rmSync(slot, {recursive: true, force: true});
          fs.renameSync(tmp, slot);
          // A build that rewrites its own inputs (`pod install` updating Podfile.lock, codegen into a tracked file)
          // is kept under the fingerprint it leaves as well: the next request asks for that one.
          const after = fingerprint(o.root, o.spec, o.inputs, o.toolchain).hash;
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
          gcBuilds(dir, fp.hash);
          return {platform: o.platform, fingerprint: fp.hash, reused: false, artifact: path.join(slot, name), ms: Date.now() - t0, builtAt: done.builtAt, buildMs, inputs: fp.files, ...(waitedMs > 1000 ? {waitedMs} : {})};
        },
        timeoutMs + 60 * 60_000,
      );
    },
    timeoutMs * 2 + 60 * 60_000,
  );
};
