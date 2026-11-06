// The engine the daemon serves: config, stand, Android driver, doctor and docs behind one method table.
// The CLI and the MCP server call these methods over the daemon's RPC.

import {WebRunner} from '../drivers/web/runner.ts';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig, resolveFrom, type LoadedConfig} from '../config/load.ts';
import {exposedPorts, type ServiceConfig} from '../config/schema.ts';
import {DEVSERVER, DevServer} from '../devserver/devserver.ts';
import {AndroidDriver, type NetworkProfile} from '../drivers/android/driver.ts';
import {XR_PANEL, xrView} from '../drivers/android/formfactor.ts';
import {pairByQr, pairingCode, parseCodePairing} from '../drivers/android/wifi.ts';
import {AppleDriver, isAppleBundle, pickSimulator} from '../drivers/apple/driver.ts';
import {AppleRunner} from '../drivers/apple/runner.ts';
import {AppleCrashWatcher} from '../drivers/apple/crashes.ts';
import {MacRunner, macDevice} from '../drivers/mac/runner.ts';
import {RemoteApple, RemoteAppleCrashes, RemoteAppleRunner, type AppleDevices} from '../remote/appleRemote.ts';
import {lineRange, grep, readDoc, section, toc} from '../docs/docs.ts';
import {loadProjectRules, runDoctor} from '../doctor/run.ts';
import {ActorManager} from '../stand/actors.ts';
import {LlmMock} from '../stand/llmMock.ts';
import {ServiceManager, type ServiceState} from '../stand/services.ts';
import {describeTool, runTool} from '../stand/tools.ts';
import {type DeviceSnapshot, emulatorSnapshot, StateStore} from '../stand/states.ts';
import {runFlow, type FlowHost} from '../flows/run.ts';
import type {PerfData} from '../flows/budget.ts';
import {formatResult} from '../format.ts';
import {fillRoute} from '../flows/flow.ts';
import {DeviceUi, type UiHooks} from '../ui/device.ts';
import {AndroidRunner} from '../drivers/android/runner.ts';
import {CrashWatcher} from '../drivers/android/events.ts';
import {lanAddress} from '../util/lan.ts';
import {httpAlive} from '../util/net.ts';
import {run} from '../util/proc.ts';

type Params = Record<string, unknown>;

const str = (p: Params, k: string): string | undefined => (p[k] === undefined || p[k] === null ? undefined : String(p[k]));
const req = (p: Params, k: string): string => {
  const v = str(p, k);
  if (!v) throw new Error(`missing parameter: ${k}`);
  return v;
};
const num = (p: Params, k: string): number | undefined => (p[k] === undefined ? undefined : Number(p[k]));
const bool = (p: Params, k: string): boolean | undefined => (p[k] === undefined ? undefined : p[k] === true || p[k] === 'true' || p[k] === '1');
const list = (p: Params, k: string): string[] => {
  const v = p[k];
  if (v === undefined) return [];
  return Array.isArray(v) ? v.map(String) : String(v).split(/[\s,]+/).filter(Boolean);
};

/** Machine-wide pitbox state, shared by every project. */
const machineRelayFile = () => path.join(os.homedir(), '.pitbox', 'relay-avds.json');

/** What an Apple simulator cannot do of the Android-only form factor commands, and why. */
const APPLE_HAS_NO = {
  posture: 'posture is for Android foldables here: a foldable iPhone folds through its own path',
  rotate: 'rotate is for Android here',
  xr: 'xr is for Android XR emulators: a visionOS simulator takes no head pose, surroundings or panel controls from tools — its view moves only in the Simulator window',
  car: 'car is for Android Automotive: simctl has no CarPlay device to drive',
  wear: 'wear is for Wear OS: on an Apple Watch use rotary for the crown',
  window: 'window is for Android: Apple simulators have no desktop windows',
} as const;

export class Engine {
  #loaded: LoadedConfig;
  #mtime: number;
  readonly services: ServiceManager;
  readonly actors: ActorManager;
  #mock?: LlmMock;
  #android?: AndroidDriver | null;
  #apple?: AppleDevices | null;
  #appleKey = '';
  /** Serials whose port forwards were applied since they came online. */
  readonly #forwarded = new Set<string>();
  #watchTimer?: NodeJS.Timeout;
  #lastForwardCheck = 0;
  #dev?: DevServer;
  readonly #uis = new Map<string, DeviceUi>();
  /** A QR pairing in progress: the phone is found, paired and connected in the background. */
  #pairing?: {name: string; file: string; startedAt: number; result?: {serial?: string; error?: string}; done: Promise<void>};
  /** The trace id stamped on the requests of the last action (W3C `traceparent`). */
  #lastTrace?: {id: string; at: number};
  /** Devices with a platform trace running for the current perf window. */
  readonly #tracing = new Set<string>();

  #states(): StateStore {
    return new StateStore({root: this.#loaded.root, stateDir: this.#loaded.stateDir, shell: this.config.shell}, this.config.states);
  }

  /** An emulator to snapshot, or none when only the backend is saved. */
  /** The device side of a named state: an emulator snapshot, or a copy of the app's data on a simulator. */
  async #stateDevice(device?: string): Promise<{snap?: DeviceSnapshot; serial?: string}> {
    const a = this.android;
    const online = a ? (await a.devices().catch(() => [])).filter(d => d.state === 'device') : [];
    const sims = this.apple ? await this.apple.booted().catch(() => []) : [];
    const sim = device ? sims.find(s => s.udid === device || s.name === device) : !online.length && sims.length === 1 ? sims[0] : undefined;
    if (sim) {
      const s = this.apple!;
      const bundleId = this.config.app?.apple;
      if (!bundleId) throw new Error('a simulator state copies the app\'s data: set app.apple in the config');
      // The copy stops the app; a running one is launched again after it, as an emulator snapshot leaves it,
      // or the next call finds no app at all.
      const save = async (n: string) => {
        if ((await s.appStateSave(sim.udid, bundleId, n)).wasRunning) await this.methods.open({device: sim.udid});
      };
      return {snap: {id: sim.udid, label: sim.name, kind: 'app-data', save, load: n => s.appStateRestore(sim.udid, bundleId, n), remove: n => s.appStateDelete(sim.udid, bundleId, n)}};
    }
    if (!a || (!online.length && !device)) return {};
    const serial = await a.resolve(device);
    if (!serial.startsWith('emulator-')) throw new Error('device snapshots need an emulator');
    return {serial, snap: emulatorSnapshot(a, serial, online.find(d => d.serial === serial)?.avd)};
  }

  /** After a snapshot load the device's runner and forwards belong to a past moment: start them again. */
  async #afterRestore(serial: string) {
    const ui = this.#uis.get(serial);
    this.#uis.delete(serial);
    await ui?.stop().catch(() => undefined);
    this.#forwarded.delete(serial);
    await this.ensureForwards(true).catch(() => undefined);
  }
  #devKey = '';

  private constructor(loaded: LoadedConfig) {
    this.#loaded = loaded;
    this.#mtime = fs.statSync(loaded.file).mtimeMs;
    const ctx = {root: loaded.root, stateDir: loaded.stateDir, shell: loaded.config.shell};
    this.#syncDev();
    this.services = new ServiceManager(ctx, this.#allServices());
    this.actors = new ActorManager(ctx, loaded.config.actors ?? {});
  }

  static async create(configFile?: string, cwd?: string) {
    return new Engine(await loadConfig({file: configFile, cwd}));
  }

  get loaded() {
    return this.#loaded;
  }

  get config() {
    return this.#loaded.config;
  }

  /** Picks up config edits without restarting the daemon. */
  async refresh() {
    const m = fs.statSync(this.#loaded.file).mtimeMs;
    if (m === this.#mtime) return false;
    this.#loaded = await loadConfig({file: this.#loaded.file});
    this.#mtime = m;
    await this.#syncDev();
    this.services.setServices(this.#allServices());
    this.actors.setActors(this.config.actors ?? {});
    return true;
  }

  get dev(): DevServer | undefined {
    return this.#dev;
  }

  /** Creates (or recreates, when its config changed) the dev server from the config. */
  async #syncDev() {
    const cfg = this.config.devserver;
    const key = JSON.stringify(cfg ?? null);
    if (key === this.#devKey) return;
    this.#devKey = key;
    const old = this.#dev;
    this.#dev = cfg ? new DevServer(cfg, this.#loaded.root, this.#loaded.stateDir) : undefined;
    await old?.stop();
  }

  #allServices(): Record<string, ServiceConfig> {
    const services = {...(this.config.services ?? {})};
    if (this.#dev) services[DEVSERVER] = this.#dev.service();
    return services;
  }

  /** The dev server's port taken before its bundler starts: the failed state to report when it cannot be. */
  async #claimDevPort(): Promise<ServiceState | undefined> {
    const dev = this.#dev;
    if (!dev) return undefined;
    const reason = await dev.claim();
    return reason ? {name: DEVSERVER, status: 'failed', detail: reason, expose: [dev.port]} : undefined;
  }

  /** The services to bring up without the dev server: the named ones, or every autostart one. */
  #withoutDev(names: string[]): string[] {
    const all = this.#allServices();
    const requested = names.length ? names : Object.keys(all).filter(n => all[n]!.autostart !== false);
    return requested.filter(n => n !== DEVSERVER);
  }

  /** Brings the proxy up once the bundler answers, then prewarms. */
  async #devUp(prewarm: boolean) {
    const dev = this.#dev;
    if (!dev) return undefined;
    const st = (await this.services.status()).find(s => s.name === DEVSERVER);
    if (st?.status !== 'up' && st?.status !== 'external') return undefined;
    if (!dev.proxy.listening) await dev.start();
    return prewarm ? dev.prewarm() : undefined;
  }

  /** The UI session of a device (one runner per device, kept between calls). */
  async ui(device?: string): Promise<DeviceUi> {
    const mac = await this.#macTarget(device);
    const web = mac ? undefined : await this.#webTarget(device);
    const t = web || mac ? undefined : await this.#target(device);
    const id = mac ? `mac:${mac}` : web ? `web:${web}` : t!.id;
    let ui = this.#uis.get(id);
    if (ui) return ui;
    const hooks: UiHooks = {
      beforeAction: () => {
        const proxy = this.#dev?.proxy;
        if (!proxy || !proxy.apps().length) return undefined;
        const id = crypto.randomBytes(16).toString('hex');
        proxy.setTrace(id);
        this.#lastTrace = {id, at: Date.now()};
        return id;
      },
      jsErrors: since => this.#jsErrors(since),
      networkIdle: async timeoutMs => {
        const proxy = this.#dev?.proxy;
        if (!proxy || !proxy.apps().length) return;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const answers = await proxy.query<{inflight: number}>('idle', {}, 800);
          if (answers.every(a => a.data.inflight <= 0)) return;
          await new Promise(r => setTimeout(r, 150));
        }
      },
    };
    ui = mac
      ? new DeviceUi(id, this.#macRunner(mac), hooks, this.#macCrashes(mac))
      : web
      ? new DeviceUi(id, this.#webRunner(web), hooks, this.#webCrashes(web))
      : t!.platform === 'apple'
        ? t!.s instanceof RemoteApple
          ? new DeviceUi(t!.id, new RemoteAppleRunner(t!.s, t!.id, this.config.app?.apple), hooks, new RemoteAppleCrashes(t!.s, t!.id, this.config.app?.apple))
          : new DeviceUi(t!.id, new AppleRunner(t!.s as AppleDriver, t!.id, this.config.app?.apple), hooks, new AppleCrashWatcher(t!.s as AppleDriver, t!.id, this.config.app?.apple))
        : new DeviceUi(t!.id, new AndroidRunner(t!.a, t!.id), hooks, new CrashWatcher(t!.a.adbPath, t!.id, this.config.app?.android));
    this.#uis.set(id, ui);
    return ui;
  }

  #visualDir() {
    return path.resolve(this.#loaded.root, this.config.visual ?? 'visual');
  }

  #flowsDir() {
    return path.resolve(this.#loaded.root, this.config.flows ?? 'flows');
  }

  #loadFlow(name: string): string {
    const candidates = [name, `${name}.flow`].flatMap(n => [path.resolve(this.#flowsDir(), n), path.resolve(this.#loaded.root, n)]);
    const file = candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!file) throw new Error(`no flow "${name}" in ${this.#flowsDir()}`);
    return fs.readFileSync(file, 'utf8');
  }

  /** JS errors from the apps on the dev server, as crash events. */
  async #jsErrors(since: number) {
    const proxy = this.#dev?.proxy;
    if (!proxy) return [];
    return (await proxy.errorsSince(since)).map(e => ({
      at: e.at,
      kind: 'js-error' as const,
      summary: `${e.message}${e.fatal ? ' (fatal)' : ''}`,
      lines: [...e.frames, ...(e.code ? [`> ${e.code}`] : [])],
    }));
  }

  #flowHost(device?: string, variant?: string): FlowHost {
    return {
      jsErrors: since => this.#jsErrors(since),
      perf: async (reset, trace) => {
        const data = await this.methods.perf({device, reset, trace});
        return {data: data as PerfData, text: formatResult('perf', data)};
      },
      reshape: (op, value) => this.methods[op]({device, value}),
      // The closures below read `device`, so switching it moves every following step to that device.
      setDevice: async name => {
        if (!(await this.#macTarget(name)) && !(await this.#webTarget(name))) await this.#target(name);
        device = name;
      },
      ui: () => this.ui(device),
      open: async (target, relaunch) => {
        const r = (await this.methods.open({device, target, relaunch})) as {totalMs?: number; jsMs?: number};
        (await this.ui(device)).record(`open${relaunch ? '!' : ''}${target ? ` ${JSON.stringify(target)}` : ''}`);
        return {activityMs: r.totalMs, jsMs: r.jsMs};
      },
      goto: async (route, params) => {
        await this.#goto(device, route, params);
      },
      signIn: user => runFlow(this.#flowHost(device), this.#loadFlow(this.#needSignIn()), {user}),
      tool: (name, params) => this.methods.tool({name, params}) as Promise<{code: number | null; output: string}>,
      loadFlow: name => this.#loadFlow(name),
      visual: async (name, masks) => (await this.ui(device)).visual(variant ? `${name}@${variant}` : name, this.#visualDir(), {masks}),
      state: async name => {
        await this.methods.stateRestore({name, device});
      },
      screenshot: async (name, full) => {
        const base = variant ? path.join(variant, name ?? new Date().toISOString().replace(/[:.]/g, '-')) : name;
        if (full) {
          const file = path.join(this.#loaded.stateDir, 'shots', `${base ?? 'screen'}.png`);
          return ((await this.methods.screenshot({device, file})) as {file: string}).file;
        }
        return (await (await this.ui(device)).screenshot(this.#shotFile(base))).file;
      },
    };
  }

  #needSignIn(): string {
    if (!this.config.signIn) throw new Error('no signIn flow in the config');
    return this.config.signIn;
  }

  #shotFile(name?: string) {
    return path.join(this.#loaded.stateDir, 'shots', `${name ?? new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
  }

  async #goto(device: string | undefined, route: string, params: Record<string, string>) {
    const template = this.config.routes?.[route];
    if (!template) throw new Error(`unknown route: ${route} (known: ${Object.keys(this.config.routes ?? {}).join(', ') || 'none'})`);
    const url = fillRoute(route, template, params);
    await this.methods.open({device, target: url});
    (await this.ui(device)).record(`goto ${route}${Object.entries(params).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('')}`);
    return url;
  }

  /** The link that points the app at the dev server (see `app.connect`). */
  connectUrl(host?: string): string | undefined {
    const dev = this.#dev;
    if (!dev) return undefined;
    const h = host ?? 'localhost';
    const devserver = `http://${h}:${dev.port}`;
    const template = this.config.app?.connect ?? (this.config.app?.android ? `pitbox.${this.config.app.android}://connect?devserver={host}:{port}` : undefined);
    if (!template) return undefined;
    return template.replace(/\{devserver\}/g, encodeURIComponent(devserver)).replace(/\{host\}/g, h).replace(/\{port\}/g, String(dev.port));
  }

  get android(): AndroidDriver | undefined {
    if (this.#android === undefined) {
      try {
        this.#android = new AndroidDriver();
      } catch {
        this.#android = null;
      }
    }
    return this.#android ?? undefined;
  }

  /**
   * A device as the JS debugger names its app: the model an Android app reports, the simulator's name. A serial
   * or udid is not in a debugger page's name, so with apps on two devices it would match neither.
   */
  async #jsDevice(device?: string): Promise<string | undefined> {
    if (!device) return undefined;
    const android = await this.android?.devices().catch(() => []);
    const a = android?.find(d => d.serial === device || d.avd === device || d.model === device);
    if (a) return a.model ?? device;
    const sims = await this.apple?.simulators().catch(() => []);
    return sims?.find(s => s.udid === device || s.name === device)?.name ?? device;
  }

  /** The local simulators, or a remote Mac's when `apple.remote` names one. */
  get apple(): AppleDevices | undefined {
    const remote = this.config.apple?.remote;
    const key = remote ?? '';
    if (key !== this.#appleKey) {
      this.#appleKey = key;
      this.#apple = undefined;
    }
    if (this.#apple === undefined) {
      if (remote) {
        const token = process.env.PITBOX_REMOTE_TOKEN ?? this.config.apple?.token;
        this.#apple = token ? new RemoteApple(remote, token) : null;
      } else {
        try {
          this.#apple = new AppleDriver();
        } catch {
          this.#apple = null;
        }
      }
    }
    return this.#apple ?? undefined;
  }

  #needApple(): AppleDevices {
    const s = this.apple;
    if (!s) throw new Error(this.config.apple?.remote ? 'apple.remote is set but no token\nhint: set PITBOX_REMOTE_TOKEN to the token `pitbox serve-devices` printed on the Mac' : 'Apple simulators need macOS with Xcode\nhint: on another OS, run `pitbox serve-devices` on a Mac and set apple.remote');
    return s;
  }


  /**
   * The device a selector names, on either platform: a booted simulator by udid or name, else an Android device.
   * Without a selector, the only online device; Android alone keeps its old behaviour when no simulator runs.
   */
  /** A change to the screen's shape on an Android device; the device's UI session measures the screen again. */
  async #reshape<T extends Record<string, unknown>>(device: string | undefined, what: keyof typeof APPLE_HAS_NO, op: (a: AndroidDriver, serial: string) => Promise<T>) {
    const t = await this.#target(device);
    if (t.platform === 'apple') throw new Error(APPLE_HAS_NO[what]);
    const r = await op(t.a, t.id);
    this.#uis.get(t.id)?.screenChanged();
    return {serial: t.id, ...r};
  }

  readonly #webRunners = new Map<string, WebRunner>();

  /**
   * The web app a call is for: `web:<name>` (or `web` with one app), or with no device named, the only web app when
   * no phone, emulator or simulator is online. Undefined for native devices.
   */
  async #webTarget(device?: string): Promise<string | undefined> {
    const apps = Object.keys(this.config.web ?? {});
    if (device) {
      const m = /^web(?::(.+))?$/.exec(device);
      if (!m) return undefined;
      if (!apps.length) throw new Error('no web apps in the config — add web: {<name>: {url: …}}');
      const name = m[1] ?? (apps.length === 1 ? apps[0] : undefined);
      if (!name || !apps.includes(name)) throw new Error(`no web app "${m[1] ?? ''}" (known: ${apps.map(a => `web:${a}`).join(', ')})`);
      return name;
    }
    if (!apps.length) return undefined;
    const androids = this.android ? (await this.android.devices().catch(() => [])).filter(d => d.state === 'device').length : 0;
    const sims = this.apple ? (await this.apple.booted().catch(() => [])).length : 0;
    if (androids + sims) return undefined;
    if (apps.length === 1) return apps[0];
    throw new Error(`several web apps and no device online\nhint: pass a device: ${apps.map(a => `web:${a}`).join(', ')}`);
  }

  #webRunner(name: string): WebRunner {
    let r = this.#webRunners.get(name);
    if (!r) {
      r = new WebRunner(name, this.config.web![name]!, this.#loaded.root);
      this.#webRunners.set(name, r);
    }
    return r;
  }

  /** Uncaught page errors and console errors as the actions' crash reports. */
  #webCrashes(name: string) {
    const r = this.#webRunner(name);
    return {start: () => undefined, stop: () => undefined, since: (t: number) => r.events.filter(e => e.at >= t)};
  }

  readonly #macRunners = new Map<string, MacRunner>();

  /**
   * The Mac app a call is for: `mac:<name>` (or `mac` with one app), or with no device named, the only Mac app when
   * the config has no web app and no phone, emulator or simulator is online. Undefined for other devices.
   */
  async #macTarget(device?: string): Promise<string | undefined> {
    const apps = Object.keys(this.config.mac ?? {});
    if (device) return macDevice(device, apps);
    if (apps.length !== 1 || Object.keys(this.config.web ?? {}).length) return undefined;
    const androids = this.android ? (await this.android.devices().catch(() => [])).filter(d => d.state === 'device').length : 0;
    const sims = this.apple ? (await this.apple.booted().catch(() => [])).length : 0;
    return androids + sims ? undefined : apps[0];
  }

  #macRunner(name: string): MacRunner {
    let r = this.#macRunners.get(name);
    if (!r) {
      r = new MacRunner(name, this.config.mac![name]!, this.#loaded.root);
      this.#macRunners.set(name, r);
    }
    return r;
  }

  /** The Mac's crash reports of the app, as for a simulator app. */
  #macCrashes(name: string) {
    const r = this.#macRunner(name);
    const probe = {running: async () => (await r.call<{pid?: number}>('pid').catch(() => ({pid: undefined}))).pid !== undefined, slow: async () => false};
    return new AppleCrashWatcher(probe, '', r.cfg.app);
  }

  async #target(device?: string): Promise<{platform: 'android'; id: string; a: AndroidDriver} | {platform: 'apple'; id: string; s: AppleDevices}> {
    if (device && /^web(:|$)/.test(device)) throw new Error(`${device} is a web app: this needs a phone, an emulator or a simulator`);
    if (device && /^mac(:|$)/.test(device)) throw new Error(`${device} is a Mac app: this needs a phone, an emulator or a simulator`);
    const s = this.apple;
    const booted = s ? await s.booted().catch(() => []) : [];
    if (s && booted.length) {
      if (device) {
        const hit = pickSimulator(booted, device);
        if (hit) return {platform: 'apple', id: hit.udid, s};
      } else {
        const online = this.android ? (await this.android.devices().catch(() => [])).filter(d => d.state === 'device') : [];
        if (!online.length) return {platform: 'apple', id: await s.resolve(), s};
        throw new Error(`several devices online\nhint: pass a device: ${[...online.map(d => d.avd ?? d.serial), ...booted.map(b => b.name)].join(', ')}`);
      }
    }
    if (s && !this.android) return {platform: 'apple', id: await s.resolve(device), s};
    const a = this.#needAndroid();
    return {platform: 'android', id: await a.resolve(device), a};
  }

  #bundleId(p: Params): string {
    const id = str(p, 'pkg') ?? this.config.app?.apple;
    if (!id) throw new Error('no bundle id: pass pkg or set app.apple in the config');
    return id;
  }

  #needAndroid(): AndroidDriver {
    const a = this.android;
    if (!a) throw new Error('adb not found — install Android SDK platform-tools or set ANDROID_HOME');
    return a;
  }

  #pkg(p: Params): string {
    const pkg = str(p, 'pkg') ?? this.config.app?.android;
    if (!pkg) throw new Error('no package: pass pkg or set app.android in the config');
    return pkg;
  }

  /** Re-applies port forwards to devices that came online or lost them. Runs every few seconds. */
  async ensureForwards(force = false): Promise<{serial: string; ports: number[]}[]> {
    const android = this.android;
    const ports = exposedPorts(this.config);
    if (!android || !ports.length) return [];
    const online = (await android.devices()).filter(d => d.state === 'device');
    for (const s of [...this.#forwarded]) if (!online.some(d => d.serial === s)) this.#forwarded.delete(s);
    const verify = force || Date.now() - this.#lastForwardCheck > 30_000;
    if (verify) this.#lastForwardCheck = Date.now();
    const applied: {serial: string; ports: number[]; via?: string}[] = [];
    const mode = this.config.android?.forward ?? 'auto';
    for (const d of online) {
      if (this.#forwarded.has(d.serial) && !verify) continue;
      // A device seen for the first time is checked at once: a flow may need the stand seconds after a boot.
      const fresh = !this.#forwarded.has(d.serial);
      if (d.avd && this.#relayAvds().has(d.avd) && !this.#noRelay.has(d.serial)) this.#relayed.add(d.serial);
      if (this.#relayed.has(d.serial) || (mode === 'relay' && d.emulator)) {
        // The relay lives in the runner; a restarted runner has none, so re-apply when they are gone.
        const ui = await this.ui(d.serial);
        const r = await ui.runner.call<{relayed: number[]}>('relays');
        const missing = ports.filter(p => !r.relayed.includes(p));
        if (missing.length) {
          await android.adb(['reverse', '--remove-all'], d.serial);
          await ui.runner.call('relay', {ports: missing, target: '10.0.2.2'});
          applied.push({serial: d.serial, ports: missing, via: 'relay'});
        }
        this.#relayed.add(d.serial);
        this.#forwarded.add(d.serial);
        // The relay needs the emulator's network (the host alias); an image without one (some glasses) has only
        // loopback. Then adb reverse is the only way, and the device goes back to it for good.
        if (mode === 'auto' && (verify || fresh) && !(await this.#carriesSettled(d.serial, ports))) {
          await ui.runner.call('unrelay');
          this.#relayed.delete(d.serial);
          this.#noRelay.add(d.serial);
          if (d.avd) this.#forgetRelay(d.avd);
          this.#forwarded.delete(d.serial);
          applied.push(...(await this.ensureForwards(true)).filter(a => a.serial === d.serial));
        }
        continue;
      }
      const have = await android.reverseList(d.serial);
      const missing = ports.filter(p => !have.includes(p));
      if (missing.length) {
        const now = await android.reverse(d.serial, missing);
        const failed = missing.filter(p => !now.includes(p));
        if (failed.length && d.emulator) {
          // A runner relay left by an earlier daemon outlives it and holds the ports on the device, so `adb
          // reverse` cannot bind them ("Address already in use"). Adopt the relay instead of reporting forwards
          // that do not exist.
          const ui = await this.ui(d.serial);
          const r = await ui.runner.call<{relayed: number[]}>('relays');
          if (failed.every(p => r.relayed.includes(p))) {
            this.#relayed.add(d.serial);
            applied.push(...(await this.ensureForwards(true)).filter(a => a.serial === d.serial));
            continue;
          }
        }
        if (failed.length) throw new Error(`adb reverse could not forward ${failed.join(', ')} to ${d.serial} — a device process may hold the port`);
        applied.push({serial: d.serial, ports: missing});
      }
      this.#forwarded.add(d.serial);
      // `adb reverse` can list its forwards and carry nothing; on an emulator, try the relay then. It is
      // remembered for the AVD only once the relay is seen carrying data.
      if (mode === 'auto' && d.emulator && !this.#noRelay.has(d.serial) && (verify || fresh) && !(await this.#carriesSettled(d.serial, ports))) {
        this.#relayed.add(d.serial);
        this.#forwarded.delete(d.serial);
        applied.push(...(await this.ensureForwards(true)).filter(a => a.serial === d.serial));
        if (this.#relayed.has(d.serial) && d.avd) this.#rememberRelay(d.avd);
      }
    }
    return applied;
  }

  /** Serials whose forwards go through the runner's relay instead of `adb reverse`. */
  readonly #relayed = new Set<string>();
  /** Serials where the relay carried nothing either (no emulator network): adb reverse only. */
  readonly #noRelay = new Set<string>();

  /** Whether forwards carry data, asked twice a moment apart: right after a boot or a new forward the first answer can be a false no. */
  async #carriesSettled(serial: string, ports: number[]): Promise<boolean> {
    if (await this.#forwardCarries(serial, ports)) return true;
    await new Promise(r => setTimeout(r, 1500));
    return this.#forwardCarries(serial, ports);
  }

  /**
   * AVDs whose adb reverse was found broken — remembered so the next daemon relays them from the start. A fact
   * about the emulator on this machine, not about a project, so every project shares it.
   */
  #relayAvds(): Set<string> {
    const read = (file: string) => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
      } catch {
        return [];
      }
    };
    return new Set([...read(machineRelayFile()), ...read(path.join(this.#loaded.stateDir, 'relay-avds.json'))]);
  }

  #forgetRelay(avd: string) {
    const set = this.#relayAvds();
    if (!set.delete(avd)) return;
    fs.mkdirSync(path.dirname(machineRelayFile()), {recursive: true});
    fs.writeFileSync(machineRelayFile(), JSON.stringify([...set]));
    // The project's own older list would bring it back.
    const local = path.join(this.#loaded.stateDir, 'relay-avds.json');
    try {
      const list = (JSON.parse(fs.readFileSync(local, 'utf8')) as string[]).filter(x => x !== avd);
      fs.writeFileSync(local, JSON.stringify(list));
    } catch {
      // no project list
    }
  }

  #rememberRelay(avd: string) {
    const set = this.#relayAvds();
    set.add(avd);
    fs.mkdirSync(path.dirname(machineRelayFile()), {recursive: true});
    fs.writeFileSync(machineRelayFile(), JSON.stringify([...set]));
  }

  /**
   * Whether data really flows from the device to the host on a forwarded port: an HTTP request sent from the
   * device to a port where the host answers HTTP must get bytes back. True when no port can be checked.
   */
  async #forwardCarries(serial: string, ports: number[]): Promise<boolean> {
    const android = this.android;
    if (!android) return true;
    for (const port of ports) {
      const host = await httpAlive(`http://127.0.0.1:${port}/`, 1500);
      if (host.status === undefined) continue;
      const out = await android
        .shell(serial, `printf 'GET / HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' | toybox nc -w 4 127.0.0.1 ${port} | head -c 12`, 15_000)
        .catch(() => '');
      // Every HTTP port: one working forward must not hide a dead one.
      if (!out.trim().length) return false;
    }
    return true;
  }

  /** Forwarding state per device, for doctor and status. */
  async forwardHealth(): Promise<{serial: string; via: 'reverse' | 'relay'; carries: boolean}[]> {
    const android = this.android;
    if (!android) return [];
    const ports = exposedPorts(this.config);
    const out: {serial: string; via: 'reverse' | 'relay'; carries: boolean}[] = [];
    for (const d of (await android.devices()).filter(x => x.state === 'device')) {
      out.push({serial: d.serial, via: this.#relayed.has(d.serial) ? 'relay' : 'reverse', carries: await this.#forwardCarries(d.serial, ports)});
    }
    return out;
  }

  /** Moves a device's forwards onto the runner's relay (emulators only). */
  async useRelay(serial: string): Promise<string> {
    this.#relayed.add(serial);
    const avd = (await this.android?.devices())?.find(d => d.serial === serial)?.avd;
    if (avd) this.#rememberRelay(avd);
    this.#forwarded.delete(serial);
    const r = await this.ensureForwards(true);
    return `forwards for ${serial} now go through the runner relay (${r.flatMap(a => a.ports).join(', ') || 'already in place'})`;
  }

  startWatching() {
    const tick = async () => {
      try {
        await this.refresh();
        await this.ensureForwards();
        if (this.#dev && !this.#dev.proxy.listening) await this.#devUp(true);
      } catch {
        // adb hiccups are retried on the next tick
      }
      this.#watchTimer = setTimeout(tick, 5000);
      this.#watchTimer.unref();
    };
    void tick();
  }

  /**
   * Daemon shutdown. Services keep running on purpose — keeping them warm is the point — and the next daemon
   * adopts them from the pid file; only `down` stops them. Actors and the mock belong to the daemon and go.
   */
  async stopAll() {
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.actors.stopAll();
    await this.#mock?.stop();
    await this.#dev?.stop();
    for (const ui of this.#uis.values()) await ui.stop().catch(() => undefined);
    for (const r of this.#macRunners.values()) await r.stop().catch(() => undefined);
  }

  async #startMock() {
    const m = this.config.mocks?.llm;
    if (!m) return undefined;
    if (!this.#mock || this.#mock.port !== m.port) {
      await this.#mock?.stop();
      this.#mock = new LlmMock(m.port, m.fixtures ? resolveFrom(this.#loaded.root, m.fixtures) : undefined);
    }
    if (!this.#mock.running) await this.#mock.start();
    return {port: m.port, running: this.#mock.running};
  }

  /** RPC entry point. */
  async call(method: string, p: Params = {}): Promise<unknown> {
    await this.refresh();
    const fn = (this.methods as Record<string, (p: Params) => Promise<unknown>>)[method];
    if (!fn) throw new Error(`unknown method: ${method}`);
    return fn(p);
  }

  readonly methods = {
    ping: async () => ({pid: process.pid, root: this.#loaded.root, config: this.#loaded.file}),

    status: async () => {
      const [services, devices, simulators] = await Promise.all([
        this.services.status(),
        this.android ? this.android.devices().catch(() => []) : Promise.resolve([]),
        this.apple ? this.apple.booted().catch(() => []) : Promise.resolve([]),
      ]);
      return {
        services,
        actors: this.actors.list(),
        mock: this.config.mocks?.llm ? {port: this.config.mocks.llm.port, running: this.#mock?.running ?? false, requests: this.#mock?.requests ?? 0} : undefined,
        devices,
        simulators: simulators.length ? simulators.map(x => ({udid: x.udid, name: x.name, os: x.os})) : undefined,
        exposed: exposedPorts(this.config),
        dev: this.#dev?.status(),
      };
    },

    up: async (p: Params) => {
      const names = list(p, 'services');
      const mock = names.length ? undefined : await this.#startMock();
      const blocked = !names.length || names.includes(DEVSERVER) ? await this.#claimDevPort() : undefined;
      // An empty list means every autostart service to `services.up`, the dev server included: none is asked for.
      const rest = blocked ? this.#withoutDev(names) : names;
      const services = blocked && !rest.length ? [] : await this.services.up(rest);
      if (blocked) services.push(blocked);
      const prewarm = !blocked && (!names.length || names.includes(DEVSERVER)) ? await this.#devUp(true) : undefined;
      const forwards = await this.ensureForwards(true).catch(() => []);
      return {services, mock, forwards, prewarm};
    },

    down: async (p: Params) => {
      const names = list(p, 'services');
      if (!names.length) {
        this.actors.stopAll();
        await this.#mock?.stop();
      }
      const services = await this.services.down(names);
      if (this.#dev && services.some(s => s.name === DEVSERVER && s.status === 'stopped')) await this.#dev.stop();
      return {services};
    },

    restart: async (p: Params) => {
      const names = list(p, 'services');
      if (names.includes(DEVSERVER)) await this.#dev?.stop();
      const blocked = names.includes(DEVSERVER) ? await this.#claimDevPort() : undefined;
      const rest = blocked ? this.#withoutDev(names) : names;
      const services = blocked && !rest.length ? [] : await this.services.restart(rest);
      if (blocked) services.push(blocked);
      const prewarm = !blocked && names.includes(DEVSERVER) ? await this.#devUp(true) : undefined;
      return {services, prewarm};
    },

    devStatus: async () => {
      if (!this.#dev) throw new Error('no devserver in the config');
      const st = (await this.services.status()).find(s => s.name === DEVSERVER);
      return {service: st, ...this.#dev.status()};
    },

    devPrewarm: async () => {
      if (!this.#dev) throw new Error('no devserver in the config');
      return {prewarm: (await this.#devUp(true)) ?? []};
    },

    qr: async (p: Params) => {
      const dev = this.#dev;
      if (!dev) throw new Error('no devserver in the config');
      const host = bool(p, 'lan') ? (lanAddress() ?? 'localhost') : dev.publicHost();
      const url = this.connectUrl(host);
      if (!url) throw new Error('no connect link: set app.connect or app.android in the config');
      const file = path.join(this.#loaded.stateDir, 'qr.png');
      fs.mkdirSync(path.dirname(file), {recursive: true});
      await QRCode.toFile(file, url, {margin: 2, width: 360});
      const terminal = bool(p, 'terminal') ? await QRCode.toString(url, {type: 'terminal', small: true}) : undefined;
      const reachable = host === 'localhost' ? 'devices behind adb only — use lan=true (and devserver.host: lan) for a phone on Wi-Fi' : `devices that reach ${host}:${dev.port}`;
      return {url, file, terminal, reachable};
    },

    fresh: async () => {
      if (!this.#dev) throw new Error('no devserver in the config');
      await this.#dev.settled();
      return this.#dev.freshness();
    },

    appLog: async (p: Params) => {
      if (!this.#dev) throw new Error('no devserver in the config');
      const answers = await this.#dev.proxy.query<Record<string, unknown>[]>('log', {limit: num(p, 'limit') ?? 30});
      return {apps: answers.map(a => ({app: a.app.id, platform: a.app.hello?.platform, entries: a.data}))};
    },

    appConsole: async (p: Params) => {
      if (!this.#dev) throw new Error('no devserver in the config');
      const proxy = this.#dev.proxy;
      const rank: Record<string, number> = {debug: 0, log: 1, info: 1, warn: 2, error: 3};
      const min = rank[str(p, 'level') ?? 'debug'] ?? 0;
      const grep = str(p, 'grep') ? new RegExp(str(p, 'grep')!, 'i') : undefined;
      const limit = num(p, 'limit') ?? 30;
      type Entry = {n: number; l: string; at: number; m: string; stack?: string};
      const answers = await proxy.query<Entry[]>('console', {}, 3000);
      const apps = await Promise.all(
        answers.map(async a => {
          const all = Array.isArray(a.data) ? a.data : [];
          const matching = all.filter(e => (rank[e.l] ?? 1) >= min && (!grep || grep.test(e.m)));
          const shown = matching.slice(-limit);
          const entries = await Promise.all(shown.map(async ({stack, ...e}) => ({...e, from: stack ? (await proxy.callSite(a.app, stack))[0] : undefined})));
          return {app: a.app.id, platform: a.app.hello?.platform, total: all.length, matching: matching.length, entries};
        }),
      );
      return {apps};
    },

    appErrors: async (p: Params) => {
      if (!this.#dev) throw new Error('no devserver in the config');
      const errors = await this.#dev.proxy.errorsSince(Date.now() - (num(p, 'minutes') ?? 30) * 60_000);
      return {errors: errors.slice(-(num(p, 'limit') ?? 5))};
    },

    appTree: async (p: Params) => {
      if (!this.#dev) throw new Error('no devserver in the config');
      type TreeNode = {s: number; d: number; c: string; id?: string; l?: string; t?: string; hidden?: boolean};
      const answers = await this.#dev.proxy.query<{error?: string; surfaces?: number; nodes?: TreeNode[]; truncated?: boolean}>('tree', {limit: num(p, 'limit') ?? 600}, 5000);
      return {apps: answers.map(a => ({app: a.app.id, platform: a.app.hello?.platform, ...a.data}))};
    },

    net: async (p: Params) => {
      if (!this.#dev) throw new Error('no devserver in the config');
      const proxy = this.#dev.proxy;
      const action = str(p, 'action') ?? 'list';
      if (action === 'clear') proxy.setRules([]);
      else if (action === 'offline') {
        proxy.setRules([
          {id: 'offline-http', kind: 'http', match: '*', action: 'fail'},
          {id: 'offline-ws', kind: 'ws', match: '*', action: 'freeze'},
        ]);
      } else if (action !== 'list') {
        if (!['fail', 'mock', 'delay', 'freeze'].includes(action)) throw new Error('net action: fail | mock | delay | freeze | offline | clear | list');
        let body: unknown = p.body;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch {
            // plain text body
          }
        }
        const rule = {
          id: `r${proxy.rules.length + 1}-${crypto.randomBytes(2).toString('hex')}`,
          kind: (str(p, 'kind') as 'http' | 'ws' | undefined) ?? (action === 'freeze' ? 'ws' : 'http'),
          match: str(p, 'match') ?? '*',
          action: action as 'fail' | 'mock' | 'delay' | 'freeze',
          status: num(p, 'status'),
          body,
          ms: num(p, 'ms'),
        };
        proxy.setRules([...proxy.rules, rule]);
      }
      return {rules: proxy.rules, apps: proxy.apps().length};
    },

    jsEval: async (p: Params) => {
      // A web app: the expression runs in its page, not in a phone's runtime.
      const web = await this.#webTarget(str(p, 'device'));
      if (web) {
        const t0 = Date.now();
        const r = await this.#webRunner(web).evaluate(req(p, 'expr'), (num(p, 'timeout') ?? 10) * 1000);
        return {...r, app: `web:${web}`, apps: 1, picked: true, ms: Date.now() - t0};
      }
      if (!this.#dev) throw new Error('no devserver in the config');
      return this.#dev.js.evaluate(req(p, 'expr'), await this.#jsDevice(str(p, 'device')), (num(p, 'timeout') ?? 10) * 1000);
    },

    jsLog: async (p: Params) => {
      if (!this.#dev) throw new Error('no devserver in the config');
      const exprs = Array.isArray(p.exprs) ? p.exprs.map(String) : typeof p.exprs === 'string' ? [p.exprs] : [];
      return this.#dev.js.log(req(p, 'at'), exprs, await this.#jsDevice(str(p, 'device')));
    },

    jsHits: async (p: Params) => {
      if (!this.#dev) throw new Error('no devserver in the config');
      return this.#dev.js.hits(str(p, 'id'), num(p, 'limit') ?? 20);
    },

    jsClear: async (p: Params) => {
      if (!this.#dev) throw new Error('no devserver in the config');
      return this.#dev.js.clear(str(p, 'id'));
    },

    // A build with the bundle inside: written from the running bundler into the app's sources, then built.
    devEmbed: async () => {
      if (!this.#dev) throw new Error('no devserver in the config');
      if (!this.#dev.proxy.listening) throw new Error('the dev server is not running: the bundle comes from it (stand up)');
      const r = await this.#dev.embed();
      // The bundle sits in the app's sources: say so when git would pick it up.
      const tracked = await Promise.all(
        r.bundles.filter(b => b.file).map(async b => ((await run('git', ['check-ignore', '-q', b.file!], {cwd: path.dirname(b.file!), timeoutMs: 10_000})).code === 1 ? b.file! : undefined)),
      );
      return {...r, notIgnored: tracked.filter(Boolean)};
    },

    devReload: async () => {
      if (!this.#dev) throw new Error('no devserver in the config');
      await this.#dev.reload();
      return {reloaded: true};
    },

    // The LLM mock while it runs: its request log, and rules that force a reply, an error or a delay.
    llm: async (p: Params) => {
      if (!this.config.mocks?.llm) throw new Error('no LLM mock in the config (mocks.llm)');
      const m = this.#mock;
      if (!m?.running) throw new Error('the LLM mock is not running: stand up starts it');
      const action = str(p, 'action') ?? 'log';
      const once = bool(p, 'once');
      const match = str(p, 'match');
      if (action === 'reply') m.addRule({action: 'reply', match, text: req(p, 'text'), once});
      else if (action === 'fail') m.addRule({action: 'fail', match, status: num(p, 'status') ?? 500, text: str(p, 'text'), once});
      else if (action === 'delay') m.addRule({action: 'delay', match, ms: num(p, 'ms') ?? 5000, once});
      else if (action === 'clear') m.clearRules();
      else if (action === 'reload') m.reload();
      else if (action !== 'log') throw new Error('llm action: log | reply | fail | delay | clear | reload');
      return {action, port: m.port, requests: m.requests, fixtures: m.fixtures, rules: m.rules, log: action === 'log' ? m.log.slice(-(num(p, 'limit') ?? 10)) : undefined};
    },

    // What the backend logged for one agent action: its trace id, searched in every stand service's and actor's log.
    trace: async (p: Params) => {
      const given = str(p, 'id');
      const id = given && given !== 'last' ? given.toLowerCase() : this.#lastTrace?.id;
      if (!id) throw new Error('no action has carried a trace yet: actions stamp one on app requests when the app runs through the dev server');
      if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`a trace id is 32 hex characters, not "${id}"`);
      const limit = num(p, 'lines') ?? 20;
      const sources = [
        ...this.services.names().map(name => ({name, lines: this.services.logTail(name, limit, id)})),
        ...this.actors.list().map(a => ({name: a.name, lines: this.actors.logTail(a.name, limit, id)})),
      ];
      return {id, at: this.#lastTrace?.id === id ? this.#lastTrace.at : undefined, searched: sources.length, found: sources.filter(s => s.lines.length)};
    },

    logs: async (p: Params) => {
      const name = req(p, 'name');
      const lines = num(p, 'lines') ?? 40;
      const g = str(p, 'grep');
      if (this.actors.list().some(a => a.name === name) && !this.services.names().includes(name)) return {lines: this.actors.logTail(name, lines, g)};
      return {lines: this.services.logTail(name, lines, g), file: this.services.logFile(name)};
    },

    tools: async () => Object.entries(this.config.tools ?? {}).map(([n, t]) => describeTool(n, t)),

    tool: async (p: Params) => {
      const name = req(p, 'name');
      const tool = this.config.tools?.[name];
      if (!tool) throw new Error(`unknown tool: ${name} (known: ${Object.keys(this.config.tools ?? {}).join(', ') || 'none'})`);
      const params = Object.fromEntries(Object.entries((p.params as Params) ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
      return runTool({root: this.#loaded.root, stateDir: this.#loaded.stateDir, shell: this.config.shell}, name, tool, params, num(p, 'maxChars') ?? 6000);
    },

    actorTypes: async () => this.actors.types(),
    actors: async () => this.actors.list(),
    actorStart: async (p: Params) => this.actors.start(req(p, 'type'), req(p, 'name'), num(p, 'port')),
    actorStop: async (p: Params) => this.actors.stop(req(p, 'name')),
    actorCall: async (p: Params) => this.actors.call(req(p, 'name'), p.body),

    // Wireless debugging: a QR the phone scans (then `wait`), or the ip:port and code its screen shows.
    pair: async (p: Params) => {
      const a = this.#needAndroid();
      const value = str(p, 'value')?.trim();
      if (value && value !== 'wait') {
        const {host, port, code} = parseCodePairing(value);
        await a.pair(host, port, code);
        const serial = await a.connectPaired(host);
        await this.ensureForwards(true).catch(() => undefined);
        return {serial};
      }
      if (value === 'wait') {
        const pairing = this.#pairing;
        if (!pairing) throw new Error('no pairing in progress: device action=pair shows a QR first');
        const timeoutMs = (num(p, 'timeout') ?? 120) * 1000;
        await Promise.race([pairing.done, new Promise(r => setTimeout(r, timeoutMs))]);
        if (!pairing.result) return {waiting: true, name: pairing.name, file: pairing.file};
        if (pairing.result.error) throw new Error(pairing.result.error);
        return {serial: pairing.result.serial};
      }
      const code = pairingCode();
      const file = path.join(this.#loaded.stateDir, 'pair-qr.png');
      fs.mkdirSync(path.dirname(file), {recursive: true});
      await QRCode.toFile(file, code.qr, {margin: 2, width: 360});
      const terminal = bool(p, 'terminal') ? await QRCode.toString(code.qr, {type: 'terminal', small: true}) : undefined;
      const pairing: {name: string; file: string; startedAt: number; result?: {serial?: string; error?: string}; done: Promise<void>} = {name: code.name, file, startedAt: Date.now(), done: Promise.resolve()};
      // Current before the wait starts: the wait ends when another pairing replaces it.
      this.#pairing = pairing;
      pairing.done = pairByQr(a, code, {stop: () => this.#pairing !== pairing}).then(async r => {
        pairing.result = r;
        if (r.serial) await this.ensureForwards(true).catch(() => undefined);
      });
      return {file, terminal, name: code.name};
    },

    devices: async () => {
      const a = this.android;
      const s = this.apple;
      if (!a && !s && !this.config.web && !this.config.mac) this.#needAndroid();
      // A simulator list that cannot be read (a remote Mac that refuses the token, Xcode gone) says why instead of
      // looking like a Mac without simulators.
      let simError: string | undefined;
      const sims = s ? await s.simulators().catch(e => ((simError = (e as Error).message.split('\n')[0]), [])) : [];
      return {
        devices: a ? await a.devices() : [],
        avds: a ? a.avds() : [],
        ...(this.config.web ? {web: Object.entries(this.config.web).map(([name, w]) => ({name: `web:${name}`, url: w.url}))} : {}),
        ...(this.config.mac ? {mac: Object.entries(this.config.mac).map(([name, m]) => ({name: `mac:${name}`, app: m.app}))} : {}),
        ...(s ? {simulators: sims.map(x => ({udid: x.udid, name: x.name, os: x.os, kind: x.kind, state: x.state}))} : {}),
        ...(simError ? {simulatorsError: simError} : {}),
      };
    },

    boot: async (p: Params) => {
      const name = str(p, 'avd') ?? this.config.android?.avd ?? this.config.apple?.simulator;
      if (!name) throw new Error('no device: pass an AVD or simulator name, or set android.avd / apple.simulator in the config');
      const a = this.android;
      const s = this.apple;
      // Without an Android SDK an unknown name is a simulator's, so the answer lists the simulators there are.
      if (s && !(a?.avds().some(x => x.name === name)) && (!a || pickSimulator(await s.simulators(), name))) {
        const r = await s.boot(name, {wipe: bool(p, 'wipe'), headless: bool(p, 'headless')});
        return {...r, platform: 'apple'};
      }
      const r = await this.#needAndroid().boot(name, {wipe: bool(p, 'wipe'), headless: bool(p, 'headless'), coldBoot: bool(p, 'coldBoot')});
      const forwards = await this.ensureForwards(true).catch(() => []);
      return {...r, avd: name, forwards};
    },

    shutdown: async (p: Params) => {
      const t = await this.#target(str(p, 'device'));
      if (t.platform === 'apple') {
        await this.#uis.get(t.id)?.stop().catch(() => undefined);
        this.#uis.delete(t.id);
        return {udid: t.id, ...(await t.s.shutdown(t.id))};
      }
      return {serial: t.id, ...(await t.a.shutdown(t.id))};
    },

    install: async (p: Params) => {
      const file = path.resolve(this.#loaded.root, req(p, 'apk'));
      if (isAppleBundle(file)) {
        const s = this.#needApple();
        const udid = await s.resolve(str(p, 'device'));
        return {udid, ...(await s.install(udid, file))};
      }
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      return {serial, ...(await a.install(serial, file, {replace: bool(p, 'replace'), pkg: str(p, 'pkg') ?? this.config.app?.android}))};
    },

    open: async (p: Params) => {
      const mac = await this.#macTarget(str(p, 'device'));
      if (mac) {
        const r = await this.#macRunner(mac).open(str(p, 'target'), bool(p, 'relaunch'));
        this.#uis.get(`mac:${mac}`)?.screenChanged();
        return {serial: `mac:${mac}`, ...r};
      }
      const web = await this.#webTarget(str(p, 'device'));
      if (web) {
        const t0 = Date.now();
        const r = await this.#webRunner(web).goto(str(p, 'target'), bool(p, 'relaunch'));
        this.#uis.get(`web:${web}`)?.screenChanged();
        return {serial: `web:${web}`, target: r.url, totalMs: Date.now() - t0};
      }
      const t = await this.#target(str(p, 'device'));
      // A daemon that just started brings the proxy and the forwards up on its first tick, seconds later; an app
      // launched before that asks a port nobody serves and a dev launcher shows "Connection reset".
      if (this.#dev && !this.#dev.proxy.listening) await this.#devUp(false).catch(() => undefined);
      if (t.platform !== 'apple') await this.ensureForwards().catch(() => undefined);
      if (t.platform === 'apple') {
        const bundleId = str(p, 'pkg') ?? this.config.app?.apple;
        const target = str(p, 'target') ?? (this.config.app?.connect ? this.connectUrl() : undefined) ?? this.#bundleId(p);
        let relaunch = bool(p, 'relaunch');
        let args: string[] | undefined;
        // Point the app at this dev server without a link: React Native reads its bundler from the
        // `RCT_jsLocation` default and the connect library reads `pitbox.<name>`. Saved in the app's preferences
        // (a launch from the home screen keeps it) and passed as launch arguments (they win over a cached value).
        // A simulator shares the Mac's network, so localhost is the Mac.
        if (this.#dev && bundleId && target === bundleId) {
          // A remote Mac reaches this machine at the address it sees; a local simulator at localhost.
          const here = t.s instanceof RemoteApple ? await t.s.localAddress() : 'localhost';
          const host = `${here ?? 'localhost'}:${this.#dev.port}`;
          const values = {RCT_jsLocation: host, 'pitbox.devserver': host};
          await t.s.stop(t.id, bundleId);
          await t.s.setDefaults(t.id, bundleId, values).catch(() => undefined);
          args = Object.entries(values).flatMap(([k, v]) => [`-${k}`, v]);
          relaunch = true;
        }
        const r = await t.s.open(t.id, target, {relaunch, bundleId, args});
        // A runner already attached reads the shell until the launched app comes to the front.
        const ui = this.#uis.get(t.id);
        if (ui && !target.includes('://')) await ui.runner.call('foreground', {}, 10_000).catch(() => undefined);
        // A link waits behind the shell's "Open in …?" question until someone answers it.
        let confirmed = false;
        if (target.includes('://')) {
          // The simulator just resolved, not the selector again.
          const u = await this.ui(t.id);
          // A link of this app (its scheme, its connect link) into the app already in front comes with no question:
          // the runner stops waiting once it sees the app there. A link of another app is waited for in full.
          const scheme = target.slice(0, target.indexOf('://')).toLowerCase();
          const own = !!bundleId && (scheme === this.config.app?.scheme?.toLowerCase() || scheme === `pitbox.${bundleId}`.toLowerCase());
          confirmed = !!(await u.runner.call<{confirmed?: boolean}>('confirmOpen', {app: own ? bundleId : ''}, 10_000).catch(() => ({confirmed: false}))).confirmed;
        }
        const lanHost = this.config.devserver?.host;
        const unreachable = t.s instanceof RemoteApple && this.#dev && (!lanHost || lanHost === '127.0.0.1' || lanHost === 'localhost');
        return {udid: t.id, target, ...r, ...(confirmed ? {confirmed: 'the open-in-app question'} : {}), ...(unreachable ? {note: "the dev server listens on loopback only, out of the Mac's reach: set devserver.host: '0.0.0.0' (or this machine's VPN address)"} : {})};
      }
      const {a, id: serial} = t;
      // Without a target, open the app through its connect link when there is one: it then always talks to this
      // dev server, whatever a launcher remembered.
      const target = str(p, 'target') ?? this.connectUrl() ?? this.#pkg(p);
      const t0 = Date.now();
      const opened = await a.open(serial, target, {relaunch: bool(p, 'relaunch'), pkg: str(p, 'pkg') ?? this.config.app?.android});
      // A cold start of a dev build goes on after the activity: the bundle loads and starts running.
      const proxy = this.#dev?.proxy;
      if (!bool(p, 'relaunch') || !proxy?.listening || !proxy.opts.inApp) return {serial, target, ...opened};
      const js = await proxy.startAfter(t0);
      return {
        serial,
        target,
        ...opened,
        ...(js.runningAt ? {jsMs: js.runningAt - t0} : {}),
        ...(js.bundle ? {bundle: {kind: js.bundle.kind, kb: Math.round(js.bundle.bytes / 1024), ms: js.bundle.ms, note: js.bundle.note}} : {}),
      };
    },

    stopApp: async (p: Params) => {
      const mac = await this.#macTarget(str(p, 'device'));
      if (mac) return {serial: `mac:${mac}`, ...(await this.#macRunner(mac).stopApp())};
      const web = await this.#webTarget(str(p, 'device'));
      if (web) {
        await this.#webRunner(web).goto('about:blank');
        return {serial: `web:${web}`};
      }
      const t = await this.#target(str(p, 'device'));
      if (t.platform === 'apple') {
        await t.s.stop(t.id, this.#bundleId(p));
        return {udid: t.id};
      }
      await t.a.stop(t.id, this.#pkg(p));
      return {serial: t.id};
    },

    clearApp: async (p: Params) => {
      if (await this.#macTarget(str(p, 'device'))) throw new Error("a Mac app keeps its data where it chooses\nhint: remove it with a project tool (tools: in the config), or give the app a launch argument that starts it clean");
      const web = await this.#webTarget(str(p, 'device'));
      if (web) {
        await this.#webRunner(web).clear();
        return {serial: `web:${web}`};
      }
      const t = await this.#target(str(p, 'device'));
      if (t.platform === 'apple') {
        await t.s.clear(t.id, this.#bundleId(p));
        return {udid: t.id};
      }
      await t.a.clear(t.id, this.#pkg(p));
      return {serial: t.id};
    },

    uninstall: async (p: Params) => {
      const t = await this.#target(str(p, 'device'));
      if (t.platform === 'apple') {
        await t.s.uninstall(t.id, this.#bundleId(p));
        return {udid: t.id};
      }
      await t.a.uninstall(t.id, this.#pkg(p));
      return {serial: t.id};
    },

    apps: async (p: Params) => {
      const t = await this.#target(str(p, 'device'));
      return {packages: t.platform === 'apple' ? await t.s.packages(t.id, str(p, 'filter')) : await t.a.packages(t.id, str(p, 'filter'))};
    },

    appLogs: async (p: Params) => {
      const mac = await this.#macTarget(str(p, 'device'));
      if (mac) return {lines: await this.#macRunner(mac).logs({lines: num(p, 'lines') ?? 50, grep: str(p, 'grep'), level: str(p, 'level')})};
      const t = await this.#target(str(p, 'device'));
      const all = bool(p, 'all');
      const opts = {lines: num(p, 'lines') ?? 50, grep: str(p, 'grep'), level: str(p, 'level')};
      if (t.platform === 'apple') return {lines: await t.s.logs(t.id, {...opts, bundleId: all ? undefined : (str(p, 'pkg') ?? this.config.app?.apple)})};
      return {lines: await t.a.logs(t.id, {...opts, pkg: all ? undefined : (str(p, 'pkg') ?? this.config.app?.android)})};
    },

    settings: async (p: Params) => {
      const t = await this.#target(str(p, 'device'));
      if (t.platform === 'apple') {
        const bundleId = str(p, 'pkg') ?? this.config.app?.apple;
        const grant = str(p, 'grant');
        const revoke = str(p, 'revoke');
        return {
          udid: t.id,
          applied: await t.s.settings(t.id, {
            fontScale: num(p, 'fontScale'),
            dark: bool(p, 'dark'),
            animations: bool(p, 'animations'),
            size: str(p, 'size'),
            density: str(p, 'density'),
            locale: str(p, 'locale'),
            grant: grant && bundleId ? {bundleId, service: grant} : undefined,
            revoke: revoke && bundleId ? {bundleId, service: revoke} : undefined,
          }),
        };
      }
      const {a, id: serial} = t;
      const pkg = str(p, 'pkg') ?? this.config.app?.android;
      const permission = str(p, 'grant') ?? str(p, 'revoke');
      return {
        serial,
        applied: await a.settings(serial, {
          fontScale: num(p, 'fontScale'),
          dark: bool(p, 'dark'),
          animations: bool(p, 'animations'),
          size: str(p, 'size'),
          density: str(p, 'density'),
          locale: str(p, 'locale') && pkg ? {pkg, locales: req(p, 'locale')} : undefined,
          grant: str(p, 'grant') && pkg && permission ? {pkg, permission} : undefined,
          revoke: str(p, 'revoke') && pkg && permission ? {pkg, permission} : undefined,
        }),
      };
    },

    network: async (p: Params) => {
      const t = await this.#target(str(p, 'device'));
      if (t.platform === 'apple') throw new Error('a simulator shares the Mac\'s network\nhint: use `net` rules on the dev server, or the Network Link Conditioner on the Mac');
      return {serial: t.id, applied: await t.a.network(t.id, req(p, 'profile') as NetworkProfile)};
    },

    screenshot: async (p: Params) => {
      const file = str(p, 'file') ? path.resolve(this.#loaded.root, req(p, 'file')) : path.join(this.#loaded.stateDir, 'shots', `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      const mac = await this.#macTarget(str(p, 'device'));
      const web = mac ? undefined : await this.#webTarget(str(p, 'device'));
      if (mac) {
        const r = await this.#macRunner(mac).call<{png: string}>('png', {}, 20_000);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, Buffer.from(r.png, 'base64'));
        return {serial: `mac:${mac}`, file, bytes: fs.statSync(file).size};
      }
      if (web) {
        const r = await this.#webRunner(web).call<{png: string}>('png', {full: bool(p, 'full')});
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, Buffer.from(r.png, 'base64'));
        return {serial: `web:${web}`, file};
      }
      const t = await this.#target(str(p, 'device'));
      if (t.platform === 'apple') return {udid: t.id, ...(await t.s.screenshot(t.id, file))};
      return {serial: t.id, ...(await t.a.screenshot(t.id, file))};
    },

    key: async (p: Params) => {
      const device = str(p, 'device');
      if ((await this.#macTarget(device)) || (await this.#webTarget(device))) return (await this.ui(device)).key(list(p, 'keys'));
      const t = await this.#target(device);
      if (t.platform === 'apple') return {udid: t.id, ...(await (await this.ui(device)).key(list(p, 'keys')))};
      const keys = list(p, 'keys');
      await t.a.key(t.id, keys);
      return {serial: t.id, keys};
    },

    snapshot: async (p: Params) => {
      const ui = await this.ui(str(p, 'device'));
      const snap = await ui.snapshot({system: bool(p, 'system'), bounds: bool(p, 'bounds')});
      return {lines: snap.lines};
    },

    press: async (p: Params) => (await this.ui(str(p, 'device'))).press(req(p, 'target'), (str(p, 'kind') as 'tap' | 'longpress' | 'doubletap' | undefined) ?? 'tap'),
    fill: async (p: Params) => (await this.ui(str(p, 'device'))).fill(req(p, 'target'), req(p, 'text')),
    type: async (p: Params) => (await this.ui(str(p, 'device'))).type(req(p, 'text')),
    uiKey: async (p: Params) => (await this.ui(str(p, 'device'))).key(list(p, 'keys')),
    mouse: async (p: Params) =>
      (await this.ui(str(p, 'device'))).mouse(req(p, 'action') as 'right' | 'hover' | 'wheel', str(p, 'target'), {direction: str(p, 'direction') as 'up' | 'down' | undefined, steps: num(p, 'steps')}),
    touchpad: async (p: Params) => (await this.ui(str(p, 'device'))).touchpad(req(p, 'gesture') as 'forward' | 'back' | 'up' | 'down' | 'tap'),
    rotary: async (p: Params) => (await this.ui(str(p, 'device'))).rotary((str(p, 'direction') as 'up' | 'down' | undefined) ?? 'down', num(p, 'steps') ?? 3),
    posture: async (p: Params) => {
      const t = await this.#target(str(p, 'device'));
      if (t.platform === 'apple') {
        const r = await t.s.fold(t.id, req(p, 'value'));
        this.#uis.get(t.id)?.screenChanged();
        return r;
      }
      return this.#reshape(str(p, 'device'), 'posture', (a, serial) => a.posture(serial, req(p, 'value')));
    },
    rotate: async (p: Params) => {
      const t = await this.#target(str(p, 'device'));
      if (t.platform === 'apple') {
        // A foldable turns through its motion input, as Xcode's device window does: the runner's orientation
        // would fight it, and the inner screen is wide even upright.
        const sim = (await t.s.simulators()).find(s => s.udid === t.id);
        if (sim?.kind === 'foldable') {
          await t.s.turn(t.id, req(p, 'value'));
          this.#uis.get(t.id)?.screenChanged();
          return {udid: t.id, rotation: req(p, 'value')};
        }
        // The runner turns the device: simctl has no orientation.
        const ui = await this.ui(str(p, 'device'));
        const r = await ui.runner.call<{rotation: string}>('rotate', {value: req(p, 'value')}, 15_000);
        ui.screenChanged();
        return {udid: t.id, rotation: r.rotation};
      }
      return this.#reshape(str(p, 'device'), 'rotate', (a, serial) => a.rotate(serial, req(p, 'value')));
    },
    xr: async (p: Params) => {
      const [op, ...rest] = req(p, 'value').split(/\s+/);
      if (op === 'panel') {
        if ((await this.#target(str(p, 'device'))).platform === 'apple') throw new Error(APPLE_HAS_NO.xr);
        const what = rest[0] ?? '';
        const control = XR_PANEL[what];
        if (!control) throw new Error(`xr panel ${Object.keys(XR_PANEL).join('|')}`);
        const ui = await this.ui(str(p, 'device'));
        const noCaption = 'no app panel caption on screen\nhint: xr panel works on an XR headset with an app open';
        let clicked = control.menu ? await ui.clickSystem(control.id) : undefined;
        if (control.menu && !clicked) {
          // A menu item: open the caption's menu first.
          if (!(await ui.clickSystem(XR_PANEL.menu!.id))) throw new Error(noCaption);
          clicked = await ui.clickSystem(control.id);
          if (!clicked) throw new Error(`the panel menu has no ${what} item`);
        } else if (!control.menu && !(clicked = await ui.clickSystem(control.id))) throw new Error(noCaption);
        // A toggle says which way it went.
        const turned = clicked?.startsWith('disable_') ? 'off' : clicked?.startsWith('enable_') ? 'on' : undefined;
        return {serial: ui.serial, op: `panel ${what}`, ...(turned ? {value: turned} : {})};
      }
      return this.#reshape(str(p, 'device'), 'xr', async (_a, serial) => xrView(serial, op!, rest.join(',')));
    },
    car: async (p: Params) => {
      const [op, ...args] = req(p, 'value').split(' ').filter(Boolean);
      return this.#reshape(str(p, 'device'), 'car', (a, serial) => a.car(serial, op!, args));
    },
    wear: async (p: Params) => {
      const [op, ...args] = req(p, 'value').split(/\s+/);
      return this.#reshape(str(p, 'device'), 'wear', (a, serial) => a.wear(serial, op!, args));
    },
    window: async (p: Params) => {
      const mac = await this.#macTarget(str(p, 'device'));
      if (mac) {
        // A Mac app's window: the one snapshots and input are about from now on (`front` follows the one in front).
        const r = this.#macRunner(mac);
        const value = str(p, 'value')?.trim();
        if (value) {
          const was = r.window;
          r.window = value === 'front' ? undefined : value;
          const info = await r.call<{window: string; width: number; height: number}>('info').catch(e => {
            r.window = was;
            throw e;
          });
          this.#uis.get(`mac:${mac}`)?.screenChanged();
          return {serial: `mac:${mac}`, window: r.window ? info.window : `front: ${info.window}`, size: `${info.width}x${info.height}`};
        }
        return {serial: `mac:${mac}`, selected: r.window ?? 'front', windows: await r.windows()};
      }
      const [mode, ...rest] = req(p, 'value').split(/\s+/);
      return this.#reshape(str(p, 'device'), 'window', (a, serial) => a.window(serial, this.#pkg(p), mode!, rest.join(',') || str(p, 'bounds')));
    },
    touch: async (p: Params) => (await this.ui(str(p, 'device'))).touch(req(p, 'phase') as 'down' | 'move' | 'up', str(p, 'target')),
    swipe: async (p: Params) => (await this.ui(str(p, 'device'))).swipe(req(p, 'direction'), num(p, 'duration') ?? 300),
    scroll: async (p: Params) => (await this.ui(str(p, 'device'))).scrollUntil(str(p, 'direction') ?? 'down', req(p, 'until'), num(p, 'max') ?? 25),

    wait: async (p: Params) => {
      const r = await (await this.ui(str(p, 'device'))).wait(req(p, 'target'), {gone: bool(p, 'gone'), timeoutMs: (num(p, 'timeout') ?? 10) * 1000});
      return {ms: r.ms};
    },

    focus: async (p: Params) => (await this.ui(str(p, 'device'))).focus(),

    focusMap: async (p: Params) => (await this.ui(str(p, 'device'))).focusMap(num(p, 'max') ?? 150),

    visual: async (p: Params) => (await this.ui(str(p, 'device'))).visual(req(p, 'name'), this.#visualDir(), {update: bool(p, 'update'), masks: list(p, 'masks')}),

    media: async (p: Params) => (await this.ui(str(p, 'device'))).media(str(p, 'target'), {count: num(p, 'count'), intervalMs: num(p, 'interval')}),

    uiShot: async (p: Params) => (await this.ui(str(p, 'device'))).screenshot(this.#shotFile(str(p, 'name')), num(p, 'scale') ?? 0.4),

    run: async (p: Params) => {
      const device = str(p, 'device');
      const source = str(p, 'steps') ?? this.#loadFlow(req(p, 'flow'));
      const params = Object.fromEntries(Object.entries((p.params as Params) ?? {}).map(([k, v]) => [k, String(v)]));
      return runFlow(this.#flowHost(device), source, params, 0, num(p, 'from') ?? 0);
    },

    matrix: async (p: Params) => {
      const m = this.config.matrix ?? {};
      const source = str(p, 'steps') ?? this.#loadFlow(req(p, 'flow'));
      const params = Object.fromEntries(Object.entries((p.params as Params) ?? {}).map(([k, v]) => [k, String(v)]));
      const dims: [string, unknown[]][] = (
        [
          ['device', m.devices],
          ['fontScale', m.fontScale],
          ['dark', m.dark],
          ['locale', m.locale],
        ] as [string, unknown[] | undefined][]
      ).filter((d): d is [string, unknown[]] => !!d[1]?.length);
      let combos: Record<string, unknown>[] = [{}];
      for (const [k, values] of dims) combos = combos.flatMap(c => values.map(v => ({...c, [k]: v})));
      const pkg = this.config.app?.android;
      const results: {variant: string; ok: boolean; ms: number; failed?: string}[] = [];
      // Each variant's settings through the device's own driver: an emulator or a simulator.
      const apply = async (device: string | undefined, v: {fontScale?: number; dark?: boolean; locale?: string}, reset = false) => {
        const t = await this.#target(device);
        if (t.platform === 'apple') {
          // A simulator's language has no "app default" to go back to: the matrix leaves the last one set.
          await t.s.settings(t.id, {fontScale: v.fontScale, dark: v.dark, locale: reset ? undefined : v.locale});
          return t.id;
        }
        await t.a.settings(t.id, {fontScale: v.fontScale, dark: v.dark, locale: v.locale !== undefined && pkg ? {pkg, locales: v.locale} : undefined});
        return t.id;
      };
      for (const combo of combos) {
        const variant = Object.entries(combo).map(([k, v]) => (k === 'device' ? String(v) : `${k}-${v}`)).join('_') || 'default';
        // The config's devices, else the one asked for, else the only one online.
        const device = (combo.device as string | undefined) ?? str(p, 'device');
        const id = await apply(device, {fontScale: combo.fontScale as number | undefined, dark: combo.dark as boolean | undefined, locale: combo.locale as string | undefined});
        const r = await runFlow(this.#flowHost(device ?? id, variant), source, params);
        results.push({variant, ok: r.ok, ms: r.ms, failed: r.failed ? `line ${r.failed.line}: ${r.failed.error.split('\n')[0]}` : undefined});
      }
      // Back to defaults on every device the matrix touched.
      for (const d of new Set(combos.map(c => (c.device as string | undefined) ?? str(p, 'device')))) {
        await apply(d, {fontScale: m.fontScale ? 1 : undefined, dark: m.dark ? false : undefined, locale: m.locale ? '""' : undefined}, true).catch(() => undefined);
      }
      return {results, shots: path.join(this.#loaded.stateDir, 'shots')};
    },

    goto: async (p: Params) => {
      const params = Object.fromEntries(Object.entries((p.params as Params) ?? {}).map(([k, v]) => [k, String(v)]));
      return {url: await this.#goto(str(p, 'device'), req(p, 'route'), params)};
    },

    as: async (p: Params) => runFlow(this.#flowHost(str(p, 'device')), this.#loadFlow(this.#needSignIn()), {user: req(p, 'user')}),

    stateList: async () => ({states: this.#states().list()}),

    stateSave: async (p: Params) => {
      const {snap} = await this.#stateDevice(str(p, 'device'));
      return this.#states().save(req(p, 'name'), snap);
    },

    stateRestore: async (p: Params) => {
      const {snap, serial} = await this.#stateDevice(str(p, 'device'));
      const r = await this.#states().restore(req(p, 'name'), snap);
      if (serial && r.device) await this.#afterRestore(serial);
      return r;
    },

    stateDelete: async (p: Params) => {
      const {snap} = await this.#stateDevice(str(p, 'device'));
      await this.#states().remove(req(p, 'name'), snap);
      return {deleted: req(p, 'name')};
    },

    recordStart: async (p: Params) => {
      const ui = await this.ui(str(p, 'device'));
      ui.recording = [];
      return {recording: true};
    },

    recordStop: async (p: Params) => {
      const ui = await this.ui(str(p, 'device'));
      const lines = ui.recording ?? [];
      ui.recording = undefined;
      const name = str(p, 'name');
      if (!name) return {lines};
      const file = path.resolve(this.#flowsDir(), name.endsWith('.flow') ? name : `${name}.flow`);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
      return {file, lines};
    },

    reverse: async () => {
      const applied = await this.ensureForwards(true);
      const devices = ((await this.android?.devices().catch(() => [])) ?? []).filter(d => d.state === 'device').length;
      return {applied, ports: exposedPorts(this.config), devices};
    },

    // Frames and memory from the device; with a dev server, the JS thread's profile over the same window.
    perf: async (p: Params) => {
      const t = await this.#target(str(p, 'device'));
      const reset = bool(p, 'reset');
      const device: Record<string, unknown> = t.platform === 'apple' ? await t.s.perf(t.id, this.#bundleId(p), reset) : await t.a.perf(t.id, this.#pkg(p), reset);
      // The platform trace (opt-in: it costs the device some speed while it runs) over the same window.
      if (t.platform === 'android') {
        const pkg = this.#pkg(p);
        if (this.#tracing.has(t.id)) {
          this.#tracing.delete(t.id);
          const summary = await t.a.traceStop(t.id, pkg).catch(e => ({note: `no trace: ${(e as Error).message}`}));
          if (!reset) device.trace = summary;
        }
        if (reset && bool(p, 'trace')) {
          await t.a.traceStart(t.id, pkg);
          this.#tracing.add(t.id);
          device.tracing = true;
        }
      } else if (reset && bool(p, 'trace')) device.tracing = 'no platform trace on Apple simulators';
      const dev = this.#dev;
      if (!dev) return device;
      // React commits come from the in-app script of the target's app: with apps on two platforms, its own.
      const platform = t.platform === 'apple' ? 'ios' : 'android';
      const renders = async (q: Record<string, unknown>) => {
        if (!dev.proxy.listening) return undefined;
        const answers = await dev.proxy.query<Record<string, unknown>>('renders', q, 2000);
        return (answers.find(a => a.app.hello?.platform === platform) ?? answers[0])?.data;
      };
      if (reset) {
        const [jsProfiling, react] = await Promise.all([dev.js.profileStart(await this.#jsDevice(str(p, 'device'))).catch(() => false), renders({start: true}).catch(() => undefined)]);
        return {...device, jsProfiling, reactRecording: !!react?.started && react.react !== false};
      }
      const [js, react] = await Promise.all([
        dev.js.profileStop().catch(e => ({ms: 0, busyMs: 0, samples: 0, self: [], app: [], note: `no JS profile: ${(e as Error).message}`})),
        renders({stop: true}).catch(() => undefined),
      ]);
      return {...device, js, react: react && !react.error ? react : undefined};
    },

    info: async (p: Params) => {
      const mac = await this.#macTarget(str(p, 'device'));
      if (mac) {
        const r = this.#macRunner(mac);
        const perms = await r.permissions();
        const pid = (await r.call<{pid?: number}>('pid')).pid;
        const win = pid && perms.accessibility ? await r.call<{window: string; width: number; height: number}>('info').catch(() => undefined) : undefined;
        return {
          serial: `mac:${mac}`,
          app: r.cfg.app,
          state: pid ? `running (pid ${pid})` : 'not running',
          ...(win ? {window: `${win.window} ${win.width}x${win.height}`} : {}),
          selected: r.window ?? 'front',
          accessibility: perms.accessibility ? 'granted' : `off for ${perms.host}`,
          screenRecording: perms.screen ? 'granted' : `off for ${perms.host}`,
        };
      }
      const t = await this.#target(str(p, 'device'));
      if (t.platform === 'apple') return {udid: t.id, ...(await t.s.info(t.id))};
      return {serial: t.id, ...(await t.a.info(t.id))};
    },

    doctor: async (p: Params) => {
      const extra = await loadProjectRules(this.#loaded.root, this.config.doctor);
      return runDoctor(
        {root: this.#loaded.root, config: this.config, services: this.services, android: this.android, exposedPorts: exposedPorts(this.config), forwardHealth: () => this.forwardHealth(),
          useRelay: serial => this.useRelay(serial),
          systemDialogs: async () => {
            const out: {serial: string; title: string}[] = [];
            for (const d of (await this.android?.devices().catch(() => [])) ?? []) {
              if (d.state !== 'device') continue;
              const ui = await this.ui(d.serial);
              const title = ui.systemDialog(await ui.snapshot({system: true}));
              if (title) out.push({serial: d.serial, title});
            }
            return out;
          },
          dismissDialog: async serial => (await (await this.ui(serial)).dismissSystemDialog()) ?? 'no dialog',
          macPermissions: this.config.mac && process.platform === 'darwin' ? () => this.#macRunner(Object.keys(this.config.mac!)[0]!).permissions() : undefined,
        },
        {fix: bool(p, 'fix'), only: list(p, 'only'), extra},
      );
    },

    docs: async (p: Params) => {
      const docs = this.config.docs ?? {};
      const name = str(p, 'name');
      if (!name) return {docs: Object.keys(docs)};
      const rel = docs[name];
      if (!rel) throw new Error(`unknown doc: ${name} (known: ${Object.keys(docs).join(', ') || 'none'})`);
      const text = readDoc(path.resolve(this.#loaded.root, rel));
      const op = str(p, 'op') ?? 'toc';
      switch (op) {
        case 'toc':
          return {lines: toc(text, num(p, 'depth') ?? 3)};
        case 'section':
          return {lines: section(text, req(p, 'query'), num(p, 'maxLines') ?? 120)};
        case 'grep':
          return {lines: grep(text, req(p, 'query'), num(p, 'context') ?? 0, num(p, 'max') ?? 30)};
        case 'lines':
          return {lines: lineRange(text, num(p, 'from') ?? 1, num(p, 'to') ?? (num(p, 'from') ?? 1) + 40)};
        default:
          throw new Error(`unknown docs op: ${op} (toc, section, grep, lines)`);
      }
    },
  };
}
