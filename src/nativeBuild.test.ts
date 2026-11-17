import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BuildError, buildsDir, ensureBuild, fingerprint, gcBuilds, globRe, jsAppInputs, listFiles} from './native/builds.ts';

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

  it('keeps the newest builds only', async () => {
    for (let i = 0; i < 5; i++) {
      write('android/Main.kt', `fun main() = ${i}`);
      await build();
    }
    const dir = buildsDir('com.example.app', 'android', cache);
    expect(fs.readdirSync(dir)).toHaveLength(3);
    expect(gcBuilds(dir, 'none', 1)).toHaveLength(2);
  });
});
