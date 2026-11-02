// Actors: extra users of the app (a second account, a caller, a peer) — instances of a project command
// that pitbox starts on a free port, health-checks, logs and calls over HTTP.

import fs from 'node:fs';
import path from 'node:path';
import type {ChildProcess} from 'node:child_process';
import type {ActorConfig} from '../config/schema.ts';
import {freePort} from '../util/net.ts';
import {killTree, quoteArg, resolveShell, spawnShell} from '../util/proc.ts';
import {renderTemplate, tailLines} from '../util/text.ts';
import {waitForProbe} from './health.ts';
import type {StandContext} from './services.ts';

export type ActorState = {name: string; type: string; port: number; pid?: number; status: 'up' | 'failed' | 'stopped'; detail?: string};

export class ActorManager {
  readonly #ctx: StandContext;
  #actors: Record<string, ActorConfig>;
  readonly #running = new Map<string, {state: ActorState; child: ChildProcess}>();

  constructor(ctx: StandContext, actors: Record<string, ActorConfig>) {
    this.#ctx = ctx;
    this.#actors = actors;
  }

  setActors(actors: Record<string, ActorConfig>) {
    this.#actors = actors;
  }

  types() {
    return Object.entries(this.#actors).map(([type, a]) => ({type, description: a.description}));
  }

  list(): ActorState[] {
    return [...this.#running.values()].map(r => r.state);
  }

  #logFile(name: string) {
    return path.join(this.#ctx.stateDir, 'logs', `actor-${name}.log`);
  }

  async start(type: string, name: string, port?: number): Promise<ActorState> {
    const cfg = this.#actors[type];
    if (!cfg) throw new Error(`unknown actor type: ${type} (known: ${Object.keys(this.#actors).join(', ') || 'none'})`);
    if (this.#running.has(name)) return this.#running.get(name)!.state;
    const p = port ?? (await freePort());
    const shell = resolveShell(this.#ctx.shell);
    const command = renderTemplate(cfg.start, {name, port: p}, v => quoteArg(v, shell.kind));
    fs.mkdirSync(path.dirname(this.#logFile(name)), {recursive: true});
    const log = fs.createWriteStream(this.#logFile(name), {flags: 'a'});
    log.write(`\n--- pitbox actor ${name} (${type}) ${new Date().toISOString()} :: ${command}\n`);
    const child = spawnShell(command, {
      cwd: cfg.cwd ? path.resolve(this.#ctx.root, cfg.cwd) : this.#ctx.root,
      env: {...process.env, ...this.#ctx.env, ...cfg.env},
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: this.#ctx.shell,
    });
    child.stdout?.pipe(log, {end: false});
    child.stderr?.pipe(log, {end: false});
    const state: ActorState = {name, type, port: p, pid: child.pid, status: 'up'};
    let exited: string | undefined;
    child.on('exit', code => {
      exited = `exited with ${code}`;
      state.status = state.status === 'stopped' ? 'stopped' : 'failed';
      state.detail = exited;
      this.#running.delete(name);
    });
    this.#running.set(name, {state, child});
    const probe = (cfg.health ?? 'tcp:{port}').replace(/\{port\}/g, String(p));
    const ok = await waitForProbe(probe, 60_000, {abort: () => exited});
    if (!ok.ok) {
      killTree(child);
      this.#running.delete(name);
      return {...state, status: 'failed', detail: `${ok.detail}\n${this.logTail(name, 10).join('\n')}`};
    }
    return state;
  }

  stop(name: string): ActorState {
    const r = this.#running.get(name);
    if (!r) throw new Error(`no running actor: ${name}`);
    r.state.status = 'stopped';
    killTree(r.child);
    this.#running.delete(name);
    return r.state;
  }

  async call(name: string, body: unknown): Promise<{status: number; body: string}> {
    const r = this.#running.get(name);
    if (!r) throw new Error(`no running actor: ${name}`);
    const cfg = this.#actors[r.state.type]!;
    const res = await fetch(`http://127.0.0.1:${r.state.port}${cfg.call?.path ?? '/'}`, {
      method: cfg.call?.method ?? 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(60_000),
    });
    return {status: res.status, body: await res.text()};
  }

  logTail(name: string, lines = 40, grep?: string) {
    try {
      return tailLines(fs.readFileSync(this.#logFile(name), 'utf8'), lines, grep);
    } catch {
      return [];
    }
  }

  stopAll() {
    for (const name of [...this.#running.keys()]) this.stop(name);
  }
}
