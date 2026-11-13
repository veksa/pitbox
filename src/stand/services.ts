// Services of the stand: started in dependency order, adopted when something of this project already answers the
// probe, supervised, logged to files, stopped as whole process trees.

import fs from 'node:fs';
import path from 'node:path';
import type {ServiceConfig} from '../config/schema.ts';
import {asArray} from '../config/schema.ts';
import {portListener, withinFolder} from '../util/net.ts';
import {isAlive, killTree, killTreeAndWait, liveTree, run, runShell, startService, type ServiceProcess} from '../util/proc.ts';
import {tailLines} from '../util/text.ts';
import {checkProbe, localProbePort, waitForProbe} from './health.ts';

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

/**
 * What stopping `names` takes: those services and everything that depends on them, dependents first.
 * Their own dependencies keep running — stopping the API must not stop the database.
 */
export const stopOrder = (services: Record<string, ServiceConfig>, names: string[]): string[] => {
  for (const n of names) if (!services[n]) throw new Error(`unknown service: ${n}`);
  const affected = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, svc] of Object.entries(services)) {
      if (!affected.has(name) && (svc.dependsOn ?? []).some(d => affected.has(d))) {
        affected.add(name);
        grew = true;
      }
    }
  }
  return orderServices(services, [...affected]).filter(n => affected.has(n)).reverse();
};

/**
 * What restarting `names` starts again: those services, and every dependent that stopping them took down
 * while it was running. A dependent that was not running stays down.
 */
export const restartOrder = (services: Record<string, ServiceConfig>, names: string[], running: Set<string>): string[] =>
  stopOrder(services, names).filter(n => names.includes(n) || running.has(n)).reverse();

/** The repository a folder belongs to (the nearest parent with `.git`), or the folder itself outside one. */
export const projectRoot = (dir: string): string => {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return path.resolve(dir);
  }
};

/**
 * Processes that listen for a container or VM runtime (Docker Desktop, Colima/Lima, OrbStack, Podman, an `ssh -L`
 * tunnel). Their folder is wherever the runtime was started, which says nothing about whose container answers.
 */
const PORT_FORWARDER = /^(com\.docker\..*|docker.*|vpnkit.*|limactl|lima.*|ssh|colima|orbstack.*|gvproxy|vfkit|krunkit|podman.*|qemu-system-.*|rancher.*|rd-.*)$/i;

export const isPortForwarder = (command: string): boolean => PORT_FORWARDER.test(path.basename(command.trim()));

const processCommand = async (pid: number): Promise<{name: string; args: string}> => {
  const [name, args] = await Promise.all([run('ps', ['-o', 'comm=', '-p', String(pid)], {timeoutMs: 5000}), run('ps', ['-o', 'args=', '-p', String(pid)], {timeoutMs: 5000})]);
  const full = args.stdout.trim();
  return {name: name.stdout.trim(), args: full.length > 100 ? `${full.slice(0, 97)}...` : full};
};

export class ServiceManager {
  readonly #ctx: StandContext;
  #services: Record<string, ServiceConfig>;
  readonly #children = new Map<string, ServiceProcess>();
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

  /** A service as the stand runs it: the config's, or one the engine adds (the dev server). */
  definition(name: string): ServiceConfig | undefined {
    return this.#services[name];
  }

  #cwd(svc: ServiceConfig) {
    return svc.cwd ? path.resolve(this.#ctx.root, svc.cwd) : this.#ctx.root;
  }

  /**
   * Who answers a service's probe when it is a process from another project: one whose working folder is neither in
   * the service's `cwd` nor in this project's repository. Adopting it as `external` would point this stand — and the
   * devices behind it — at another project's server. Undefined when the holder is this project's, cannot be told
   * (Windows, a probe without a local port), or is a container runtime's forwarder. A service without `start` is one
   * pitbox only watches: whatever answers is what it asked for.
   */
  async #foreignHolder(svc: ServiceConfig): Promise<string | undefined> {
    if (!svc.start) return undefined;
    const port = localProbePort(svc.health);
    if (!port) return undefined;
    const owner = await portListener(port);
    if (!owner?.cwd || owner.cwd === '/') return undefined;
    if (withinFolder(owner.cwd, this.#cwd(svc)) || withinFolder(owner.cwd, projectRoot(this.#ctx.root))) return undefined;
    const cmd = await processCommand(owner.pid);
    if (isPortForwarder(cmd.name)) return undefined;
    return `port ${port} held by pid ${owner.pid} ${cmd.args || cmd.name || '?'} (cwd ${owner.cwd}) from another project — not adopted; give this stand its own port, or stop that process`;
  }

  #recoverPids() {
    try {
      const pids = JSON.parse(fs.readFileSync(this.#pidFile, 'utf8')) as Record<string, {pid?: number; startedAt: number; detached?: boolean}>;
      for (const [name, {pid, startedAt, detached}] of Object.entries(pids)) {
        if (this.#services[name]) {
          this.#state.set(name, {name, status: 'up', pid, startedAt, detached, expose: asArray(this.#services[name].expose), detail: 'recovered'});
        }
      }
    } catch {
      // no state yet
    }
  }

  /** Whether a process pitbox started for this service is still running (its tree, on Windows). */
  async #owned(known: ServiceState | undefined): Promise<boolean> {
    if (!known) return false;
    if (known.detached) return true;
    if (known.pid === undefined) return false;
    return (await liveTree(known.pid, known.startedAt ?? 0)).length > 0;
  }

  #savePids() {
    const pids: Record<string, {pid?: number; startedAt: number; detached?: boolean}> = {};
    for (const s of this.#state.values()) {
      if (!s.startedAt || (s.status !== 'up' && s.status !== 'starting')) continue;
      if (s.pid) pids[s.name] = {pid: s.pid, startedAt: s.startedAt};
      else if (s.detached) pids[s.name] = {startedAt: s.startedAt, detached: true};
    }
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
        const ours = await this.#owned(known);
        if (!svc.health) {
          return this.#set(name, ours ? {status: 'up', detail: 'running (no probe)'} : {status: 'stopped', pid: undefined, detail: svc.start ? undefined : 'no probe, no start'});
        }
        const probe = await checkProbe(svc.health, {cwd: this.#cwd(svc), shell: this.#ctx.shell});
        if (probe.ok && !ours) {
          const foreign = await this.#foreignHolder(svc);
          if (foreign) return this.#set(name, {status: 'failed', pid: undefined, detail: foreign});
        }
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
    // A failed service blocks only what depends on it (through any chain); the rest still comes up. The order
    // has dependencies first, so a blocked dependency is known before its dependents.
    const blocked = new Map<string, string>();
    for (const name of order) {
      const cause = (this.#services[name]!.dependsOn ?? []).map(d => blocked.get(d)).find(c => c !== undefined);
      if (cause !== undefined) {
        blocked.set(name, cause);
        results.push(this.#set(name, {status: 'stopped', detail: `skipped: ${cause} failed`}));
        continue;
      }
      const result = await this.#upOne(name);
      results.push(result);
      if (result.status === 'failed' || result.status === 'down') blocked.set(name, name);
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
        const ours = await this.#owned(known);
        const foreign = ours ? undefined : await this.#foreignHolder(svc);
        if (foreign) return this.#set(name, {status: 'failed', pid: undefined, detail: foreign});
        return this.#set(name, {status: ours ? 'up' : 'external', detail: probe.detail});
      }
    } else if (known?.pid !== undefined && isAlive(known.pid)) {
      return this.#set(name, {status: 'up', detail: 'running (no probe)'});
    }
    if (!svc.start) {
      return this.#set(name, {status: 'failed', detail: `not answering (${svc.health ?? 'no probe'}) and no start command`});
    }

    const logFile = this.logFile(name);
    fs.appendFileSync(logFile, `\n--- pitbox start ${new Date().toISOString()} :: ${svc.start}\n`);
    // The child writes straight into the log file. Piping through the daemon would tie the service to it: once
    // the daemon exits, the next write hits a closed pipe and the service dies of EPIPE.
    const t0 = Date.now();
    const child = await startService(svc.start, {cwd, env: {...this.#ctx.env, ...svc.env, FORCE_COLOR: '0'}, logFile, shell: this.#ctx.shell});
    const log = {write: (line: string) => fs.appendFileSync(logFile, line)};
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
      // The command may also exit after the probe has already passed (`docker compose up -d` returns once its
      // containers run): the service is still the one pitbox started, now without a pid.
      const upByThis = cur?.status === 'up' && cur.pid === child.pid;
      if ((starting || upByThis) && code === 0 && svc.health) {
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
      if (!failedExit && !detachedStart) killTree(child.pid ?? 0);
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
    const targets = names.length ? stopOrder(this.#services, names) : orderServices(this.#services, this.names()).reverse();
    const results: ServiceState[] = [];
    for (const name of targets) {
      const svc = this.#services[name]!;
      const known = this.#state.get(name);
      let detail: string;
      if (known?.pid !== undefined && (await liveTree(known.pid, known.startedAt ?? 0)).length) {
        this.#set(name, {status: 'stopped'});
        const gone = await killTreeAndWait(known.pid, 8000, known.startedAt ?? 0);
        detail = gone ? `killed pid ${known.pid}` : `pid ${known.pid} did not exit`;
      } else if (svc.stop) {
        detail = 'ran stop';
      } else {
        const st = (await this.status()).find(s => s.name === name);
        detail = st?.status === 'external' ? 'left running (not started by pitbox)' : st?.detail?.includes('from another project') ? "left running (another project's)" : 'not running';
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
    // `down` also stops what depends on the named services; those that were running come back with them.
    const running = new Set((await this.status()).filter(s => s.status === 'up' || s.status === 'external').map(s => s.name));
    await this.down(names);
    return this.up(restartOrder(this.#services, names, running));
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

  /** Stops every process pitbox started, without running stop commands (tests). */
  async killAll() {
    for (const s of this.#state.values()) if (s.pid) await killTreeAndWait(s.pid, 5000, s.startedAt ?? 0);
  }
}
