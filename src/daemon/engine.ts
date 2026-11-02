// The engine the daemon serves: config, stand, Android driver, doctor and docs behind one method table.
// The CLI and the MCP server call these methods over the daemon's RPC.

import fs from 'node:fs';
import path from 'node:path';
import {loadConfig, resolveFrom, type LoadedConfig} from '../config/load.ts';
import {exposedPorts, type ServiceConfig} from '../config/schema.ts';
import {DEVSERVER, DevServer} from '../devserver/devserver.ts';
import {AndroidDriver, type NetworkProfile} from '../drivers/android/driver.ts';
import {lineRange, grep, readDoc, section, toc} from '../docs/docs.ts';
import {loadProjectRules, runDoctor} from '../doctor/run.ts';
import {ActorManager} from '../stand/actors.ts';
import {LlmMock} from '../stand/llmMock.ts';
import {ServiceManager} from '../stand/services.ts';
import {describeTool, runTool} from '../stand/tools.ts';

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

export class Engine {
  #loaded: LoadedConfig;
  #mtime: number;
  readonly services: ServiceManager;
  readonly actors: ActorManager;
  #mock?: LlmMock;
  #android?: AndroidDriver | null;
  /** Serials whose port forwards were applied since they came online. */
  readonly #forwarded = new Set<string>();
  #watchTimer?: NodeJS.Timeout;
  #lastForwardCheck = 0;
  #dev?: DevServer;
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

  /** Brings the proxy up once the bundler answers, then prewarms. */
  async #devUp(prewarm: boolean) {
    const dev = this.#dev;
    if (!dev) return undefined;
    const st = (await this.services.status()).find(s => s.name === DEVSERVER);
    if (st?.status !== 'up' && st?.status !== 'external') return undefined;
    if (!dev.proxy.listening) await dev.start();
    return prewarm ? dev.prewarm() : undefined;
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
    const applied: {serial: string; ports: number[]}[] = [];
    for (const d of online) {
      if (this.#forwarded.has(d.serial) && !verify) continue;
      const have = await android.reverseList(d.serial);
      const missing = ports.filter(p => !have.includes(p));
      if (missing.length) {
        await android.reverse(d.serial, missing);
        applied.push({serial: d.serial, ports: missing});
      }
      this.#forwarded.add(d.serial);
    }
    return applied;
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
      const [services, devices] = await Promise.all([this.services.status(), this.android ? this.android.devices().catch(() => []) : Promise.resolve([])]);
      return {
        services,
        actors: this.actors.list(),
        mock: this.config.mocks?.llm ? {port: this.config.mocks.llm.port, running: this.#mock?.running ?? false, requests: this.#mock?.requests ?? 0} : undefined,
        devices,
        exposed: exposedPorts(this.config),
        dev: this.#dev?.status(),
      };
    },

    up: async (p: Params) => {
      const names = list(p, 'services');
      const mock = names.length ? undefined : await this.#startMock();
      const services = await this.services.up(names);
      const prewarm = !names.length || names.includes(DEVSERVER) ? await this.#devUp(true) : undefined;
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
      const services = await this.services.restart(names);
      const prewarm = names.includes(DEVSERVER) ? await this.#devUp(true) : undefined;
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

    devReload: async () => {
      if (!this.#dev) throw new Error('no devserver in the config');
      await this.#dev.reload();
      return {reloaded: true};
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
      const params = Object.fromEntries(Object.entries((p.params as Params) ?? {}).map(([k, v]) => [k, String(v)]));
      return runTool({root: this.#loaded.root, stateDir: this.#loaded.stateDir, shell: this.config.shell}, name, tool, params, num(p, 'maxChars') ?? 6000);
    },

    actorTypes: async () => this.actors.types(),
    actors: async () => this.actors.list(),
    actorStart: async (p: Params) => this.actors.start(req(p, 'type'), req(p, 'name'), num(p, 'port')),
    actorStop: async (p: Params) => this.actors.stop(req(p, 'name')),
    actorCall: async (p: Params) => this.actors.call(req(p, 'name'), p.body),

    devices: async () => {
      const a = this.#needAndroid();
      return {devices: await a.devices(), avds: a.avds()};
    },

    boot: async (p: Params) => {
      const avd = str(p, 'avd') ?? this.config.android?.avd;
      if (!avd) throw new Error('no AVD: pass avd or set android.avd in the config');
      const r = await this.#needAndroid().boot(avd, {wipe: bool(p, 'wipe'), headless: bool(p, 'headless'), coldBoot: bool(p, 'coldBoot')});
      const forwards = await this.ensureForwards(true).catch(() => []);
      return {...r, avd, forwards};
    },

    shutdown: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      return {serial, ...(await a.shutdown(serial))};
    },

    install: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      const apk = path.resolve(this.#loaded.root, req(p, 'apk'));
      return {serial, ...(await a.install(serial, apk, {replace: bool(p, 'replace'), pkg: str(p, 'pkg') ?? this.config.app?.android}))};
    },

    open: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      const target = str(p, 'target') ?? this.#pkg(p);
      return {serial, target, ...(await a.open(serial, target, {relaunch: bool(p, 'relaunch'), pkg: str(p, 'pkg') ?? this.config.app?.android}))};
    },

    stopApp: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      await a.stop(serial, this.#pkg(p));
      return {serial};
    },

    clearApp: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      await a.clear(serial, this.#pkg(p));
      return {serial};
    },

    uninstall: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      await a.uninstall(serial, this.#pkg(p));
      return {serial};
    },

    apps: async (p: Params) => {
      const a = this.#needAndroid();
      return {packages: await a.packages(await a.resolve(str(p, 'device')), str(p, 'filter'))};
    },

    appLogs: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      const all = bool(p, 'all');
      return {lines: await a.logs(serial, {pkg: all ? undefined : (str(p, 'pkg') ?? this.config.app?.android), lines: num(p, 'lines') ?? 50, grep: str(p, 'grep'), level: str(p, 'level')})};
    },

    settings: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
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
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      return {serial, applied: await a.network(serial, req(p, 'profile') as NetworkProfile)};
    },

    screenshot: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      const file = str(p, 'file') ? path.resolve(this.#loaded.root, req(p, 'file')) : path.join(this.#loaded.stateDir, 'shots', `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      return {serial, ...(await a.screenshot(serial, file))};
    },

    key: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      const keys = list(p, 'keys');
      await a.key(serial, keys);
      return {serial, keys};
    },

    reverse: async () => ({applied: await this.ensureForwards(true), ports: exposedPorts(this.config)}),

    info: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      return {serial, ...(await a.info(serial))};
    },

    doctor: async (p: Params) => {
      const extra = await loadProjectRules(this.#loaded.root, this.config.doctor);
      return runDoctor({root: this.#loaded.root, config: this.config, services: this.services, android: this.android, exposedPorts: exposedPorts(this.config)}, {fix: bool(p, 'fix'), only: list(p, 'only'), extra});
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
