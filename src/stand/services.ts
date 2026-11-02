// Services of the stand: started in dependency order, adopted when something already answers the probe,
// supervised, logged to files, stopped as whole process trees.

import fs from 'node:fs';
import path from 'node:path';
import type {ChildProcess} from 'node:child_process';
import type {ServiceConfig} from '../config/schema.ts';
import {asArray} from '../config/schema.ts';
import {isAlive, killTree, killTreeAndWait, runShell, spawnShell} from '../util/proc.ts';
import {tailLines} from '../util/text.ts';
import {checkProbe, waitForProbe} from './health.ts';

export type ServiceStatus = 'stopped' | 'starting' | 'up' | 'external' | 'down' | 'failed';

export type ServiceState = {
  name: string;
  status: ServiceStatus;
  /** Set when pitbox started the process itself. */
  pid?: number;
  startedAt?: number;
  /** Probe or failure detail. */
  detail?: string;
  /** How long the last start took until healthy, ms. */
  startMs?: number;
  /** Started by a command that exited after launching it in the background (pitbox has no pid). */
  detached?: boolean;
  expose: number[];
};

export type StandContext = {root: string; stateDir: string; shell?: string; env?: NodeJS.ProcessEnv};

/** Dependency order for the requested services (dependencies first); throws on unknown names and cycles. */
export const orderServices = (services: Record<string, ServiceConfig>, requested: string[]): string[] => {
  const out: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, chain: string[]) => {
    const svc = services[name];
    if (!svc) throw new Error(`unknown service: ${name}${chain.length ? ` (needed by ${chain[chain.length - 1]})` : ''}`);
    const s = state.get(name);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`dependency cycle: ${[...chain, name].join(' → ')}`);
    state.set(name, 'visiting');
    for (const dep of svc.dependsOn ?? []) visit(dep, [...chain, name]);
    state.set(name, 'done');
    out.push(name);
  };
  for (const name of requested) visit(name, []);
  return out;
};

export class ServiceManager {
  readonly #ctx: StandContext;
  #services: Record<string, ServiceConfig>;
  readonly #children = new Map<string, ChildProcess>();
  readonly #state = new Map<string, ServiceState>();
  readonly #pidFile: string;

  constructor(ctx: StandContext, services: Record<string, ServiceConfig>) {
    this.#ctx = ctx;
    this.#services = services;
    this.#pidFile = path.join(ctx.stateDir, 'pids.json');
    fs.mkdirSync(this.logDir, {recursive: true});
    this.#recoverPids();
  }

  get logDir() {
    return path.join(this.#ctx.stateDir, 'logs');
  }

  logFile(name: string) {
    return path.join(this.logDir, `${name}.log`);
  }

  /** Swaps in a reloaded config; running processes are kept. */
  setServices(services: Record<string, ServiceConfig>) {
    this.#services = services;
  }

  names() {
    return Object.keys(this.#services);
  }

  #cwd(svc: ServiceConfig) {
    return svc.cwd ? path.resolve(this.#ctx.root, svc.cwd) : this.#ctx.root;
  }

  #recoverPids() {
    try {
      const pids = JSON.parse(fs.readFileSync(this.#pidFile, 'utf8')) as Record<string, {pid: number; startedAt: number}>;
      for (const [name, {pid, startedAt}] of Object.entries(pids)) {
        if (this.#services[name] && isAlive(pid)) {
          this.#state.set(name, {name, status: 'up', pid, startedAt, expose: asArray(this.#services[name].expose), detail: 'recovered'});
        }
      }
    } catch {
      // no state yet
    }
  }

  #savePids() {
    const pids: Record<string, {pid: number; startedAt: number}> = {};
    for (const s of this.#state.values()) if (s.pid && s.startedAt && (s.status === 'up' || s.status === 'starting')) pids[s.name] = {pid: s.pid, startedAt: s.startedAt};
    fs.mkdirSync(this.#ctx.stateDir, {recursive: true});
    fs.writeFileSync(this.#pidFile, JSON.stringify(pids, null, 2));
  }

  #set(name: string, patch: Partial<ServiceState>) {
    const svc = this.#services[name];
    const prev = this.#state.get(name) ?? {name, status: 'stopped' as const, expose: asArray(svc?.expose)};
    const next = {...prev, ...patch, name, expose: asArray(svc?.expose)};
    this.#state.set(name, next);
    return next;
  }

  async status(): Promise<ServiceState[]> {
    return Promise.all(
      this.names().map(async name => {
        const svc = this.#services[name]!;
        const known = this.#state.get(name);
        if (known?.status === 'starting') return known;
        const ours = (known?.pid !== undefined && isAlive(known.pid)) || known?.detached === true;
        if (!svc.health) {
          return this.#set(name, ours ? {status: 'up', detail: 'running (no probe)'} : {status: 'stopped', pid: undefined, detail: svc.start ? undefined : 'no probe, no start'});
        }
        const probe = await checkProbe(svc.health, {cwd: this.#cwd(svc), shell: this.#ctx.shell});
        if (probe.ok) return this.#set(name, {status: ours ? 'up' : 'external', detail: probe.detail, ...(ours ? {} : {pid: undefined})});
        if (ours) return this.#set(name, {status: 'down', detail: known?.detached ? `probe failing: ${probe.detail}` : `process alive, probe failing: ${probe.detail}`});
        return this.#set(name, {status: known?.status === 'failed' ? 'failed' : 'stopped', pid: undefined, detail: known?.status === 'failed' ? known.detail : probe.detail});
      }),
    );
  }

  /** Brings services up (all autostart ones when `names` is empty), dependencies first. */
  async up(names: string[] = []): Promise<ServiceState[]> {
    const requested = names.length ? names : this.names().filter(n => this.#services[n]!.autostart !== false);
    const order = orderServices(this.#services, requested);
    const results: ServiceState[] = [];
    for (const name of order) {
      const result = await this.#upOne(name);
      results.push(result);
      if (result.status === 'failed' || result.status === 'down') {
        const rest = order.slice(order.indexOf(name) + 1);
        for (const r of rest) results.push(this.#set(r, {status: 'stopped', detail: `skipped: ${name} failed`}));
        break;
      }
    }
    return results;
  }

  async #upOne(name: string): Promise<ServiceState> {
    const svc = this.#services[name]!;
    const cwd = this.#cwd(svc);
    const known = this.#state.get(name);
    if (svc.health) {
      const probe = await checkProbe(svc.health, {cwd, shell: this.#ctx.shell});
      if (probe.ok) {
        const ours = (known?.pid !== undefined && isAlive(known.pid)) || known?.detached === true;
        return this.#set(name, {status: ours ? 'up' : 'external', detail: probe.detail});
      }
    } else if (known?.pid !== undefined && isAlive(known.pid)) {
      return this.#set(name, {status: 'up', detail: 'running (no probe)'});
    }
    if (!svc.start) {
      return this.#set(name, {status: 'failed', detail: `not answering (${svc.health ?? 'no probe'}) and no start command`});
    }

    const logFile = this.logFile(name);
    const log = fs.createWriteStream(logFile, {flags: 'a'});
    log.write(`\n--- pitbox start ${new Date().toISOString()} :: ${svc.start}\n`);
    const t0 = Date.now();
    const child = spawnShell(svc.start, {
      cwd,
      env: {...process.env, ...this.#ctx.env, ...svc.env, FORCE_COLOR: '0'},
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: this.#ctx.shell,
    });
    child.stdout?.pipe(log, {end: false});
    child.stderr?.pipe(log, {end: false});
    // A start command that exits with 0 launched something in the background (`docker compose up -d`): keep
    // waiting for the probe. Any other exit before the service is healthy is a failure.
    let failedExit: string | undefined;
    let detachedStart = false;
    child.on('exit', (code, signal) => {
      const how = `exited with ${signal ?? code}`;
      log.write(`--- pitbox: process ${how}\n`);
      this.#children.delete(name);
      const cur = this.#state.get(name);
      const starting = cur?.status === 'starting';
      if (starting && code === 0 && svc.health) {
        detachedStart = true;
        this.#set(name, {pid: undefined, detached: true});
        this.#savePids();
        return;
      }
      if (starting) failedExit = how;
      if (cur && cur.pid === child.pid && cur.status !== 'stopped') {
        this.#set(name, {status: starting ? 'failed' : 'down', detail: how, pid: undefined});
        this.#savePids();
      }
    });
    this.#children.set(name, child);
    this.#set(name, {status: 'starting', pid: child.pid, startedAt: t0, detail: undefined, detached: false});
    this.#savePids();

    if (!svc.health) {
      await new Promise(r => setTimeout(r, 1500));
      if (failedExit) return this.#failed(name, failedExit);
      return this.#set(name, {status: 'up', startMs: Date.now() - t0, detail: 'running (no probe)'});
    }
    const probe = await waitForProbe(svc.health, (svc.startTimeout ?? 120) * 1000, {cwd, shell: this.#ctx.shell, abort: () => failedExit});
    if (!probe.ok) {
      if (!failedExit && !detachedStart) killTree(child);
      return this.#failed(name, probe.detail);
    }
    return this.#set(name, {status: 'up', startMs: Date.now() - t0, detail: probe.detail});
  }

  #failed(name: string, detail: string) {
    const tail = this.logTail(name, 12).join('\n');
    const state = this.#set(name, {status: 'failed', detail: tail ? `${detail}\n${tail}` : detail, pid: undefined});
    this.#savePids();
    return state;
  }

  /** Stops what pitbox started; runs `stop` commands; leaves external processes alone unless they have one. */
  async down(names: string[] = []): Promise<ServiceState[]> {
    const targets = (names.length ? orderServices(this.#services, names) : this.names()).reverse();
    const results: ServiceState[] = [];
    for (const name of targets) {
      const svc = this.#services[name]!;
      const known = this.#state.get(name);
      let detail: string;
      if (known?.pid !== undefined && isAlive(known.pid)) {
        this.#set(name, {status: 'stopped'});
        const gone = await killTreeAndWait(known.pid);
        detail = gone ? `killed pid ${known.pid}` : `pid ${known.pid} did not exit`;
      } else if (svc.stop) {
        detail = 'ran stop';
      } else {
        const st = (await this.status()).find(s => s.name === name);
        detail = st?.status === 'external' ? 'left running (not started by pitbox)' : 'not running';
        results.push(this.#set(name, {detail}));
        continue;
      }
      if (svc.stop) {
        const r = await runShell(svc.stop, {cwd: this.#cwd(svc), shell: this.#ctx.shell, timeoutMs: 60000});
        if (r.code !== 0) detail += `; stop exited ${r.code}: ${r.stderr.trim().split('\n').pop() ?? ''}`;
      }
      results.push(this.#set(name, {status: 'stopped', pid: undefined, detached: false, detail}));
    }
    this.#savePids();
    return results;
  }

  async restart(names: string[]): Promise<ServiceState[]> {
    await this.down(names);
    return this.up(names);
  }

  logTail(name: string, lines = 40, grep?: string): string[] {
    if (!this.#services[name]) throw new Error(`unknown service: ${name}`);
    try {
      const file = this.logFile(name);
      const size = fs.statSync(file).size;
      // Read only the end of big logs.
      const fd = fs.openSync(file, 'r');
      const len = Math.min(size, grep ? 4_000_000 : 400_000);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      return tailLines(buf.toString('utf8'), lines, grep);
    } catch {
      return [];
    }
  }

  /** Stops every process pitbox started (daemon shutdown). */
  killAll() {
    for (const s of this.#state.values()) if (s.pid && isAlive(s.pid)) killTree(s.pid);
  }
}
