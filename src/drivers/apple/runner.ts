// Host side of the Apple runner: builds the XCUITest bundle once per platform and source hash (a cache under
// ~/Library/Caches/pitbox, shared by every daemon on the Mac: util/cache.ts), runs it with `xcodebuild test-without-building`, and talks to it over one TCP
// connection. A simulator shares the Mac's network, so the runner's port is reached directly on 127.0.0.1.

import {spawn, type ChildProcess} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gcVersions, markInUse, withBuildLock} from '../../util/cache.ts';
import {pitboxHome} from '../../lease/lease.ts';
import {freePort, tcpOpen} from '../../util/net.ts';
import {run} from '../../util/proc.ts';
import {AppleError, type AppleDriver, type SimKind} from './driver.ts';
import {hid, hidChord} from './hid.ts';

/** Must match `runnerVersion` in runners/apple/Runner/Commands.swift. */
export const RUNNER_VERSION = 1;

export const runnerSources = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'runners', 'apple');
};

const DESTINATIONS: Record<SimKind, string> = {phone: 'iOS Simulator', foldable: 'iOS Simulator', tablet: 'iOS Simulator', tv: 'tvOS Simulator', xr: 'visionOS Simulator', watch: 'watchOS Simulator'};

/** A hash of the runner's sources: a changed runner is rebuilt without anyone bumping a number. */
export const sourceHash = (dir: string): string => {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'xcuserdata') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        h.update(path.relative(dir, p));
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 12);
};

type Built = {xctestrun: string; built: boolean; ms: number};

/** One build per platform and source hash for the daemon's life: a failed build is not retried on every call. */
const builds = new Map<string, Promise<Built>>();

/** Builds (or finds in the cache) the runner for a simulator kind; returns its .xctestrun file. */
export const buildRunner = (kind: SimKind): Promise<Built> => {
  const key = `${kind === 'tablet' || kind === 'foldable' ? 'phone' : kind}:${sourceHash(runnerSources())}`;
  let b = builds.get(key);
  if (!b) {
    b = build(kind);
    builds.set(key, b);
  }
  return b;
};

const build = async (kind: SimKind): Promise<Built> => {
  const t0 = Date.now();
  const destination = DESTINATIONS[kind];
  const src = runnerSources();
  if (!fs.existsSync(path.join(src, 'PitboxRunner.xcodeproj'))) throw new AppleError(`runner sources missing: ${src}`);
  const xcode = (await run('xcodebuild', ['-version'], {timeoutMs: 20_000})).stdout.match(/Build version (\S+)/)?.[1] ?? 'unknown';
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'pitbox', 'apple-runner');
  const version = `${sourceHash(src)}-${xcode}`;
  const dir = path.join(cache, version, destination.replace(/\s+/g, '-'));
  const find = () => {
    const products = path.join(dir, 'Build', 'Products');
    return fs.existsSync(products) ? fs.readdirSync(products).find(f => f.endsWith('.xctestrun')) : undefined;
  };
  // Marked before anything else: another daemon's GC then leaves this version alone for as long as this one runs.
  markInUse(path.join(cache, version));
  // Builds of older runner sources or another Xcode (hundreds of MB each) go once nobody uses them; another
  // daemon, of another project or pitbox version, may be running its runner from one right now.
  gcVersions(cache, version);
  // Two daemons building into one derived data folder corrupt it: the second waits and finds the build done.
  return withBuildLock(cache, version, async () => {
    const existing = find();
    if (existing) return {xctestrun: path.join(dir, 'Build', 'Products', existing), built: false, ms: Date.now() - t0};
    return buildInto(dir, src, destination, find, t0);
  });
};

const buildInto = async (dir: string, src: string, destination: string, find: () => string | undefined, t0: number): Promise<Built> => {
  fs.mkdirSync(dir, {recursive: true});
  const r = await run(
    'xcodebuild',
    ['build-for-testing', '-project', path.join(src, 'PitboxRunner.xcodeproj'), '-scheme', 'PitboxRunner', '-destination', `generic/platform=${destination}`, '-derivedDataPath', dir, '-quiet', 'CODE_SIGN_IDENTITY=-'],
    {timeoutMs: 900_000},
  );
  const file = find();
  if (r.code !== 0 || !file) {
    const errors = [...new Set(`${r.stdout}\n${r.stderr}`.split('\n').filter(l => /^\S.*error:/.test(l)).map(l => l.replace(`${src}/`, '')))];
    const why = errors.slice(0, 3).join('\n') || r.stderr.trim().split('\n').slice(-3).join('\n');
    throw new AppleError(`runner build failed for ${destination}:\n${why}`, /platform.*not installed|Unable to find a destination/i.test(r.stderr) ? `install the ${destination} runtime in Xcode › Settings › Components` : undefined);
  }
  return {xctestrun: path.join(dir, 'Build', 'Products', file), built: true, ms: Date.now() - t0};
};

type Pending = {resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout};

/** What a start without xcodebuild needs from a build: the runner app and the environment xcodebuild would give it. */
export type DirectPlan = {app: string; env: Record<string, string>};

/**
 * The runner app and its test environment from an .xctestrun (as JSON: `plutil -convert json`), with xcodebuild's
 * placeholders filled in: `__TESTROOT__` (the folder of the .xctestrun) and `__PLATFORMS__` (Xcode's platforms).
 * Undefined when the file names no test host.
 */
export const directPlan = (xctestrun: unknown, testRoot: string, developerDir: string): DirectPlan | undefined => {
  const doc = xctestrun as Record<string, {TestHostPath?: string; TestingEnvironmentVariables?: Record<string, string>}>;
  const target = doc.PitboxRunner ?? Object.entries(doc).find(([k]) => !k.startsWith('__'))?.[1];
  if (!target?.TestHostPath) return undefined;
  const fill = (v: string) => v.replaceAll('__TESTROOT__', testRoot).replaceAll('__PLATFORMS__', path.join(developerDir, 'Platforms'));
  const env = Object.fromEntries(Object.entries(target.TestingEnvironmentVariables ?? {}).map(([k, v]) => [k, fill(String(v))]));
  return {app: fill(target.TestHostPath), env};
};

/**
 * Whether the runner can start without xcodebuild, launched by simctl like any app: XCTest then finds the test
 * bundle inside the runner app on its own. An iOS or iPadOS simulator from iOS 17 on; the other platforms keep
 * xcodebuild.
 */
export const startsDirect = (sim: {kind: SimKind; os: string}): boolean => {
  if (sim.kind !== 'phone' && sim.kind !== 'tablet' && sim.kind !== 'foldable') return false;
  const m = /^iOS (\d+)/.exec(sim.os);
  return !!m && Number(m[1]) >= 17;
};

/** Builds whose start without xcodebuild failed once: the daemon starts them with xcodebuild from then on. */
const directFailed = new Set<string>();

/** Whether two installs of the runner app hold the same code: its executable and its test bundle's. */
export const sameRunner = (a: string, b: string): boolean => {
  const files = (app: string) => {
    const name = path.basename(app, '.app');
    return [path.join(app, name), path.join(app, 'PlugIns', 'PitboxRunner.xctest', 'PitboxRunner'), path.join(app, 'Info.plist')];
  };
  const [x, y] = [files(a), files(b)];
  try {
    return x.every((f, i) => {
      const [p, q] = [fs.statSync(f), fs.statSync(y[i]!)];
      return p.size === q.size && fs.readFileSync(f).equals(fs.readFileSync(y[i]!));
    });
  } catch {
    return false;
  }
};

let developerDir: Promise<string> | undefined;

/**
 * A runner a stopping daemon left running for the next one on the simulator: its port and the build it runs. Kept
 * in a file per simulator under PITBOX_HOME, so the next daemon, of any project on the Mac, finds it.
 */
export type KeptRunner = {port: number; xctestrun: string; version: number; at: number};

export const keptRunnerFile = (udid: string) => path.join(pitboxHome(), 'runners', `${udid}.json`);

/** The runner left on the simulator, taken: the record goes whether or not the runner is still there. */
export const takeKeptRunner = (udid: string): KeptRunner | undefined => {
  const file = keptRunnerFile(udid);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  fs.rmSync(file, {force: true});
  try {
    const kept = JSON.parse(text) as KeptRunner;
    return Number.isInteger(kept.port) && typeof kept.xctestrun === 'string' ? kept : undefined;
  } catch {
    return undefined;
  }
};

export const keepRunner = (udid: string, kept: KeptRunner) => {
  const file = keptRunnerFile(udid);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(kept));
  fs.renameSync(tmp, file);
};

/**
 * What to tell the agent about a runner from its `info`. On visionOS XCUITest waits for the app's animations to end
 * before and after every event, and an open system menu never stops animating: the runner turns that wait off
 * through XCUITest's own (not public) switch. A runner whose XCUITest lost the switch says so, and every press into
 * a menu would otherwise time out a minute later with nothing to explain it.
 */
export const runnerNotice = (info: {platform?: string; animationWaitOff?: boolean}): string | undefined =>
  info.platform === 'visionos' && info.animationWaitOff === false
    ? "this Xcode's XCUITest no longer lets pitbox skip its wait for animations: a press into a system menu (or anything that keeps animating) waits a minute and can time out — use the menu's effect through the app, or an older Xcode"
    : undefined;

/** The runner app's bundle id on the simulator (`PRODUCT_BUNDLE_IDENTIFIER` of the UI test target + `.xctrunner`). */
export const RUNNER_BUNDLE_ID = 'dev.pitbox.runner.xctrunner';

/**
 * Clears what an earlier runner left on the simulator before a new one starts. `xcodebuild test-without-building`
 * installs the runner app again and launches it; while a runner of an earlier xcodebuild still runs there (one
 * stopped a moment ago and still on its way out, one left by a daemon that is gone), the install's termination of
 * the old process takes the new one with it, and xcodebuild reports "Test crashed with signal kill before
 * establishing connection" — a start that fails once and works on the next call.
 */
export const clearStaleRunner = async (driver: Pick<AppleDriver, 'stop'>, udid: string, child?: ChildProcess): Promise<void> => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(r => child.once('exit', () => r()));
    child.kill();
    // xcodebuild ends its runner on SIGTERM; one that hangs on to it is killed outright.
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  await driver.stop(udid, RUNNER_BUNDLE_ID).catch(() => undefined);
};

/** Keys whose meaning the runner keeps on visionOS: home (the Digital Crown), enter and del into a text field. */
const RUNNER_KEYS = new Set([3, 66, 67]);

/**
 * The simulator's screen as a downscaled JPEG, taken by simctl from outside the runner (which may be busy holding a
 * finger down). On visionOS this is the whole view a person sees, the room with every window in it, not one window.
 */
export const simulatorShot = async (driver: Pick<AppleDriver, 'screenshot'>, udid: string, file: string, maxSide = 1280): Promise<string> => {
  const png = `${file}.png`;
  await driver.screenshot(udid, png);
  const r = await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', String(maxSide), png, '--out', file], {timeoutMs: 30_000});
  fs.rmSync(png, {force: true});
  if (r.code !== 0) throw new AppleError(`screenshot conversion failed: ${r.stderr.trim().split('\n').pop()}`);
  return file;
};

export class AppleRunner {
  readonly udid: string;
  /** XCUITest keeps no finger down between calls: a held swipe is held by the runner and the image taken here. */
  readonly holdsSwipes = true;
  /** `idle` compares two trees (Commands.swift): quiet means the screen stood still. */
  readonly settlesByTrees = true;
  /** On iOS `text` waits for the field to take keyboard focus itself (`DeviceUi.fill`). */
  get waitsForFocus() {
    return this.#kind === 'phone' || this.#kind === 'tablet' || this.#kind === 'foldable';
  }
  /** Told once with the next action's answer (`DeviceUi`). */
  readonly notices: string[] = [];
  /** The app the runner reads and drives when it is in front (the system shell otherwise). */
  bundleId?: string;
  readonly #driver: AppleDriver;
  #child?: ChildProcess;
  #kind?: SimKind;
  #socket?: net.Socket;
  #buffer = '';
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #starting?: Promise<void>;
  /** Whether a command has come back since the runner started. */
  #answered = false;
  /** Whether the running runner was launched by simctl (no xcodebuild to end: the app is terminated instead). */
  #direct = false;
  /** How the last start went, for the agent-facing timing and the tests. */
  lastStart?: {how: 'simctl' | 'xcodebuild' | 'kept'; ms: number; fallback?: string};
  /** The build the running runner came from, for the record a stopping daemon leaves. */
  #xctestrun?: string;
  #port?: number;

  constructor(driver: AppleDriver, udid: string, bundleId?: string) {
    this.#driver = driver;
    this.udid = udid;
    this.bundleId = bundleId;
  }

  get alive() {
    return !!this.#socket && !this.#socket.destroyed;
  }

  start(): Promise<void> {
    if (this.alive) return Promise.resolve();
    this.#starting ??= this.#start().finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  async #start() {
    const old = this.#child;
    this.#teardown(false);
    this.#answered = false;
    const sim = (await this.#driver.simulators()).find(s => s.udid === this.udid);
    if (this.#stopped) throw new AppleError(`runner for ${this.udid} was stopped while it started`);
    if (!sim || sim.state !== 'Booted') throw new AppleError(`simulator ${this.udid} is not booted`);
    this.#kind = sim.kind;
    const {xctestrun} = await buildRunner(sim.kind);
    // A runner the last daemon left here, of this build and still answering, is taken over instead of started.
    const kept = takeKeptRunner(this.udid);
    if (kept && !old && kept.xctestrun === xctestrun && kept.version === RUNNER_VERSION && (await tcpOpen(kept.port, '127.0.0.1', 500))) {
      const t0 = Date.now();
      await this.#connect(kept.port).catch(() => undefined);
      if (this.alive && (await this.call<{version?: number}>('ping', {}, 3000).catch(() => ({version: undefined}))).version === RUNNER_VERSION) {
        this.#direct = true;
        this.#xctestrun = xctestrun;
        this.#port = kept.port;
        this.lastStart = {how: 'kept', ms: Date.now() - t0};
        return this.#afterStart();
      }
      this.#teardown(false);
    }
    await clearStaleRunner(this.#driver, this.udid, old);
    const port = await freePort();
    // xcodebuild boots a shut-down destination: a runner stopped meanwhile (the simulator given back) never starts.
    if (this.#stopped) throw new AppleError(`runner for ${this.udid} was stopped while it started`);
    const t0 = Date.now();
    let fallback: string | undefined;
    // Without xcodebuild the runner answers in under half the time: no xcodebuild start, no install of the
    // runner on every start, no launch held while Xcode's tools attach to it. Any failure falls back to xcodebuild.
    if (AppleRunner.direct && startsDirect(sim) && !directFailed.has(`${xctestrun}|${sim.runtime}`)) {
      fallback = await this.#startDirect(xctestrun, port).then(
        () => undefined,
        (e: Error) => e.message,
      );
      if (fallback === undefined) {
        this.lastStart = {how: 'simctl', ms: Date.now() - t0};
        return this.#afterStart();
      }
      if (this.#stopped) throw new AppleError(`runner for ${this.udid} was stopped while it started`);
      directFailed.add(`${xctestrun}|${sim.runtime}`);
      this.#teardown();
      await clearStaleRunner(this.#driver, this.udid);
    }
    const child = spawn('xcodebuild', ['test-without-building', '-xctestrun', xctestrun, '-destination', `id=${this.udid}`, '-only-testing:PitboxRunner/RunnerTests/testServe'], {
      env: {...process.env, TEST_RUNNER_PITBOX_PORT: String(port)},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#child = child;
    let output = '';
    const keep = (d: Buffer) => {
      output = (output + d.toString()).slice(-4000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let exited = false;
    child.on('exit', () => {
      exited = true;
      // An xcodebuild that ends after a newer one took its place leaves the newer connection alone.
      if (this.#child === child) this.#teardown();
    });
    const deadline = Date.now() + 180_000;
    while (!this.alive) {
      if (this.#stopped) {
        this.#teardown();
        throw new AppleError(`runner for ${this.udid} was stopped while it started`);
      }
      if (exited) throw new AppleError(`runner exited before it answered: ${output.trim().split('\n').filter(l => /error|fail/i.test(l)).slice(-3).join(' ') || output.trim().split('\n').slice(-2).join(' ')}`);
      if (Date.now() > deadline) {
        this.#teardown();
        throw new AppleError('runner did not start in 180s', output.trim().split('\n').slice(-3).join(' '));
      }
      await this.#connect(port).catch(() => new Promise(r => setTimeout(r, 400)));
    }
    this.lastStart = {how: 'xcodebuild', ms: Date.now() - t0, ...(fallback ? {fallback} : {})};
    return this.#afterStart();
  }

  /** Starts with the runner, without xcodebuild: one start costs the dispatch of xcodebuild's test session. */
  static direct = process.env.PITBOX_RUNNER_XCODEBUILD !== '1';

  /**
   * Launches the runner app with simctl and the environment xcodebuild would give it; installs it first when the
   * simulator has none or another build of it. Throws when it does not answer, so xcodebuild takes over.
   */
  async #startDirect(xctestrun: string, port: number) {
    developerDir ??= run('xcode-select', ['-p'], {timeoutMs: 10_000}).then(r => r.stdout.trim());
    const conv = await run('plutil', ['-convert', 'json', '-o', '-', xctestrun], {timeoutMs: 10_000});
    const plan = conv.code === 0 ? directPlan(JSON.parse(conv.stdout), path.dirname(xctestrun), await developerDir) : undefined;
    if (!plan || !fs.existsSync(plan.app)) throw new AppleError('no runner app in the build');
    const installed = await this.#driver.appBundle(this.udid, RUNNER_BUNDLE_ID);
    if (!installed || !sameRunner(installed, plan.app)) await this.#driver.install(this.udid, plan.app);
    if (this.#stopped) throw new AppleError(`runner for ${this.udid} was stopped while it started`);
    const env: NodeJS.ProcessEnv = {...process.env, SIMCTL_CHILD_PITBOX_PORT: String(port)};
    for (const [k, v] of Object.entries(plan.env)) env[`SIMCTL_CHILD_${k}`] = v;
    const r = await run(this.#driver.xcrun, ['simctl', 'launch', '--terminate-running-process', this.udid, RUNNER_BUNDLE_ID], {env, timeoutMs: 60_000});
    if (r.code !== 0) throw new AppleError(`simctl launch failed: ${r.stderr.trim().split('\n').pop()}`);
    this.#direct = true;
    this.#xctestrun = xctestrun;
    this.#port = port;
    // The app is a process of the Mac: one that dies at launch (a missing framework) is seen gone at once.
    const pid = Number(/:\s*(\d+)/.exec(r.stdout)?.[1]);
    const gone = () => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'ESRCH';
      }
    };
    const deadline = Date.now() + AppleRunner.directTimeoutMs;
    while (!this.alive) {
      if (this.#stopped) throw new AppleError(`runner for ${this.udid} was stopped while it started`);
      if (gone()) throw new AppleError('the runner app exited before it answered');
      if (Date.now() > deadline) throw new AppleError(`the runner app did not answer in ${AppleRunner.directTimeoutMs / 1000}s`);
      await this.#connect(port).catch(() => new Promise(res => setTimeout(res, 100)));
    }
  }

  /** How long a runner launched by simctl gets to answer before xcodebuild starts it instead. */
  static directTimeoutMs = 30_000;

  async #afterStart() {
    const notice = runnerNotice(await this.call<{platform?: string; animationWaitOff?: boolean}>('info', {}, 30_000).catch(() => ({})));
    if (notice) this.notices.push(notice);
    if (this.bundleId) await this.call('activate', {}, 30_000).catch(() => undefined);
  }

  #connect(port: number) {
    return new Promise<void>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1');
      s.setNoDelay(true);
      s.once('connect', () => {
        this.#socket = s;
        s.on('close', () => this.#fail(new AppleError('runner connection closed')));
        resolve();
      });
      s.once('error', e => {
        s.destroy();
        if (this.#socket === s) this.#fail(e);
        reject(e);
      });
      s.on('data', (d: Buffer) => this.#onData(d));
    });
  }

  #onData(d: Buffer) {
    this.#buffer += d.toString('utf8');
    let k: number;
    while ((k = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, k);
      this.#buffer = this.#buffer.slice(k + 1);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.#pending.get(Number(msg.id));
      if (!p) continue;
      this.#pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new AppleError(`runner: ${msg.error}`));
    }
  }

  #fail(e: Error) {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.#pending.clear();
    this.#socket = undefined;
  }

  /** Drops the connection and, unless the caller waits for it itself (`clearStaleRunner`), ends xcodebuild. */
  #teardown(kill = true) {
    this.#socket?.destroy();
    this.#socket = undefined;
    if (kill && this.#child && this.#child.exitCode === null) this.#child.kill();
    this.#child = undefined;
    // A runner launched by simctl has no xcodebuild to take it along: the app itself is ended.
    if (kill && this.#direct) void this.#driver.stop(this.udid, RUNNER_BUNDLE_ID).catch(() => undefined);
    this.#direct = false;
  }

  async #simKind(): Promise<SimKind | undefined> {
    this.#kind ??= (await this.#driver.simulators()).find(s => s.udid === this.udid)?.kind;
    return this.#kind;
  }

  async call<T extends Record<string, unknown> = Record<string, unknown>>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    // A key on a headset goes in as the simulator's hardware keyboard, which the GameController framework (where a
    // visionOS app reads keys for its 3D content) and UIKit both see; XCUITest's typeKey reaches UIKit only.
    if (cmd === 'key' && !RUNNER_KEYS.has(Number(args.code)) && (await this.#simKind()) === 'xr') {
      const chord = hidChord(Number(args.code), Number(args.meta ?? 0));
      if (chord) {
        await hid(this.udid, ['key', chord]);
        return {} as T;
      }
    }
    if (cmd === 'swipe' && Number(args.hold) > 0 && typeof args.shot === 'string') {
      const {shot, ...rest} = args;
      await this.start();
      // The runner first finds what is under the start (a snapshot, up to half a second on visionOS), presses, drags
      // at the swipe's velocity and holds: the image is taken about halfway through the hold.
      const at = 500 + Number(args.duration ?? 300) + Number(args.hold) / 2;
      const image = new Promise<string | undefined>(r => setTimeout(r, at)).then(() => simulatorShot(this.#driver, this.udid, shot).catch(() => undefined));
      const [done, file] = await Promise.all([this.call<T>(cmd, rest, Math.max(timeoutMs, at + Number(args.hold) + 15_000)), image]);
      return (file ? {...done, shot: file} : done) as T;
    }
    await this.start();
    const id = this.#nextId++;
    const socket = this.#socket;
    if (!socket) throw new AppleError('runner not connected');
    // The first call into an app attaches XCUITest to it, which takes seconds — on visionOS, up to a minute.
    const limit = Math.max(timeoutMs, this.#answered ? 30_000 : 120_000);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppleError(`runner: ${cmd} timed out after ${limit} ms`));
      }, limit);
      this.#pending.set(id, {
        resolve: v => {
          this.#answered = true;
          resolve(v as T);
        },
        reject,
        timer,
      });
      socket.write(`${JSON.stringify({id, cmd, app: this.bundleId, ...args})}\n`);
    });
  }

  /** Given back: a start still under way (one begun at boot) ends instead of booting the simulator again. */
  #stopped = false;

  async stop() {
    this.#stopped = true;
    if (this.alive) await this.call('shutdown', {}, 3000).catch(() => undefined);
    this.#teardown();
  }

  /**
   * Leaves a runner launched by simctl running for the next daemon on the simulator (a restart, a version swap)
   * and lets go of it; one started by xcodebuild ends with this daemon as before.
   */
  async detach() {
    if (!this.alive || !this.#direct || !this.#xctestrun || !this.#port || this.#pending.size) return this.stop();
    this.#stopped = true;
    keepRunner(this.udid, {port: this.#port, xctestrun: this.#xctestrun, version: RUNNER_VERSION, at: Date.now()});
    this.#direct = false;
    this.#teardown(false);
  }
}
