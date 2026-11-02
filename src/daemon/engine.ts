// The engine the daemon serves: config, stand, Android driver, doctor and docs behind one method table.
// The CLI and the MCP server call these methods over the daemon's RPC.

import crypto from 'node:crypto';
import QRCode from 'qrcode';
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
import {runFlow, type FlowHost} from '../flows/run.ts';
import {fillRoute} from '../flows/flow.ts';
import {AndroidUi} from '../ui/android.ts';
import {lanAddress} from '../util/lan.ts';
import {httpAlive} from '../util/net.ts';

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
  readonly #uis = new Map<string, AndroidUi>();
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

  /** The UI session of a device (one runner per device, kept between calls). */
  async ui(device?: string): Promise<AndroidUi> {
    const a = this.#needAndroid();
    const serial = await a.resolve(device);
    let ui = this.#uis.get(serial);
    if (!ui) {
      ui = new AndroidUi(a, serial, {
        beforeAction: () => {
          const proxy = this.#dev?.proxy;
          if (!proxy || !proxy.apps().length) return undefined;
          const id = crypto.randomBytes(16).toString('hex');
          proxy.setTrace(id);
          return id;
        },
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
      }, this.config.app?.android);
      this.#uis.set(serial, ui);
    }
    return ui;
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

  #flowHost(device?: string): FlowHost {
    return {
      ui: () => this.ui(device),
      open: async (target, relaunch) => {
        await this.methods.open({device, target, relaunch});
        (await this.ui(device)).record(`open${relaunch ? '!' : ''}${target ? ` ${JSON.stringify(target)}` : ''}`);
      },
      goto: async (route, params) => {
        await this.#goto(device, route, params);
      },
      signIn: user => runFlow(this.#flowHost(device), this.#loadFlow(this.#needSignIn()), {user}),
      tool: (name, params) => this.methods.tool({name, params}) as Promise<{code: number | null; output: string}>,
      loadFlow: name => this.#loadFlow(name),
      screenshot: async name => (await (await this.ui(device)).screenshot(this.#shotFile(name))).file,
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
        continue;
      }
      const have = await android.reverseList(d.serial);
      const missing = ports.filter(p => !have.includes(p));
      if (missing.length) {
        await android.reverse(d.serial, missing);
        applied.push({serial: d.serial, ports: missing});
      }
      this.#forwarded.add(d.serial);
      // `adb reverse` can list its forwards and carry nothing; on an emulator, switch to the relay then.
      if (mode === 'auto' && d.emulator && verify && !(await this.#forwardCarries(d.serial, ports))) {
        this.#relayed.add(d.serial);
        this.#forwarded.delete(d.serial);
        applied.push(...(await this.ensureForwards(true)).filter(a => a.serial === d.serial));
      }
    }
    return applied;
  }

  /** Serials whose forwards go through the runner's relay instead of `adb reverse`. */
  readonly #relayed = new Set<string>();

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
      return out.trim().length > 0;
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
      return this.#dev.freshness();
    },

    appLog: async (p: Params) => {
      if (!this.#dev) throw new Error('no devserver in the config');
      const answers = await this.#dev.proxy.query<Record<string, unknown>[]>('log', {limit: num(p, 'limit') ?? 30});
      return {apps: answers.map(a => ({app: a.app.id, platform: a.app.hello?.platform, entries: a.data}))};
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
      // Without a target, open the app through its connect link when there is one: it then always talks to this
      // dev server, whatever a launcher remembered.
      const target = str(p, 'target') ?? this.connectUrl() ?? this.#pkg(p);
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

    snapshot: async (p: Params) => {
      const ui = await this.ui(str(p, 'device'));
      const snap = await ui.snapshot({system: bool(p, 'system'), bounds: bool(p, 'bounds')});
      return {lines: snap.lines};
    },

    press: async (p: Params) => (await this.ui(str(p, 'device'))).press(req(p, 'target'), (str(p, 'kind') as 'tap' | 'longpress' | 'doubletap' | undefined) ?? 'tap'),
    fill: async (p: Params) => (await this.ui(str(p, 'device'))).fill(req(p, 'target'), req(p, 'text')),
    type: async (p: Params) => (await this.ui(str(p, 'device'))).type(req(p, 'text')),
    uiKey: async (p: Params) => (await this.ui(str(p, 'device'))).key(list(p, 'keys')),
    touch: async (p: Params) => (await this.ui(str(p, 'device'))).touch(req(p, 'phase') as 'down' | 'move' | 'up', str(p, 'target')),
    swipe: async (p: Params) => (await this.ui(str(p, 'device'))).swipe(req(p, 'direction'), num(p, 'duration') ?? 300),
    scroll: async (p: Params) => (await this.ui(str(p, 'device'))).scrollUntil(str(p, 'direction') ?? 'down', req(p, 'until'), num(p, 'max') ?? 8),

    wait: async (p: Params) => {
      const r = await (await this.ui(str(p, 'device'))).wait(req(p, 'target'), {gone: bool(p, 'gone'), timeoutMs: (num(p, 'timeout') ?? 10) * 1000});
      return {ms: r.ms};
    },

    focus: async (p: Params) => (await this.ui(str(p, 'device'))).focus(),

    focusMap: async (p: Params) => (await this.ui(str(p, 'device'))).focusMap(num(p, 'max') ?? 150),

    media: async (p: Params) => (await this.ui(str(p, 'device'))).media(str(p, 'target'), {count: num(p, 'count'), intervalMs: num(p, 'interval')}),

    uiShot: async (p: Params) => (await this.ui(str(p, 'device'))).screenshot(this.#shotFile(str(p, 'name')), num(p, 'scale') ?? 0.4),

    run: async (p: Params) => {
      const device = str(p, 'device');
      const source = str(p, 'steps') ?? this.#loadFlow(req(p, 'flow'));
      const params = Object.fromEntries(Object.entries((p.params as Params) ?? {}).map(([k, v]) => [k, String(v)]));
      return runFlow(this.#flowHost(device), source, params);
    },

    goto: async (p: Params) => {
      const params = Object.fromEntries(Object.entries((p.params as Params) ?? {}).map(([k, v]) => [k, String(v)]));
      return {url: await this.#goto(str(p, 'device'), req(p, 'route'), params)};
    },

    as: async (p: Params) => runFlow(this.#flowHost(str(p, 'device')), this.#loadFlow(this.#needSignIn()), {user: req(p, 'user')}),

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

    reverse: async () => ({applied: await this.ensureForwards(true), ports: exposedPorts(this.config)}),

    info: async (p: Params) => {
      const a = this.#needAndroid();
      const serial = await a.resolve(str(p, 'device'));
      return {serial, ...(await a.info(serial))};
    },

    doctor: async (p: Params) => {
      const extra = await loadProjectRules(this.#loaded.root, this.config.doctor);
      return runDoctor(
        {root: this.#loaded.root, config: this.config, services: this.services, android: this.android, exposedPorts: exposedPorts(this.config), forwardHealth: () => this.forwardHealth(), useRelay: serial => this.useRelay(serial)},
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
