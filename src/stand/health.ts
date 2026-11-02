// Health probes for services and actors.

import {httpAlive, tcpOpen} from '../util/net.ts';
import {run, runShell} from '../util/proc.ts';

export type ProbeResult = {ok: boolean; detail: string};

export type ParsedProbe =
  | {kind: 'http'; url: string}
  | {kind: 'tcp'; host: string; port: number}
  | {kind: 'docker'; container: string}
  | {kind: 'cmd'; command: string};

export const parseProbe = (probe: string): ParsedProbe => {
  if (/^https?:\/\//.test(probe)) return {kind: 'http', url: probe};
  if (probe.startsWith('tcp:')) {
    const rest = probe.slice(4);
    const parts = rest.split(':');
    const port = Number(parts.pop());
    if (!Number.isInteger(port) || port <= 0) throw new Error(`bad tcp probe: ${probe}`);
    return {kind: 'tcp', host: parts.join(':') || '127.0.0.1', port};
  }
  if (probe.startsWith('docker:')) return {kind: 'docker', container: probe.slice(7)};
  if (probe.startsWith('cmd:')) return {kind: 'cmd', command: probe.slice(4)};
  throw new Error(`unknown probe: ${probe}`);
};

/** The TCP port a probe watches, when it has one — used to find who holds it. */
export const probePort = (probe: string | undefined): number | undefined => {
  if (!probe) return undefined;
  const p = parseProbe(probe);
  if (p.kind === 'tcp') return p.port;
  if (p.kind === 'http') {
    const url = new URL(p.url);
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  }
  return undefined;
};

export const checkProbe = async (probe: string, opts: {cwd?: string; shell?: string} = {}): Promise<ProbeResult> => {
  const p = parseProbe(probe);
  switch (p.kind) {
    case 'http': {
      const r = await httpAlive(p.url);
      return {ok: r.ok, detail: r.status !== undefined ? `HTTP ${r.status}` : (r.error ?? 'no answer')};
    }
    case 'tcp': {
      const ok = await tcpOpen(p.port, p.host);
      return {ok, detail: ok ? `tcp ${p.port} open` : `tcp ${p.port} closed`};
    }
    case 'docker': {
      const r = await run('docker', ['inspect', '-f', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', p.container], {timeoutMs: 5000});
      if (r.code !== 0) return {ok: false, detail: r.stderr.trim().split('\n')[0] || 'docker inspect failed'};
      const [state, health] = r.stdout.trim().split(/\s+/);
      const ok = state === 'running' && (!health || health === 'healthy');
      return {ok, detail: health ? `${state}/${health}` : (state ?? 'unknown')};
    }
    case 'cmd': {
      const r = await runShell(p.command, {cwd: opts.cwd, shell: opts.shell, timeoutMs: 15000});
      return {ok: r.code === 0, detail: r.code === 0 ? 'exit 0' : `exit ${r.code}`};
    }
  }
};

export const waitForProbe = async (probe: string, timeoutMs: number, opts: {cwd?: string; shell?: string; abort?: () => string | undefined} = {}): Promise<ProbeResult> => {
  const deadline = Date.now() + timeoutMs;
  let last: ProbeResult = {ok: false, detail: 'not checked'};
  while (Date.now() < deadline) {
    const aborted = opts.abort?.();
    if (aborted) return {ok: false, detail: aborted};
    last = await checkProbe(probe, opts);
    if (last.ok) return last;
    await new Promise(r => setTimeout(r, 300));
  }
  return {ok: false, detail: `timed out after ${Math.round(timeoutMs / 1000)}s (${last.detail})`};
};
