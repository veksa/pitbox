// Compact text for results — the same for a person in a terminal and an agent over MCP. Short lines, no JSON
// unless the data is JSON, nothing repeated that the caller already knows.

import type {AndroidDevice} from './drivers/android/driver.ts';
import type {DoctorReport} from './doctor/run.ts';
import type {ActorState} from './stand/actors.ts';
import type {ServiceState} from './stand/services.ts';
import type {ToolResult} from './stand/tools.ts';
import {clipLines, seconds} from './util/text.ts';

const mark: Record<string, string> = {up: '✓', external: '✓', starting: '…', stopped: '·', down: '✗', failed: '✗'};

export const fmtServices = (services: ServiceState[]): string[] => {
  const width = Math.max(4, ...services.map(s => s.name.length));
  return services.map(s => {
    const bits = [`${mark[s.status] ?? '?'} ${s.name.padEnd(width)} ${s.status}`];
    if (s.status === 'external') bits.push('(not started by pitbox)');
    if (s.pid) bits.push(`pid ${s.pid}`);
    if (s.startMs !== undefined && s.status === 'up') bits.push(`in ${seconds(s.startMs)}`);
    if (s.expose.length) bits.push(`expose ${s.expose.join(',')}`);
    const first = s.detail?.split('\n')[0];
    if (first && s.status !== 'up' && s.status !== 'external') bits.push(`— ${first}`);
    const rest = s.status === 'failed' ? s.detail?.split('\n').slice(1) : undefined;
    return [bits.join('  '), ...(rest?.length ? clipLines(rest).map(l => `    ${l}`) : [])].join('\n');
  });
};

export const fmtDevices = (devices: AndroidDevice[], avds?: {name: string; kind: string}[]): string[] => {
  const out = devices.map(d => `${d.state === 'device' ? '✓' : '✗'} ${d.serial}${d.avd ? `  ${d.avd}` : ''}${d.kind ? ` (${d.kind})` : ''}${d.model ? `  ${d.model}` : ''}${d.state !== 'device' ? `  ${d.state}` : ''}`);
  if (!devices.length) out.push('no devices online');
  if (avds) {
    const running = new Set(devices.map(d => d.avd));
    const idle = avds.filter(a => !running.has(a.name));
    if (idle.length) out.push(`avds: ${idle.map(a => `${a.name}${a.kind !== 'phone' ? `(${a.kind})` : ''}`).join(', ')}`);
  }
  return out;
};

export const fmtActors = (actors: ActorState[]): string[] => actors.map(a => `${a.status === 'up' ? '✓' : '✗'} actor ${a.name} (${a.type}) :${a.port}${a.pid ? ` pid ${a.pid}` : ''}${a.detail ? ` — ${a.detail.split('\n')[0]}` : ''}`);

export const fmtStatus = (r: {services: ServiceState[]; actors: ActorState[]; mock?: {port: number; running: boolean; requests: number}; devices: AndroidDevice[]; exposed: number[]}): string => {
  const out = [...fmtServices(r.services)];
  if (r.mock) out.push(`${r.mock.running ? '✓' : '·'} llm-mock :${r.mock.port} ${r.mock.running ? `${r.mock.requests} requests` : 'stopped'}`);
  out.push(...fmtActors(r.actors));
  out.push(...fmtDevices(r.devices));
  if (r.exposed.length) out.push(`forwarded to devices: ${r.exposed.join(', ')}`);
  return out.join('\n');
};

export const fmtDoctor = (r: DoctorReport): string => {
  if (!r.findings.length) return `✓ ${r.checked} checks passed`;
  const icon = {error: '✗', warn: '!', info: '·'} as Record<string, string>;
  return r.findings
    .map(f => [`${icon[f.severity]} [${f.rule}] ${f.message}`, f.hint ? `    → ${f.hint}` : '', f.fixed ? `    fixed: ${f.fixed}` : f.fixable ? '    (fixable: doctor fix=true)' : ''].filter(Boolean).join('\n'))
    .join('\n');
};

export const fmtTool = (r: ToolResult): string => `${r.code === 0 ? '' : `exit ${r.timedOut ? 'timeout' : r.code} · `}${seconds(r.ms)}\n${r.output}`.trimEnd();

/** Generic fallback: `key: value` lines for small objects. */
export const fmtObject = (o: unknown): string => {
  if (o === undefined || o === null) return 'ok';
  if (typeof o !== 'object') return String(o);
  if (Array.isArray(o)) return o.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n');
  return Object.entries(o as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? (v.length && typeof v[0] === 'object' ? JSON.stringify(v) : v.join(', ')) : typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
};

/** Formats any engine result by method. */
export const formatResult = (method: string, r: unknown): string => {
  const x = r as Record<string, unknown>;
  switch (method) {
    case 'status':
      return fmtStatus(x as Parameters<typeof fmtStatus>[0]);
    case 'up': {
      const lines = fmtServices(x.services as ServiceState[]);
      const mock = x.mock as {port: number} | undefined;
      if (mock) lines.push(`✓ llm-mock :${mock.port}`);
      for (const f of (x.forwards as {serial: string; ports: number[]}[]) ?? []) lines.push(`forwarded ${f.ports.join(',')} → ${f.serial}`);
      return lines.join('\n');
    }
    case 'down':
    case 'restart':
      return fmtServices(x.services as ServiceState[]).join('\n');
    case 'logs':
    case 'appLogs':
      return ((x.lines as string[]) ?? []).length ? clipLines(x.lines as string[]).join('\n') : '(no lines)';
    case 'docs':
      return x.docs ? `docs: ${(x.docs as string[]).join(', ') || 'none configured'}` : (x.lines as string[]).join('\n') || '(no matches)';
    case 'devices':
      return fmtDevices(x.devices as AndroidDevice[], x.avds as {name: string; kind: string}[]).join('\n');
    case 'doctor':
      return fmtDoctor(x as unknown as DoctorReport);
    case 'tool':
      return fmtTool(x as unknown as ToolResult);
    case 'actors':
      return fmtActors(r as ActorState[]).join('\n') || 'no actors running';
    case 'actorStart':
      return fmtActors([r as ActorState]).join('\n');
    case 'actorCall':
      return `HTTP ${x.status}\n${String(x.body).slice(0, 6000)}`;
    case 'tools':
      return (r as {name: string; description: string; params: Record<string, string>}[]).map(t => `${t.name}(${Object.keys(t.params).join(', ')}) — ${t.description}`).join('\n') || 'no tools configured';
    case 'boot':
      return x.already ? `${x.avd} already running as ${x.serial}` : `${x.avd} booted as ${x.serial} in ${seconds(x.ms as number)}`;
    case 'install':
      return `installed on ${x.serial} in ${seconds(x.ms as number)}${x.replaced ? ' (uninstalled the old signature first)' : ''}`;
    case 'open':
      return `opened ${x.target} on ${x.serial}${x.totalMs !== undefined ? ` (activity in ${x.totalMs} ms)` : ''}`;
    case 'screenshot':
      return `${x.file} (${Math.round((x.bytes as number) / 1024)} KB)`;
    case 'apps':
      return (x.packages as string[]).join('\n') || 'no third-party packages';
    default:
      return fmtObject(r);
  }
};
