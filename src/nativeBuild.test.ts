import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {configSchema} from './config/schema.ts';
import {BuildError, STRICT_ENV, buildEnv, buildInputs, buildsDir, ensureBuild, envEntries, fingerprint, gcBuilds, globRe, jsAppInputs, listFiles} from './native/builds.ts';

let root: string;
let cache: string;
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true});
  fs.writeFileSync(path.join(root, rel), body);
};
// The "build": counts its runs in a file outside the project and leaves an .apk made of the native source.
const counter = () => path.join(cache, 'runs');
const runs = () => (fs.existsSync(counter()) ? fs.readFileSync(counter(), 'utf8').length : 0);
const spec = () => ({command: `sleep 0.3; printf x >> '${counter()}'; mkdir -p out; cat android/Main.kt > out/app.apk`, output: 'out/app.apk'});
const build = (over: {app?: string} = {}) => ensureBuild({root, app: over.app ?? 'com.example.app', platform: 'android', spec: spec(), inputs: jsAppInputs('android'), cacheRoot: cache});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-build-'));
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-builds-'));
  write('android/Main.kt', 'fun main() = 1');
  write('package.json', '{"name":"x"}');
  write('App.tsx', 'export default 1');
});
afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true});
  fs.rmSync(cache, {recursive: true, force: true});
});

describe('native build fingerprint', () => {
  it('matches globs over relative paths', () => {
    expect(globRe('android/**').test('android/app/build.gradle')).toBe(true);
    expect(globRe('android/**').test('androidx/a')).toBe(false);
    expect(globRe('app.config.*').test('app.config.ts')).toBe(true);
    expect(globRe('**/*.kt').test('Main.kt')).toBe(true);
    expect(globRe('**/*.kt').test('a/b/Main.kt')).toBe(true);
    expect(globRe('*.{json,lock}').test('yarn.lock')).toBe(true);
    expect(globRe('*.{json,lock}').test('a/yarn.lock')).toBe(false);
  });

  it('lists files without git too, skipping build folders', () => {
    write('node_modules/x/index.js', '');
    write('android/app/build/out.apk', '');
    expect(listFiles(root).sort()).toEqual(['App.tsx', 'android/Main.kt', 'package.json']);
  });

  it('a JS edit keeps the fingerprint of an app with a dev server; a native edit or a manifest changes it', () => {
    const fp = () => fingerprint(root, spec(), jsAppInputs('android')).hash;
    const a = fp();
    write('App.tsx', 'export default 2');
    expect(fp()).toBe(a);
    write('android/Main.kt', 'fun main() = 2');
    const b = fp();
    expect(b).not.toBe(a);
    write('package.json', '{"name":"x","dependencies":{"y":"1"}}');
    expect(fp()).not.toBe(b);
  });

  it('the command and the toolchain are inputs too', () => {
    const a = fingerprint(root, spec(), ['**'], 'Xcode 26.0').hash;
    expect(fingerprint(root, spec(), ['**'], 'Xcode 26.1').hash).not.toBe(a);
    expect(fingerprint(root, {...spec(), command: 'other'}, ['**'], 'Xcode 26.0').hash).not.toBe(a);
  });

  it('!globs exclude inputs; exclusions alone keep the default inputs', () => {
    write('docs/a.md', '1');
    write('flows/smoke.yaml', '1');
    const inputs = ['**', '!docs/**', '!flows/**'];
    const a = fingerprint(root, spec(), inputs).hash;
    write('docs/a.md', '2');
    write('flows/smoke.yaml', '2');
    expect(fingerprint(root, spec(), inputs).hash).toBe(a);
    write('App.tsx', 'export default 9');
    expect(fingerprint(root, spec(), inputs).hash).not.toBe(a);
    expect(buildInputs({inputs: ['!android/gen/**']}, 'android', true)).toEqual([...jsAppInputs('android'), '!android/gen/**']);
    expect(buildInputs({inputs: ['!x/**']}, 'ios', false)).toEqual(['**', '!x/**']);
    expect(buildInputs({}, 'android', true)).toEqual(jsAppInputs('android'));
    expect(buildInputs({inputs: ['android/**', '!android/x']}, 'android', true)).toEqual(['android/**', '!android/x']);
  });
});

describe('native build cache', () => {
  it('builds once; the same inputs come from the cache, a JS edit too', async () => {
    const first = await build();
    expect(first.reused).toBe(false);
    expect(fs.readFileSync(first.artifact, 'utf8')).toBe('fun main() = 1');
    write('App.tsx', 'export default 3');
    const second = await build();
    expect(second.reused).toBe(true);
    expect(second.artifact).toBe(first.artifact);
    expect(runs()).toBe(1);
    write('android/Main.kt', 'fun main() = 3');
    const third = await build();
    expect(third.reused).toBe(false);
    expect(fs.readFileSync(third.artifact, 'utf8')).toBe('fun main() = 3');
    expect(runs()).toBe(2);
  });

  it('a build that rewrites its own inputs is reused under the fingerprint it leaves', async () => {
    const rewrite = {command: `printf x >> '${counter()}'; printf '\\n# pods 1.17' >> package.json; mkdir -p out; cat android/Main.kt > out/app.apk`, output: 'out/app.apk'};
    const run = () => ensureBuild({root, app: 'com.example.app', platform: 'android', spec: rewrite, inputs: jsAppInputs('android'), cacheRoot: cache});
    expect((await run()).reused).toBe(false);
    // The command appends again on a rebuild only; the next request finds the build under the rewritten inputs.
    expect((await run()).reused).toBe(true);
    expect(runs()).toBe(1);
  });

  it('another checkout of the same app reuses the build', async () => {
    await build();
    const other = root;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-build-'));
    for (const f of ['android/Main.kt', 'package.json', 'App.tsx']) write(f, fs.readFileSync(path.join(other, f), 'utf8'));
    expect((await build()).reused).toBe(true);
    fs.rmSync(other, {recursive: true, force: true});
    expect(runs()).toBe(1);
  });

  it('concurrent requests for one fingerprint build once (single flight)', async () => {
    const all = await Promise.all([build(), build(), build()]);
    expect(runs()).toBe(1);
    expect(all.filter(r => !r.reused)).toHaveLength(1);
    expect(new Set(all.map(r => r.artifact)).size).toBe(1);
  });

  it('a failed build is said with its output and leaves nothing cached', async () => {
    const bad = ensureBuild({root, app: 'com.example.app', platform: 'android', spec: {command: 'echo boom >&2; exit 3', output: 'out/app.apk'}, inputs: ['**'], cacheRoot: cache});
    await expect(bad).rejects.toThrow(BuildError);
    await expect(bad).rejects.toThrow(/exit 3[\s\S]*boom/);
    expect(fs.readdirSync(buildsDir('com.example.app', 'android', cache))).toEqual([]);
  });

  it('a build that leaves no output fails', async () => {
    await expect(ensureBuild({root, app: 'com.example.app', platform: 'android', spec: {command: 'true', output: 'out/none.apk'}, inputs: ['**'], cacheRoot: cache})).rejects.toThrow(/left no out\/none.apk/);
  });

  it('keeps the newest builds per variant, never one used in the last minutes', async () => {
    const dir = buildsDir('com.example.app', 'android', cache);
    // The builds are made to look used hours ago, an hour apart in the order they were made, so none is in use.
    const done = (n: string) => JSON.parse(fs.readFileSync(path.join(dir, n, 'build.json'), 'utf8')) as {builtAt: number};
    const age = () => {
      if (!fs.existsSync(dir)) return;
      const names = fs.readdirSync(dir).sort((a, b) => done(a).builtAt - done(b).builtAt);
      for (const [i, n] of names.entries()) {
        const at = new Date(Date.now() - 3_600_000 * (20 - i));
        fs.writeFileSync(path.join(dir, n, 'build.json'), JSON.stringify({...done(n), builtAt: at.getTime()}));
        fs.utimesSync(path.join(dir, n, 'build.json'), at, at);
      }
    };
    for (let i = 0; i < 7; i++) {
      write('android/Main.kt', `fun main() = ${i}`);
      age();
      await build();
    }
    expect(fs.readdirSync(dir)).toHaveLength(5);
    // Two builds used just now (being installed by other sessions) both stay past a count of one; the others go.
    age();
    const used = fs.readdirSync(dir).sort((a, b) => done(a).builtAt - done(b).builtAt).slice(0, 2);
    for (const n of used) fs.utimesSync(path.join(dir, n, 'build.json'), new Date(), new Date());
    expect(gcBuilds(dir, 'none', 1)).toHaveLength(3);
    expect(fs.readdirSync(dir).sort()).toEqual(used.sort());
  });

  it('drops builds by age and by size, the least recently used first', () => {
    const dir = buildsDir('com.example.app', 'android', cache);
    const now = Date.now();
    const slot = (n: string, daysAgo: number, bytes: number, variant?: string) => {
      fs.mkdirSync(path.join(dir, n), {recursive: true});
      fs.writeFileSync(path.join(dir, n, 'app.apk'), Buffer.alloc(bytes));
      const at = new Date(now - daysAgo * 86_400_000);
      fs.writeFileSync(path.join(dir, n, 'build.json'), JSON.stringify({builtAt: at.getTime(), ms: 1, command: 'x', artifact: 'app.apk', ...(variant ? {variant} : {})}));
      fs.utimesSync(path.join(dir, n, 'build.json'), at, at);
    };
    slot('a1', 1, 600_000);
    slot('a2', 2, 600_000);
    slot('a3', 40, 10);
    // A build reused recently counts by its last use, not by when it was built.
    slot('a4', 50, 10);
    fs.utimesSync(path.join(dir, 'a4', 'build.json'), new Date(now - 3 * 86_400_000), new Date(now - 3 * 86_400_000));
    expect(gcBuilds(dir, 'none', {}, {now}).sort()).toEqual(['a3']);
    expect(gcBuilds(dir, 'none', {mb: 1}, {now}).sort()).toEqual(['a2', 'a4']);
    expect(fs.readdirSync(dir)).toEqual(['a1']);
  });

  it('variants do not evict each other', async () => {
    const dir = buildsDir('com.example.app', 'android', cache);
    const probe = {...spec(), env: ['APP_PROBE'], keep: {count: 1}};
    const run = (env: Record<string, string>) => ensureBuild({root, app: 'com.example.app', platform: 'android', spec: probe, inputs: jsAppInputs('android'), cacheRoot: cache, callerEnv: env});
    const plain = await run({});
    const probed = await run({APP_PROBE: '1'});
    expect(probed.variant).toBeDefined();
    expect(probed.variant).not.toBe(plain.variant);
    expect(probed.fingerprint).not.toBe(plain.fingerprint);
    // Both stay with a count of one: one per variant.
    for (const n of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, n, 'build.json'), new Date(0), new Date(0));
    expect(gcBuilds(dir, 'none', {count: 1, days: 1e6})).toEqual([]);
    expect((await run({})).reused).toBe(true);
    expect((await run({APP_PROBE: '1'})).reused).toBe(true);
    expect(runs()).toBe(2);
  });

  it('the build runs with the caller\'s values of the declared variables, unset when the caller has none', async () => {
    const s = {command: `mkdir -p out; printf "%s/%s" "\${APP_PROBE-unset}" "\${HOME:+home}" > out/app.apk`, output: 'out/app.apk', env: ['APP_PROBE']};
    const run = (callerEnv: Record<string, string>) => ensureBuild({root, app: 'com.example.app', platform: 'android', spec: s, inputs: ['**'], cacheRoot: cache, callerEnv});
    process.env.APP_PROBE = 'daemon';
    try {
      expect(fs.readFileSync((await run({})).artifact, 'utf8')).toBe('unset/home');
      expect(fs.readFileSync((await run({APP_PROBE: ''})).artifact, 'utf8')).toBe('/home');
      expect(fs.readFileSync((await run({APP_PROBE: '1'})).artifact, 'utf8')).toBe('1/home');
    } finally {
      delete process.env.APP_PROBE;
    }
  });
});

describe('native build variables, exclusions and outside files', () => {
  const fp = (over: object = {}, env: NodeJS.ProcessEnv = {}, inputs = ['**']) => fingerprint(root, {...spec(), ...over}, inputs, '', env).hash;

  it('a build that declares nothing keeps its fingerprint, whatever the environment', () => {
    const a = fp({}, {APP_PROBE: '1'});
    expect(fp({}, {})).toBe(a);
    expect(fp({env: [], files: []}, {APP_X: '2'})).toBe(a);
    expect(fingerprint(root, spec(), ['**']).variant).toBeUndefined();
  });

  it('declared variables are inputs: names and globs, unset differs from empty', () => {
    const e = {env: ['APP_PROBE', 'APP_PUBLIC_*']};
    const unset = fp(e, {});
    const empty = fp(e, {APP_PROBE: ''});
    const one = fp(e, {APP_PROBE: '1'});
    expect(new Set([unset, empty, one]).size).toBe(3);
    expect(fp(e, {APP_PROBE: '1', OTHER: 'x'})).toBe(one);
    expect(fp(e, {APP_PROBE: '1', APP_PUBLIC_URL: 'a'})).not.toBe(one);
    expect(fp(e, {APP_PROBE: '1', APP_PUBLIC_URL: 'b'})).not.toBe(fp(e, {APP_PROBE: '1', APP_PUBLIC_URL: 'a'}));
    expect(fp(e, {APP_PROBE: '1', APP_PUBLIC_URL: ''})).not.toBe(one);
    expect(envEntries(['B', 'A_*'], {A_2: 'x', A_1: 'y', B: 'z', C: 'w'})).toEqual(['A_1=y', 'A_2=x', 'B=z']);
  });

  it('!name and !glob entries leave variables out, wherever they stand', () => {
    const e = {env: ['APP_*', '!APP_DEV_PORT', '!APP_FIXTURE_*']};
    const base = fp(e, {APP_ARCH: 'arm64'});
    expect(fp(e, {APP_ARCH: 'arm64', APP_DEV_PORT: '1', APP_FIXTURE_PORT: '2', APP_FIXTURE_HOST: 'h'})).toBe(base);
    expect(fp(e, {APP_ARCH: 'x86_64'})).not.toBe(base);
    // Position-independent: an exclusion before the pattern it narrows works the same.
    expect(fp({env: ['!APP_DEV_PORT', '!APP_FIXTURE_*', 'APP_*']}, {APP_ARCH: 'arm64', APP_DEV_PORT: '9'})).toBe(base);
    // A plain name excluded is not counted as unset either, and an excluded name is never a literal one.
    expect(envEntries(['A', 'B', '!B', '!C'], {B: '1', C: '2'})).toEqual(['A\0unset']);
    expect(envEntries(['APP_*', '!APP_X'], {APP_X: '1', APP_Y: '2'})).toEqual(['APP_Y=2']);
    // Exclusions alone declare nothing: the build keeps the fingerprint it has without env.
    expect(fp({env: ['!APP_X']}, {APP_X: '1'})).toBe(fp({}, {}));
    expect(fingerprint(root, {...spec(), env: ['!APP_X']}, ['**'], '', {}).variant).toBeUndefined();
  });

  it('a declared default: unset and the default are one build, other values are their own', () => {
    const e = {env: ['APP_*', {name: 'APP_ARCH', default: 'arm64'}]};
    const unset = fp(e, {});
    expect(fp(e, {APP_ARCH: 'arm64'})).toBe(unset);
    expect(fp(e, {APP_ARCH: 'x86_64'})).not.toBe(unset);
    expect(fp(e, {APP_ARCH: ''})).not.toBe(unset);
    expect(fingerprint(root, {...spec(), ...e}, ['**'], '', {}).variant).toBe(fingerprint(root, {...spec(), ...e}, ['**'], '', {APP_ARCH: 'arm64'}).variant);
    // Opting into a default keeps the fingerprint of the builds made with the variable set to it.
    expect(fp({env: ['APP_*', 'APP_ARCH']}, {APP_ARCH: 'arm64'})).toBe(unset);
    expect(fp({env: [{name: 'APP_ARCH'}]}, {})).toBe(fp({env: ['APP_ARCH']}, {}));
    expect(envEntries([{name: 'B', default: 'd'}, 'A'], {})).toEqual(['A\0unset', 'B=d']);
    // An excluded name takes no default.
    expect(envEntries(['APP_*', '!APP_ARCH', {name: 'APP_ARCH', default: 'arm64'}], {})).toEqual([]);
    expect(() => envEntries([{name: 'APP_*', default: 'x'}], {})).toThrow(/plain name/);
  });

  it('the config takes defaults on plain names only', () => {
    const cfg = (env: unknown[]) => configSchema.safeParse({app: {build: {android: {command: 'x', output: 'a.apk', env}}}}).success;
    expect(cfg(['APP_*', '!APP_DEV_PORT', {name: 'APP_ARCH', default: 'arm64'}, {name: 'APP_X'}])).toBe(true);
    expect(cfg([{name: 'APP_*', default: 'x'}])).toBe(false);
    expect(cfg([{name: 'APP_X', default: 1}])).toBe(false);
  });

  it('the build gets the default when the caller leaves the variable unset', async () => {
    const s = {command: `mkdir -p out; printf "%s" "\${APP_ARCH-unset}" > out/app.apk`, output: 'out/app.apk', env: [{name: 'APP_ARCH', default: 'arm64'}]};
    const run = (callerEnv?: Record<string, string>) => ensureBuild({root, app: 'com.example.app', platform: 'android', spec: s, inputs: ['**'], cacheRoot: cache, ...(callerEnv ? {callerEnv} : {})});
    const first = await run({});
    expect(fs.readFileSync(first.artifact, 'utf8')).toBe('arm64');
    expect(first.reused).toBe(false);
    expect((await run({APP_ARCH: 'arm64'})).reused).toBe(true);
    expect((await run()).reused).toBe(true);
    const other = await run({APP_ARCH: 'x86_64'});
    expect(other.reused).toBe(false);
    expect(fs.readFileSync(other.artifact, 'utf8')).toBe('x86_64');
    expect(buildEnv(s, {PATH: '/bin'})).toEqual({PATH: '/bin', APP_ARCH: 'arm64'});
  });

  it('envStrict: only the declared variables and the baseline, all from the caller', () => {
    const daemon = {PATH: '/daemon/bin', HOME: '/daemon', JAVA_HOME: '/daemon/jdk', APP_A: 'daemon', APP_B: 'daemon', OTHER_DAEMON: 'x'};
    const caller = {PATH: '/caller/bin', HOME: '/caller', LANG: 'en_US.UTF-8', LC_ALL: 'C', https_proxy: 'p', APP_A: 'caller', APP_DEV_PORT: '1', NODE_ENV: 'production', OTHER: 'y'};
    const s = {env: ['APP_*', '!APP_DEV_PORT', {name: 'APP_ARCH', default: 'arm64'}], envStrict: true};
    expect(buildEnv(s, daemon, caller)).toEqual({PATH: '/caller/bin', HOME: '/caller', LANG: 'en_US.UTF-8', LC_ALL: 'C', https_proxy: 'p', APP_A: 'caller', APP_ARCH: 'arm64'});
    // Windows spells its variables in any case.
    expect(buildEnv({envStrict: true}, {}, {Path: 'C:\\bin', SystemRoot: 'C:\\Windows', Foo: '1'})).toEqual({Path: 'C:\\bin', SystemRoot: 'C:\\Windows'});
    // Without a caller, the daemon's view is filtered the same way.
    expect(buildEnv({envStrict: true}, daemon)).toEqual({PATH: '/daemon/bin', HOME: '/daemon', JAVA_HOME: '/daemon/jdk'});
    expect(STRICT_ENV).toEqual(expect.arrayContaining(['PATH', 'HOME', 'LANG', 'LC_*', 'TMPDIR', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'DEVELOPER_DIR']));
  });

  it('envStrict is in the fingerprint with the toolchain roots, not the search path', () => {
    const strict = {envStrict: true};
    const a = fp(strict, {PATH: '/a', JAVA_HOME: '/jdk17'});
    expect(a).not.toBe(fp({}, {PATH: '/a', JAVA_HOME: '/jdk17'}));
    expect(fp(strict, {PATH: '/b', JAVA_HOME: '/jdk17', OTHER: 'x'})).toBe(a);
    expect(fp(strict, {PATH: '/a', JAVA_HOME: '/jdk21'})).not.toBe(a);
    expect(fp(strict, {PATH: '/a', JAVA_HOME: '/jdk17', DEVELOPER_DIR: '/Applications/Xcode.app'})).not.toBe(a);
    // Not strict: the toolchain roots stay out of the fingerprint, as before.
    expect(fp({}, {JAVA_HOME: '/jdk21'})).toBe(fp({}, {JAVA_HOME: '/jdk17'}));
  });

  it('a strict build sees nothing undeclared, from the daemon or the caller', async () => {
    const s = {command: 'mkdir -p out; printf "%s/%s/%s/%s" "${APP_A-unset}" "${APP_DAEMON_ONLY-unset}" "${UNDECLARED-unset}" "${HOME:+home}" > out/app.apk', output: 'out/app.apk', env: ['APP_*'], envStrict: true};
    const run = (callerEnv: Record<string, string>) => ensureBuild({root, app: 'com.example.app', platform: 'android', spec: s, inputs: ['**'], cacheRoot: cache, callerEnv});
    process.env.APP_DAEMON_ONLY = 'daemon';
    process.env.UNDECLARED = 'daemon';
    try {
      const home = process.env.HOME!;
      expect(fs.readFileSync((await run({HOME: home, APP_A: '1', UNDECLARED: 'caller'})).artifact, 'utf8')).toBe('1/unset/unset/home');
      // Not strict: a daemon-only value of a declared pattern still never reaches the build.
      const loose = {...s, envStrict: false};
      const r = await ensureBuild({root, app: 'com.example.app', platform: 'android', spec: loose, inputs: ['**'], cacheRoot: cache, callerEnv: {APP_A: '1'}});
      expect(fs.readFileSync(r.artifact, 'utf8')).toBe('1/unset/daemon/home');
    } finally {
      delete process.env.APP_DAEMON_ONLY;
      delete process.env.UNDECLARED;
    }
  });

  it('an excluded variable is not taken from the caller', () => {
    const env = buildEnv({env: ['APP_*', '!APP_DEV_PORT']}, {APP_DEV_PORT: 'daemon', APP_A: 'daemon'}, {APP_DEV_PORT: 'caller', APP_A: 'caller'});
    expect(env).toEqual({APP_DEV_PORT: 'daemon', APP_A: 'caller'});
  });

  it('the build environment takes the declared variables from the caller only', () => {
    const env = buildEnv({env: ['APP_*']}, {PATH: '/bin', APP_A: 'daemon', APP_B: 'daemon'}, {APP_A: 'caller', OTHER: 'x'});
    expect(env).toEqual({PATH: '/bin', APP_A: 'caller'});
    expect(buildEnv({}, {PATH: '/bin'}, {APP_A: 'x'})).toEqual({PATH: '/bin'});
  });

  it('declared files outside the checkout or ignored count by content; a missing one counts as absent', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-preset-'));
    try {
      const preset = path.join(outside, 'preset.json');
      const files = {files: [preset, 'local/secret.env']};
      const missing = fp(files);
      fs.writeFileSync(preset, '{"a":1}');
      const one = fp(files);
      expect(one).not.toBe(missing);
      fs.writeFileSync(preset, '{"a":2}');
      const two = fp(files);
      expect(two).not.toBe(one);
      // An ignored file (no git here: listed by the walk too, so excluded from the globs to stand for one).
      write('local/secret.env', 'A=1');
      const withLocal = fp(files, {}, ['**', '!local/**']);
      write('local/secret.env', 'A=2');
      expect(fp(files, {}, ['**', '!local/**'])).not.toBe(withLocal);
      // A folder counts by every file in it.
      const folder = {files: [outside]};
      const f1 = fp(folder);
      fs.writeFileSync(path.join(outside, 'more.txt'), 'x');
      expect(fp(folder)).not.toBe(f1);
    } finally {
      fs.rmSync(outside, {recursive: true, force: true});
    }
  });

  it('a file named by a declared variable: unset adds nothing, a path to nothing is an error', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-preset-'));
    try {
      const preset = path.join(outside, 'preset.json');
      fs.writeFileSync(preset, '1');
      const s = {env: ['APP_PRESET'], files: ['$APP_PRESET']};
      const a = fp(s, {APP_PRESET: preset});
      fs.writeFileSync(preset, '2');
      expect(fp(s, {APP_PRESET: preset})).not.toBe(a);
      expect(fp(s, {})).not.toBe(a);
      expect(() => fp(s, {APP_PRESET: path.join(outside, 'none.json')})).toThrow(/APP_PRESET points at .*none.json/);
      expect(() => fp({files: ['$APP_PRESET']}, {APP_PRESET: preset})).toThrow(/not in the build's env/);
      expect(() => fp({env: ['APP_DIR'], files: ['${APP_DIR}/preset.json']}, {APP_DIR: outside})).not.toThrow();
    } finally {
      fs.rmSync(outside, {recursive: true, force: true});
    }
  });

  it('~ is the home folder', () => {
    const home = process.env.HOME;
    process.env.HOME = root;
    try {
      const a = fp({files: ['~/local.json']});
      write('local.json', 'x');
      expect(fp({files: ['~/local.json']})).not.toBe(a);
    } finally {
      process.env.HOME = home;
    }
  });
});
