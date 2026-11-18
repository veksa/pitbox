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
import {freePort} from '../../util/net.ts';
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
    await clearStaleRunner(this.#driver, this.udid, old);
    const port = await freePort();
    // xcodebuild boots a shut-down destination: a runner stopped meanwhile (the simulator given back) never starts.
    if (this.#stopped) throw new AppleError(`runner for ${this.udid} was stopped while it started`);
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
}
