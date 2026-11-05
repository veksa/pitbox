// A native app on this Mac as a pitbox device (`mac:<name>`): the Mac runner (runners/apple/Mac), a small Swift
// tool built with swiftc on first use and cached per source hash and Xcode, reads the app through the Accessibility
// API and drives it with events posted to the app. It answers the Apple runner's protocol (tree, tap, text, key,
// swipe, idle, screenshot, fingerprint, frames, focus, mouse) as JSON lines over its stdin and stdout.
//
// The daemon starts it as a child, so macOS asks the app that started pitbox (a terminal, an editor) for its
// Accessibility and Screen Recording permissions; `doctor` names that app when one is missing.

import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {run} from '../../util/proc.ts';
import {tailLines} from '../../util/text.ts';
import {runnerSources, sourceHash} from '../apple/runner.ts';

/** Must match `runnerVersion` in runners/apple/Mac/main.swift. */
export const MAC_RUNNER_VERSION = 1;

export type MacAppConfig = {
  /** The app's bundle id: `com.example.app`. */
  app: string;
  /** The built app to open (`./build/MyApp.app`); without it `open` finds the app by its bundle id. */
  path?: string;
  /** The window snapshots and input are about: a title or part of one, `#2`, or `front` (the default). */
  window?: string;
};

export class MacError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(hint ? `${message}\nhint: ${hint}` : message);
    this.hint = hint;
  }
}

/** The Mac app a device name is for: `mac:<name>`, or `mac` when the config has one. Undefined for other devices. */
export const macDevice = (device: string | undefined, apps: string[]): string | undefined => {
  if (!device) return undefined;
  const m = /^mac(?::(.+))?$/.exec(device);
  if (!m) return undefined;
  if (!apps.length) throw new MacError('no Mac apps in the config', "add mac: {<name>: {app: 'com.example.app'}}");
  const name = m[1] ?? (apps.length === 1 ? apps[0] : undefined);
  if (!name || !apps.includes(name)) throw new MacError(`no Mac app "${m[1] ?? ''}"`, `known: ${apps.map(a => `mac:${a}`).join(', ')}`);
  return name;
};

/** Android key codes (what flows and `key` speak) as the Mac's key codes: places on the keyboard, not characters. */
const VK: Record<number, number> = {
  4: 53, // back: escape closes a sheet, a menu, a popover
  23: 36,
  66: 36,
  67: 51,
  112: 117,
  61: 48,
  62: 49,
  111: 53,
  19: 126,
  20: 125,
  21: 123,
  22: 124,
  122: 115,
  123: 119,
  92: 116,
  93: 121,
  55: 43,
  56: 47,
  69: 27,
  70: 24,
  71: 33,
  72: 30,
  73: 42,
  74: 41,
  75: 39,
  76: 44,
  68: 50,
};
const LETTERS = [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6];
const DIGITS = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
const FKEYS = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];

/** An Android key code and meta flags as a Mac key code and CGEventFlags. */
export const macKey = (code: number, meta = 0): {vk: number; flags: number} => {
  let vk: number | undefined;
  if (code >= 29 && code <= 54) vk = LETTERS[code - 29];
  else if (code >= 7 && code <= 16) vk = DIGITS[code - 7];
  else if (code >= 131 && code <= 142) vk = FKEYS[code - 131];
  else vk = VK[code];
  if (vk === undefined) throw new MacError(`key code ${code} has no key on a Mac keyboard`, 'enter, del, tab, space, escape, back (escape), arrows, page_up/down, move_home/end, letters, digits, F1–F12, with ctrl+ shift+ alt+ meta+ (⌘) in front');
  let flags = 0;
  if (meta & 0x41) flags |= 0x20000; // shift
  if (meta & 0x3000) flags |= 0x40000; // control
  if (meta & 0x12) flags |= 0x80000; // option
  if (meta & 0x30000) flags |= 0x100000; // command
  return {vk, flags};
};

let built: Promise<string> | undefined;

/** The runner's path, built when this source and Xcode have none yet. */
export const macRunnerBinary = (): Promise<string> => {
  built ??= buildRunner().catch(e => {
    built = undefined;
    throw e;
  });
  return built;
};

const buildRunner = async (): Promise<string> => {
  if (process.platform !== 'darwin') throw new MacError('Mac apps are driven on a Mac');
  const src = path.join(runnerSources(), 'Mac');
  const files = fs.existsSync(src) ? fs.readdirSync(src).filter(f => f.endsWith('.swift')).sort() : [];
  if (!files.length) throw new MacError(`Mac runner sources missing: ${src}`);
  const xcode = (await run('xcodebuild', ['-version'], {timeoutMs: 20_000})).stdout.match(/Build version (\S+)/)?.[1] ?? 'unknown';
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'pitbox', 'mac-runner');
  const version = `${sourceHash(src)}-${xcode}`;
  const bin = path.join(cache, version, 'pitbox-mac');
  if (fs.existsSync(bin)) return bin;
  if (fs.existsSync(cache)) for (const v of fs.readdirSync(cache)) if (v !== version) fs.rmSync(path.join(cache, v), {recursive: true, force: true});
  fs.mkdirSync(path.dirname(bin), {recursive: true});
  const r = await run('xcrun', ['swiftc', '-O', ...files.map(f => path.join(src, f)), '-o', bin], {timeoutMs: 300_000});
  if (r.code !== 0 || !fs.existsSync(bin)) {
    const why = r.stderr.trim().split('\n').filter(l => /error:/.test(l)).slice(0, 2).join(' ') || r.stderr.trim().split('\n').pop();
    throw new MacError(`Mac runner build failed: ${why}`, /xcrun|developer tools/i.test(r.stderr) ? 'install Xcode or the command line tools (xcode-select --install)' : undefined);
  }
  return bin;
};

type Pending = {resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout};

export type MacPermissions = {accessibility: boolean; screen: boolean; host: string};

export class MacRunner {
  readonly name: string;
  readonly cfg: MacAppConfig;
  /** The window everything is about: a title, `#n`, or undefined for the one in front. */
  window?: string;
  readonly #root: string;
  #child?: ChildProcess;
  #buffer = '';
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #starting?: Promise<void>;

  readonly #binary: () => Promise<string>;

  /** `binary` stands in for the built runner (tests). */
  constructor(name: string, cfg: MacAppConfig, root: string, binary: () => Promise<string> = macRunnerBinary) {
    this.name = name;
    this.cfg = cfg;
    this.#root = root;
    this.#binary = binary;
    this.window = cfg.window && cfg.window !== 'front' ? cfg.window : undefined;
  }

  get alive() {
    return !!this.#child && this.#child.exitCode === null && !this.#child.killed;
  }

  start(): Promise<void> {
    if (this.alive) return Promise.resolve();
    this.#starting ??= this.#start().finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  async #start() {
    const bin = await this.#binary();
    const child = spawn(bin, [], {stdio: ['pipe', 'pipe', 'pipe']});
    this.#child = child;
    this.#buffer = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => this.#onData(d));
    child.stderr!.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on('exit', code => {
      if (this.#child === child) this.#child = undefined;
      this.#fail(new MacError(`the Mac runner exited (${code ?? 'killed'})${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
    });
    child.stdin!.on('error', () => undefined);
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
      else p.reject(new MacError(String(msg.error)));
    }
  }

  #fail(e: Error) {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.#pending.clear();
  }

  async call<T extends Record<string, unknown> = Record<string, unknown>>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    let extra = args;
    if (cmd === 'key') extra = {...args, ...macKey(Number(args.code), Number(args.meta ?? 0))};
    await this.start();
    const child = this.#child;
    if (!child?.stdin) throw new MacError('the Mac runner is not running');
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new MacError(`Mac runner: ${cmd} timed out after ${timeoutMs} ms`, 'the app may be hung: `app action=stop`, then open it again'));
      }, Math.max(timeoutMs, 5000));
      this.#pending.set(id, {resolve: v => resolve(v as T), reject, timer});
      child.stdin!.write(`${JSON.stringify({id, cmd, app: this.cfg.app, ...extra, ...(this.window ? {win: this.window} : {})})}\n`);
    });
  }

  permissions(): Promise<MacPermissions> {
    return this.call<MacPermissions>('permissions');
  }

  /** Opens the app (its `path`, else by bundle id) or a link, and waits until it is in front with a window. */
  async open(target?: string, relaunch = false): Promise<{target: string; totalMs: number; pid?: number}> {
    const t0 = Date.now();
    if (relaunch) await this.call('terminate', {}, 15_000);
    const appPath = this.cfg.path ? path.resolve(this.#root, this.cfg.path) : undefined;
    if (appPath && !fs.existsSync(appPath)) throw new MacError(`no app at ${appPath}`, 'build it first, or drop mac.<name>.path to open the installed app by its bundle id');
    const link = target && /^[a-z][\w+.-]*:\/\//i.test(target) ? target : undefined;
    const args = link ? [link] : appPath ? [appPath] : ['-b', this.cfg.app];
    const r = await run('open', args, {timeoutMs: 60_000});
    if (r.code !== 0) throw new MacError(`open failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`, /Unable to find application/i.test(r.stderr) ? 'set mac.<name>.path to the built .app' : undefined);
    const front = await this.call<{foreground: boolean}>('foreground', {timeout: 15_000}, 20_000).catch(() => ({foreground: false}));
    const pid = (await this.call<{pid?: number}>('pid').catch(() => ({pid: undefined}))).pid;
    if (!front.foreground && pid === undefined) throw new MacError(`${this.cfg.app} did not start`, 'see `app action=logs`');
    return {target: link ?? appPath ?? this.cfg.app, totalMs: Date.now() - t0, ...(pid ? {pid} : {})};
  }

  /** Quits the app (and kills it when it does not quit in a few seconds). */
  async stopApp(): Promise<{running: boolean; forced?: boolean}> {
    const r = await this.call<{running: boolean; forced?: boolean}>('terminate', {}, 15_000);
    return {running: r.running, ...(r.forced ? {forced: true} : {})};
  }

  async windows(): Promise<{title: string; size?: number[]; main?: boolean; minimized?: boolean}[]> {
    return (await this.call<{windows: {title: string; size?: number[]; main?: boolean; minimized?: boolean}[]}>('windows')).windows;
  }

  /** The app's lines in the Mac's unified log. */
  async logs(opts: {lines?: number; grep?: string; level?: string; since?: string} = {}): Promise<string[]> {
    const pid = (await this.call<{pid?: number}>('pid').catch(() => ({pid: undefined}))).pid;
    const exe = this.cfg.path ? path.basename(this.cfg.path).replace(/\.app\/?$/, '') : undefined;
    const preds = [pid ? `processIdentifier == ${pid}` : exe ? `process == "${exe.replace(/"/g, '\\"')}"` : `subsystem == "${this.cfg.app}"`];
    const level = opts.level?.toLowerCase();
    const args = ['show', '--style', 'compact', '--last', opts.since ?? '5m'];
    if (level === 'e' || level === 'error') preds.push('messageType >= error');
    else if (level === 'w' || level === 'warn' || level === 'f' || level === 'fault') preds.push('messageType >= fault');
    else if (level === 'd' || level === 'debug' || level === 'v') args.push('--debug', '--info');
    else args.push('--info');
    args.push('--predicate', preds.join(' AND '));
    const r = await run('log', args, {timeoutMs: 30_000});
    const body = r.stdout.split('\n').filter(l => !/^Timestamp\s+Ty/.test(l)).join('\n');
    return tailLines(body, opts.lines ?? 50, opts.grep);
  }

  async stop(): Promise<void> {
    if (this.alive) await this.call('shutdown', {}, 3000).catch(() => undefined);
    this.#child?.kill();
    this.#child = undefined;
  }
}
