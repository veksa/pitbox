// Host-side Hermes bytecode: the device skips parsing and compiling megabytes of source on every dev start.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {run} from '../util/proc.ts';

const binDir = () => (process.platform === 'win32' ? 'win64-bin' : process.platform === 'darwin' ? 'osx-bin' : 'linux64-bin');
const exe = process.platform === 'win32' ? 'hermesc.exe' : 'hermesc';

/** The app's own Hermes compiler, so the bytecode version matches the runtime the app was built with. */
export const findHermesc = (root: string): string | undefined => {
  const candidates = [
    path.join(root, 'node_modules', 'hermes-compiler', 'hermesc', binDir(), exe),
    path.join(root, 'node_modules', 'react-native', 'sdks', 'hermesc', binDir(), exe),
  ];
  return candidates.find(c => fs.existsSync(c));
};

export type Compiler = (source: Buffer) => Promise<Buffer>;

/** `-O0`: optimizing a 16 MB dev bundle takes ~5× longer and buys nothing in development. */
export const hermesCompiler = (hermesc: string, workDir: string): Compiler => async source => {
  fs.mkdirSync(workDir, {recursive: true});
  const id = crypto.randomBytes(6).toString('hex');
  const js = path.join(workDir, `${id}.js`);
  const hbc = path.join(workDir, `${id}.hbc`);
  fs.writeFileSync(js, source);
  try {
    const r = await run(hermesc, ['-emit-binary', '-O0', '-w', '-out', hbc, js], {timeoutMs: 300_000});
    if (r.code !== 0 || !fs.existsSync(hbc)) throw new Error(`hermesc failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
    return fs.readFileSync(hbc);
  } finally {
    fs.rmSync(js, {force: true});
    fs.rmSync(hbc, {force: true});
  }
};

/** Bytecode cache keyed by the source's hash, kept small on disk. */
export class BytecodeCache {
  readonly #dir: string;
  readonly #keep: number;

  constructor(dir: string, keep = 4) {
    this.#dir = dir;
    this.#keep = keep;
    fs.mkdirSync(dir, {recursive: true});
  }

  static key(source: Buffer) {
    return crypto.createHash('sha1').update(source).digest('hex');
  }

  get(key: string): Buffer | undefined {
    const file = path.join(this.#dir, `${key}.hbc`);
    if (!fs.existsSync(file)) return undefined;
    fs.utimesSync(file, new Date(), new Date());
    return fs.readFileSync(file);
  }

  put(key: string, bytecode: Buffer) {
    fs.writeFileSync(path.join(this.#dir, `${key}.hbc`), bytecode);
    const files = fs
      .readdirSync(this.#dir)
      .filter(f => f.endsWith('.hbc'))
      .map(f => ({f, t: fs.statSync(path.join(this.#dir, f)).mtimeMs}))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(this.#keep)) fs.rmSync(path.join(this.#dir, old.f), {force: true});
  }
}
