// Compact text for results — the same for a person in a terminal and an agent over MCP. Short lines, no JSON
// unless the data is JSON, nothing repeated that the caller already knows.

import type {AndroidDevice} from './drivers/android/driver.ts';
import type {DoctorReport} from './doctor/run.ts';
import type {ActorState} from './stand/actors.ts';
import type {ServiceState} from './stand/services.ts';
import type {ToolResult} from './stand/tools.ts';
import type {DevserverStatus, Freshness} from './devserver/devserver.ts';
import type {JsError} from './devserver/proxy.ts';
import type {ActResult, FocusMap} from './ui/android.ts';
import type {FlowResult} from './flows/run.ts';
import type {UiNode} from './ui/snapshot.ts';
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

type Prewarm = {platform: string; ms: number; ok: boolean; note?: string}[];

export const fmtPrewarm = (p: Prewarm | undefined): string[] => (p ?? []).map(x => `${x.ok ? '✓' : '✗'} prewarm ${x.platform} ${seconds(x.ms)}${x.note ? ` — ${x.note}` : ''}`);

export const fmtDev = (d: DevserverStatus, detailed = false): string[] => {
  const out = [`  devserver proxy :${d.port} → :${d.internalPort} ${d.proxy ? 'listening' : 'down'} · bytecode ${d.bytecode}${d.lastCompileMs !== undefined ? ` (last compile ${seconds(d.lastCompileMs)}, ${d.lastBytecodeKB} KB)` : ''} · ${d.compiles} compiles, ${d.cacheHits} cache hits`];
  if (d.lastError) out.push(`  last error: ${d.lastError}`);
  if (detailed) {
    out.push(...fmtPrewarm(d.prewarm).map(l => `  ${l}`));
    for (const r of d.requests) out.push(`  ${r.ago} ago ${r.kind} ${r.url} ${r.status} ${r.kb} KB in ${r.ms} ms${r.note ? ` (${r.note})` : ''}`);
  }
  return out;
};

export const fmtStatus = (r: {services: ServiceState[]; actors: ActorState[]; mock?: {port: number; running: boolean; requests: number}; devices: AndroidDevice[]; exposed: number[]; dev?: DevserverStatus}): string => {
  const out = [...fmtServices(r.services)];
  if (r.dev) out.push(...fmtDev(r.dev));
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

const broken = (c: {kind: string}) =>
  c.kind === 'anr' ? 'app not responding (ANR)' : c.kind === 'native-crash' ? 'app crashed (native)' : c.kind === 'js-error' ? 'JS error' : 'app crashed';

export const fmtAct = (r: ActResult): string => {
  // A slow action says where its time went, so the next turn knows whether the app or the tool was slow.
  const slow = r.ms > 3000 && r.phases ? ` · slow: ${Object.entries(r.phases).filter(([, v]) => v >= 100).map(([k, v]) => `${k} ${v}`).join(', ')}` : '';
  const head = `${r.action}${r.target ? ` ${r.target}` : ''} · ${r.ms} ms${r.idle ? '' : ' · UI still changing'}${r.trace ? ` · trace ${r.trace}` : ''}${slow}`;
  const broke = (r.crashes ?? []).flatMap(c => [`! ${broken(c)}: ${c.summary}`, ...c.lines.slice(0, c.kind === 'js-error' ? 6 : 4).map(l => `    ${l}`)]);
  if (!r.diff.changed) return [head, ...broke, 'no change on screen'].join('\n');
  return [head, ...broke, ...(r.diff.full ? ['screen:', ...r.diff.lines] : r.diff.lines)].join('\n');
};

export const fmtFlow = (r: FlowResult): string => {
  if (r.ok) return [`✓ flow passed: ${r.steps} steps in ${seconds(r.ms)}`, ...r.notes].join('\n');
  const f = r.failed!;
  return [
    `✗ flow failed at line ${f.line}: ${f.step}`,
    `  ${f.error}`,
    `  after ${r.steps} passing steps, ${seconds(r.ms)}`,
    ...(f.crashes ?? []).flatMap(c => [`  ! ${broken(c)}: ${c.summary}`, ...c.lines.slice(0, 8).map(l => `      ${l}`)]),
    ...(f.screenshot ? [`  screenshot: ${f.screenshot}`] : []),
    ...(f.screen ? ['screen:', ...f.screen] : []),
    ...r.notes,
  ].join('\n');
};

const fmtNode = (n?: UiNode) => (n ? [n.c, n.t && JSON.stringify(n.t), n.d && `(${n.d})`, n.id && `#${n.id}`].filter(Boolean).join(' ') : 'none');

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
      lines.push(...fmtPrewarm(x.prewarm as Prewarm | undefined));
      return lines.join('\n');
    }
    case 'down':
      return fmtServices(x.services as ServiceState[]).join('\n');
    case 'restart':
    case 'devPrewarm':
      return [...(x.services ? fmtServices(x.services as ServiceState[]) : []), ...fmtPrewarm(x.prewarm as Prewarm | undefined)].join('\n') || 'nothing to prewarm';
    case 'devStatus':
      return [...(x.service ? fmtServices([x.service as ServiceState]) : []), ...fmtDev(x as unknown as DevserverStatus, true)].join('\n');
    case 'press':
    case 'fill':
    case 'type':
    case 'uiKey':
    case 'swipe':
    case 'touch':
    case 'scroll':
      return fmtAct(r as ActResult);
    case 'snapshot':
      return (x.lines as string[]).join('\n') || '(empty screen)';
    case 'run':
    case 'as':
      return fmtFlow(r as FlowResult);
    case 'focus':
      return `input focus: ${fmtNode(x.input as UiNode | undefined)}\naccessibility focus: ${fmtNode(x.accessibility as UiNode | undefined)}`;
    case 'focusMap': {
      const m = x as unknown as FocusMap;
      return [
        `focus walk from ${m.start}: reached ${m.reached} focusable nodes · ${m.presses} presses · ${seconds(m.ms)}${m.complete ? '' : ' · stopped at the press limit (raise max)'}`,
        ...(m.unreached.length ? [`${m.complete ? 'unreachable' : 'not reached within the limit'}: ${m.unreached.join(', ')}`] : []),
        ...(m.traps.length ? [`traps (focus cannot leave): ${m.traps.join(', ')}`] : []),
        ...m.asymmetric.map(a => `not reversible: ${a}`),
      ].join('\n');
    }
    case 'perf':
      return x.reset ? 'frame stats reset — interact, then read perf' : `frames ${x.frames ?? '?'} · janky ${x.janky ?? '?'}% · frame time p50 ${x.p50 ?? '?'} ms, p90 ${x.p90 ?? '?'} ms, p99 ${x.p99 ?? '?'} ms · memory ${x.memoryMb ?? '?'} MB`;
    case 'visual':
      return x.status === 'saved' ? `baseline saved: ${x.baseline}` : x.status === 'match' ? `matches ${x.name} (score ${x.score})` : `differs from ${x.name}: score ${x.score}, ${Math.round((x.changedShare as number) * 1000) / 10}% of the screen, regions ${(x.regions as number[][]).map(r => `[${r.join(',')}]`).join(' ')}\ncurrent: ${x.current}\nbaseline: ${String(x.baseline).replace(/\.json$/, '.jpg')}`;
    case 'media':
      return `${x.playing ? 'playing' : x.black ? 'black' : x.moving ? 'moving (but dark)' : 'not moving'}${x.target ? ` ${x.target}` : ''} · motion ${x.motion} · brightness ${x.luma}`;
    case 'uiShot':
      return `${x.file} (${x.width}×${x.height}, ${x.kb} KB)`;
    case 'wait':
      return `appeared in ${x.ms} ms`;
    case 'goto':
      return `opened ${x.url}`;
    case 'recordStart':
      return 'recording: actions from now on become flow steps';
    case 'recordStop':
      return [x.file ? `saved ${x.file}` : 'recorded:', ...(x.lines as string[])].join('\n');
    case 'qr':
      return [x.terminal as string | undefined, `${x.url}`, `qr image: ${x.file}`, `reaches: ${x.reachable}`].filter(Boolean).join('\n');
    case 'fresh': {
      const f = x as unknown as Freshness;
      if (!f.apps.length) return 'no app connected to the dev server — not started, a release build, or talking to another server';
      return f.apps.map(a => (a.fresh ? `✓ app ${a.id} (${a.platform}) runs the newest bundle ${a.bundle}` : `✗ app ${a.id} (${a.platform}) is stale: ${a.note}`)).join('\n');
    }
    case 'appErrors': {
      const errors = x.errors as JsError[];
      if (!errors.length) return 'no JS errors in the last 30 min';
      return errors
        .map(e => [`${seconds(Date.now() - e.at)} ago · app ${e.app}${e.fatal ? ' · fatal' : ''}: ${e.message}`, ...e.frames.map(l => `    ${l}`), ...(e.code ? [`    > ${e.code}`] : []), ...(e.symbolicated ? [] : ['    (not symbolicated: the bundler did not answer)'])].join('\n'))
        .join('\n');
    }
    case 'appTree': {
      type TreeNode = {s: number; d: number; c: string; id?: string; l?: string; t?: string; hidden?: boolean};
      const apps = x.apps as {app: number; error?: string; surfaces?: number; truncated?: boolean; nodes?: TreeNode[]}[];
      const line = (n: TreeNode) => `${'  '.repeat(Math.min(n.d, 8))}${n.c}${n.t ? ` ${JSON.stringify(n.t.slice(0, 80))}` : ''}${n.l ? ` (${n.l.slice(0, 60)})` : ''}${n.id ? ` #${n.id}` : ''}${n.hidden ? ' [hidden from accessibility]' : ''}`;
      // Depth relative to the shallowest node: wrappers above the first labelled node add nothing.
      return (
        apps
          .map(a => {
            if (a.error) return `app ${a.app}: ${a.error}`;
            const min = Math.min(...(a.nodes ?? []).map(n => n.d));
            return [`app ${a.app} · ${a.surfaces} surface(s) · ${a.nodes?.length} nodes${a.truncated ? ' (truncated)' : ''}`, ...(a.nodes ?? []).map(n => line({...n, d: n.d - min}))].join('\n');
          })
          .join('\n') || 'no app connected'
      );
    }
    case 'appLog':
      return (x.apps as {app: number; platform?: string; entries: Record<string, unknown>[]}[])
        .map(a => [`app ${a.app} (${a.platform ?? '?'})`, ...a.entries.map(e => (e.ws ? `  ws ${e.ev} ${e.ws}${e.rule ? ` [${e.rule}]` : ''}` : `  ${e.m} ${e.url} → ${e.s} in ${e.ms} ms${e.rule ? ` [${e.rule}]` : ''}`))].join('\n'))
        .join('\n') || 'no app connected';
    case 'net': {
      const rules = x.rules as {id: string; kind: string; match: string; action: string; status?: number; ms?: number}[];
      const lines = rules.map(r => `${r.id}: ${r.action} ${r.kind} matching "${r.match}"${r.status ? ` → ${r.status}` : ''}${r.ms ? ` ${r.ms} ms` : ''}`);
      return [...(lines.length ? lines : ['no network rules']), `apps connected: ${x.apps}`].join('\n');
    }
    case 'stateList':
      return (x.states as {name: string; savedAt: number; avd?: string; device?: string; backend: boolean}[]).map(s => `${s.name} · ${new Date(s.savedAt).toISOString().slice(0, 16).replace('T', ' ')} · ${[s.avd ?? s.device, s.backend && 'backend'].filter(Boolean).join(' + ') || 'empty'}`).join('\n') || 'no states saved';
    case 'stateSave':
      return `saved ${x.name}: ${[x.avd ?? x.device ? `snapshot of ${x.avd ?? x.device}` : '', x.backend ? 'backend dump' : ''].filter(Boolean).join(' + ') || 'nothing (no emulator, no states.save in the config)'}`;
    case 'stateRestore':
      return `restored ${x.name} in ${seconds(x.ms as number)}`;
    case 'matrix': {
      const rs = x.results as {variant: string; ok: boolean; ms: number; failed?: string}[];
      return [`${rs.filter(r => r.ok).length}/${rs.length} variants passed · screenshots under ${x.shots}`, ...rs.map(r => `${r.ok ? '✓' : '✗'} ${r.variant} · ${seconds(r.ms)}${r.failed ? ` — ${r.failed}` : ''}`)].join('\n');
    }
    case 'devReload':
      return 'reload sent to connected apps';
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
      return `installed on ${x.serial} in ${seconds(x.ms as number)}${x.replaced ? ' (uninstalled the old build first)' : ''}`;
    case 'open':
      return `opened ${x.target} on ${x.serial}${x.totalMs !== undefined ? ` (activity in ${x.totalMs} ms)` : ''}`;
    case 'screenshot':
      return `${x.file} (${Math.round((x.bytes as number) / 1024)} KB)`;
    case 'shutdown':
      return x.gone ? `${x.serial} shut down in ${seconds(x.ms as number)}` : `${x.serial} still listed after ${seconds(x.ms as number)}`;
    case 'apps':
      return (x.packages as string[]).join('\n') || 'no third-party packages';
    default:
      return fmtObject(r);
  }
};
