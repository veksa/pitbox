// Dev-server timing benchmark: how long a JS dev server (Metro, Re.Pack, …) takes to come up, to build the
// first bundle, to serve it again, and to rebuild after an edit. Host-only — no device involved.
//
//   node bench/devserver.ts --cwd <app dir> --cmd "<start command>" --port 8081 \
//     --bundle "/index.bundle?platform=android&dev=true" [--touch <file>] [--cache cold|warm] [--label name]
//
// --cache cold   gives the server a fresh, empty temp dir (TMP/TEMP/TMPDIR), so nothing is reused
// --cache warm   reuses the benchmark's own temp dir from the previous run (default)
// The server's temp dir is never the system one, so other projects' caches are left alone.
// Prints one JSON line per run; human notes go to stderr.

import {spawn, execSync, type ChildProcess} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Args = {cwd: string; cmd: string; port: number; bundle: string; touch?: string; cache: 'cold' | 'warm'; label: string; timeoutMs: number};

const parseArgs = (argv: string[]): Args => {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cwd = get('cwd');
  const cmd = get('cmd');
  const bundle = get('bundle');
  if (!cwd || !cmd || !bundle) {
    throw new Error('required: --cwd, --cmd, --bundle');
  }
  return {
    cwd: path.resolve(cwd),
    cmd,
    bundle,
    port: Number(get('port') ?? 8081),
    touch: get('touch'),
    cache: get('cache') === 'cold' ? 'cold' : 'warm',
    label: get('label') ?? 'run',
    timeoutMs: Number(get('timeout') ?? 600_000),
  };
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const killTree = (child: ChildProcess) => {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${child.pid} /T /F`, {stdio: 'ignore'});
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
};

const portBusy = async (port: number) => {
  try {
    await fetch(`http://127.0.0.1:${port}/status`, {signal: AbortSignal.timeout(1000)});
    return true;
  } catch {
    return false;
  }
};

// Polls /status until the server is ready; returns ms since start. A framework CLI answers "running" there;
// a bare Metro has no such route and answers 404 as soon as its HTTP server is up, which counts as ready too.
const waitReady = async (port: number, t0: number, deadline: number) => {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, {signal: AbortSignal.timeout(1000)});
      const text = await res.text();
      if ((res.ok && text.includes('running')) || res.status === 404) return performance.now() - t0;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error('server did not become ready');
};

type Fetched = {ms: number; ttfbMs: number; bytes: number; gzipBytes: number; status: number};

const fetchBundle = async (url: string, timeoutMs: number): Promise<Fetched> => {
  const t0 = performance.now();
  const res = await fetch(url, {signal: AbortSignal.timeout(timeoutMs), headers: {'accept-encoding': 'identity'}});
  const ttfbMs = performance.now() - t0;
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = performance.now() - t0;
  if (!res.ok) {
    process.stderr.write(`bundle ${res.status}: ${buf.subarray(0, 400).toString()}\n`);
  }
  return {ms, ttfbMs, bytes: buf.length, gzipBytes: gzipSync(buf).length, status: res.status};
};

const round = (n: number) => Math.round(n);

const main = async () => {
  const a = parseArgs(process.argv.slice(2));
  if (await portBusy(a.port)) {
    throw new Error(`port ${a.port} is already serving — stop that server first`);
  }

  const tmpRoot = path.join(os.tmpdir(), 'pitbox-bench', path.basename(a.cwd));
  if (a.cache === 'cold') fs.rmSync(tmpRoot, {recursive: true, force: true});
  fs.mkdirSync(tmpRoot, {recursive: true});

  const env = {...process.env, TMP: tmpRoot, TEMP: tmpRoot, TMPDIR: tmpRoot, BROWSER: 'none', CI: undefined};
  delete env.CI;
  const t0 = performance.now();
  const child = spawn(a.cmd, {cwd: a.cwd, env, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
  const log: string[] = [];
  child.stdout?.on('data', d => log.push(String(d)));
  child.stderr?.on('data', d => log.push(String(d)));

  const result: Record<string, unknown> = {label: a.label, cache: a.cache, host: `${process.platform}-${os.arch()}`, cpus: os.cpus().length};
  try {
    const deadline = Date.now() + a.timeoutMs;
    result.readyMs = round(await waitReady(a.port, t0, deadline));

    const url = `http://127.0.0.1:${a.port}${a.bundle}`;
    const first = await fetchBundle(url, a.timeoutMs);
    result.firstBundleMs = round(first.ms);
    result.firstTtfbMs = round(first.ttfbMs);
    result.bundleKB = round(first.bytes / 1024);
    result.bundleGzipKB = round(first.gzipBytes / 1024);
    result.status = first.status;

    const second = await fetchBundle(url, a.timeoutMs);
    result.secondBundleMs = round(second.ms);

    if (a.touch) {
      const file = path.resolve(a.cwd, a.touch);
      const original = fs.readFileSync(file);
      try {
        fs.writeFileSync(file, Buffer.concat([original, Buffer.from(`\n// pitbox-bench ${Date.now()}\n`)]));
        const tEdit = performance.now();
        // The server rebuilds lazily on the next request; poll until the body changes.
        let edited: Fetched | undefined;
        for (let i = 0; i < 50; i++) {
          edited = await fetchBundle(url, a.timeoutMs);
          if (edited.bytes !== second.bytes) break;
          await sleep(100);
        }
        result.editToBundleMs = round(performance.now() - tEdit);
        result.editDetected = edited !== undefined && edited.bytes !== second.bytes;
      } finally {
        fs.writeFileSync(file, original);
      }
    }
    const modules = [...log.join('').matchAll(/Bundled (\d+)ms .*?\((\d+) modules?\)/g)].map(m => [Number(m[1]), Number(m[2])]);
    if (modules.length) result.serverReports = modules.slice(0, 4);
  } catch (e) {
    result.error = (e as Error).message;
    result.logTail = log.join('').split('\n').slice(-15).join('\n');
  } finally {
    killTree(child);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

await main();
