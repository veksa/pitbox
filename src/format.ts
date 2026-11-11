// Compact text for results — the same for a person in a terminal and an agent over MCP. Short lines, no JSON
// unless the data is JSON, nothing repeated that the caller already knows.

import path from 'node:path';
import type {AndroidDevice} from './drivers/android/driver.ts';
import type {DoctorReport} from './doctor/run.ts';
import type {ActorState} from './stand/actors.ts';
import type {ServiceState} from './stand/services.ts';
import type {ToolResult} from './stand/tools.ts';
import type {DevserverStatus, EmbedResult, Freshness} from './devserver/devserver.ts';
import type {EvalResult, JsProfile, Logpoint} from './devserver/jsdebug.ts';
import type {TraceSummary} from './drivers/android/atrace.ts';
import type {JsError} from './devserver/proxy.ts';
import type {ActResult, FocusMap} from './ui/device.ts';
import type {PushRecord, PushResult} from './push/push.ts';
import type {FlowResult} from './flows/run.ts';
import type {UiNode} from './ui/snapshot.ts';
import {clipLines, seconds} from './util/text.ts';
import type {WebDownload} from './drivers/web/runner.ts';

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

export type SimRow = {udid: string; name: string; os: string; kind?: string; state?: string; holder?: string};

/** A device row's lease: `[yours]`, `[held by "label" (…)]`. */
const held = (d: {holder?: string}) => (d.holder ? `  [${d.holder}]` : '');

export const fmtDevices = (devices: (AndroidDevice & {holder?: string})[], avds?: {name: string; kind: string}[], sims: SimRow[] = []): string[] => {
  const out = devices.map(d => `${d.state === 'device' ? '✓' : '✗'} ${d.serial}${d.avd ? `  ${d.avd}` : ''}${d.kind ? ` (${d.kind})` : ''}${d.model ? `  ${d.model}` : ''}${d.state !== 'device' ? `  ${d.state}` : ''}${held(d)}`);
  const booted = sims.filter(s => !s.state || s.state === 'Booted');
  // Booted simulators are online devices too; the udid is there for names that repeat.
  out.push(...booted.map(s => `✓ ${s.name}  ${s.os}${s.kind && s.kind !== 'phone' ? ` (${s.kind})` : ''}  ${s.udid}${held(s)}`));
  if (!devices.length && !booted.length) out.push('no devices online');
  if (avds) {
    const running = new Set(devices.map(d => d.avd));
    const idle = avds.filter(a => !running.has(a.name));
    if (idle.length) out.push(`avds: ${idle.map(a => `${a.name}${a.kind !== 'phone' ? `(${a.kind})` : ''}`).join(', ')}`);
  }
  const idleSims = [...new Set(sims.filter(s => s.state && s.state !== 'Booted').map(s => s.name))];
  if (idleSims.length) out.push(`simulators: ${idleSims.join(', ')}`);
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

export const fmtStatus = (r: {services: ServiceState[]; actors: ActorState[]; mock?: {port: number; running: boolean; requests: number}; push?: {port: number; running: boolean; requests: number; error?: string}; devices: AndroidDevice[]; simulators?: SimRow[]; exposed: number[]; dev?: DevserverStatus}): string => {
  const out = [...fmtServices(r.services)];
  if (r.dev) out.push(...fmtDev(r.dev));
  if (r.mock) out.push(`${r.mock.running ? '✓' : '·'} llm-mock :${r.mock.port} ${r.mock.running ? `${r.mock.requests} requests` : 'stopped'}`);
  if (r.push) out.push(`${r.push.running ? '✓' : '·'} push gateway :${r.push.port} ${r.push.running ? `${r.push.requests} requests` : (r.push.error ?? 'stopped')}`);
  out.push(...fmtActors(r.actors));
  out.push(...fmtDevices(r.devices, undefined, r.simulators));
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
  // No trace id: `trace` takes the last action's, and the id is ~25 tokens on every action. `--json` keeps it.
  const head = `${r.action}${r.target ? ` ${r.target}` : ''} · ${r.ms} ms${r.idle ? '' : ' · UI still changing'}${slow}${r.step ? `\nstep: ${r.step.replace(/\n/g, '\n      ')}` : ''}`;
  const broke = (r.crashes ?? []).flatMap(c => [`! ${broken(c)}: ${c.summary}`, ...c.lines.slice(0, c.kind === 'js-error' ? 6 : 4).map(l => `    ${l}`)]);
  if (!r.diff.changed) return [head, ...broke, r.note ? `no change on screen — ${r.note}` : 'no change on screen'].join('\n');
  return [head, ...broke, ...(r.note ? [`note: ${r.note}`] : []), ...(r.diff.full ? ['screen:', ...r.diff.lines] : r.diff.lines)].join('\n');
};

export const fmtFlow = (r: FlowResult): string => {
  if (r.ok) return [`✓ flow passed: ${r.steps} steps in ${seconds(r.ms)}`, ...r.notes].join('\n');
  const f = r.failed!;
  return [
    `✗ flow failed at line ${f.line}: ${f.step}`,
    `  ${f.error}`,
    ...(f.fix ? [`  fix? ${f.fix}`] : []),
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
const fmtTrace = (t?: TraceSummary & {note?: string}): string[] => {
  if (!t) return [];
  if (t.note) return [t.note];
  if (!t.threads.length) return ['platform trace: nothing traced in the app (not running?)'];
  return [
    `platform trace ${seconds(t.ms)}: ${t.threads
      .slice(0, 4)
      .map(x => `${x.thread} ${x.ms} ms`)
      .join(', ')}`,
    ...(t.long.length
      ? [`  slices of ${t.longMs} ms and more (longest, how often, sum):`, ...t.long.map(s => `  ${String(s.ms).padStart(6)} ms ${`×${s.count}`.padStart(4)} ${String(s.totalMs).padStart(7)} ms  ${s.thread}  ${[s.name, ...s.path].join(' > ').slice(0, 120)}`)]
      : [`  no slice reached ${t.longMs} ms`]),
  ];
};

type ReactRenders = {
  ms: number;
  react?: boolean;
  commits: number;
  renderMs: number;
  components: number;
  shown: {name: string; n: number; ms: number; why: [string, number][]}[];
  heap?: {liveBefore: number; liveAfter: number; allocated: number; gcs: number; gcMs: number};
};

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

const fmtRenders = (r?: ReactRenders): string[] => {
  if (!r) return [];
  const h = r.heap;
  // Live bytes depend on when the collector last ran: growth over one window is a hint, a trend over repeats is the finding.
  const heap = h ? [`JS heap: ${mb(h.liveBefore)} → ${mb(h.liveAfter)} live (${h.liveAfter >= h.liveBefore ? '+' : '−'}${mb(Math.abs(h.liveAfter - h.liveBefore))}), ${mb(h.allocated)} allocated, ${h.gcs} GC${h.gcs === 1 ? '' : 's'} (${h.gcMs} ms)`] : [];
  if (r.react === false) return heap;
  if (!r.commits) return [...heap, 'React: no commits'];
  return [
    ...heap,
    `React: ${r.commits} commit${r.commits === 1 ? '' : 's'}, ${r.renderMs} ms rendering, ${r.components} component${r.components === 1 ? '' : 's'} rendered`,
    ...r.shown.map(c => `  ${String(c.n).padStart(4)}×  ${String(c.ms).padStart(6)} ms  ${c.name} — ${c.why.map(([w, n]) => (n === c.n ? w : `${w} ×${n}`)).join('; ')}`),
  ];
};

const fmtJsProfile = (p?: JsProfile): string[] => {
  if (!p) return [];
  if (p.note) return [p.note];
  if (!p.samples) return ['JS: no samples (the window was too short)'];
  const share = p.ms ? Math.round((p.busyMs / p.ms) * 100) : 0;
  const ms = (n: number) => `${String(n).padStart(5)} ms`;
  return [
    `JS thread busy ${seconds(p.busyMs)} of ${seconds(p.ms)} (${share}%)`,
    ...(p.busyMs ? ['  self time:', ...p.self.map(s => `  ${ms(s.ms)}  ${s.at}`)] : []),
    ...(p.app.length ? ['  app code, with what it called:', ...p.app.map(s => `  ${ms(s.ms)}  ${s.at}`)] : []),
  ];
};

const fmtLogpoint = (lp: Logpoint) =>
  `${lp.source ?? lp.file}:${lp.codeLine ?? lp.line}${lp.codeLine && lp.codeLine !== lp.line ? ` (no code at line ${lp.line})` : ''}${lp.exprs.length ? ` · ${lp.exprs.join(', ')}` : ''}`;

type MacWindow = {title: string; size?: number[]; main?: boolean; minimized?: boolean};

/** A Mac app's windows, numbered the way `window #n` picks them, and the one snapshots and input follow. */
const fmtMacWindows = (serial: string, selected: string, windows: MacWindow[]): string =>
  [
    `${serial}: driving ${selected === 'front' ? 'the window in front' : JSON.stringify(selected)}`,
    ...(windows.length
      ? windows.map((w, i) => `  #${i + 1} ${JSON.stringify(w.title)}${w.size ? ` ${w.size.join('x')}` : ''}${w.main ? ' main' : ''}${w.minimized ? ' minimized' : ''}`)
      : ['  no windows']),
  ].join('\n');

const fmtPushLine = (r: PushResult): string =>
  `${r.ok ? '✓' : '✗'} ${r.platform === 'apple' ? 'ios' : 'android'} ${r.app}${r.state ? ` (${r.state})` : ''}${r.count ? ` ×${r.count}` : ''}: ${r.verdict}`;

export const fmtPush = (x: Record<string, unknown>): string => {
  switch (x.action) {
    case 'tap':
      return [`${x.ok === false ? '✗ ' : ''}tapped "${x.tapped}"${x.state ? ` → app ${x.state}` : ''}`, ...(x.note ? [`note: ${x.note}`] : []), x.act ? fmtAct(x.act as ActResult) : ((x.screen as string[] | undefined) ?? []).join('\n')].join('\n');
    case 'clear':
      return `${x.app}: ${x.cleared} notification${x.cleared === 1 ? '' : 's'} cleared`;
    case 'grant':
      return `${x.app}: ${x.note}`;
    case 'status':
      return [`${x.app} on ${x.device}`, ...(x.lines as string[]).map(l => `  ${l}`)].join('\n');
    case 'bind':
      return `token ${String(x.token).slice(0, 12)}… → ${x.device}`;
    case 'log': {
      const log = x.log as PushRecord[];
      const now = Date.now();
      const head = x.gateway ? `push gateway :${x.gateway}` : 'push gateway not running';
      return [head, ...(log.length ? log.map(r => `  ${seconds(now - r.at)} ago  ${r.source ?? 'push'}  ${r.sent} → ${fmtPushLine(r)}`) : ['  no pushes yet'])].join('\n');
    }
    default: {
      const r = x as unknown as PushResult;
      return [fmtPushLine(r), `  sent ${r.sent}${r.via ? ` · via ${r.via}` : ''}`, ...(r.notes ?? []).map(n => `  note: ${n}`)].join('\n');
    }
  }
};

export const formatResult = (method: string, r: unknown): string => {
  const x = r as Record<string, unknown>;
  switch (method) {
    case 'status':
      return fmtStatus(x as Parameters<typeof fmtStatus>[0]);
    case 'up': {
      const lines = fmtServices(x.services as ServiceState[]);
      const mock = x.mock as {port: number} | undefined;
      if (mock) lines.push(`✓ llm-mock :${mock.port}`);
      const push = x.push as {port: number; running: boolean; error?: string} | undefined;
      if (push) lines.push(push.running ? `✓ push gateway :${push.port}` : `⚠ push gateway :${push.port} not started: ${push.error ?? 'unknown error'}`);
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
    case 'mouse':
    case 'rotary':
    case 'touchpad':
      return fmtAct(r as ActResult);
    case 'posture':
      return `${x.serial ?? x.udid}: ${x.posture === 'reset' ? 'posture back to the hinge' : `posture ${x.posture}${x.already ? ' already' : ''}`}${x.angle !== undefined && String(x.angle) !== x.posture ? ` ${x.angle}°` : ''}${x.screen ? `, ${x.screen}` : ''} (states: ${(x.states as string[]).join(', ')})`;
    case 'rotate':
      return `${x.serial ?? x.udid}: ${x.rotation === 'auto' ? 'rotation follows the sensor' : `rotation locked at ${x.rotation}°`}`;
    case 'xr':
      return `${x.serial}: ${x.op}${x.value ? ` ${x.value}` : ''}`;
    case 'car':
    case 'wear':
      return `${x.serial}: ${x.op}${x.detail ? ` — ${x.detail}` : ''}`;
    case 'window':
      if (Array.isArray(x.windows)) return fmtMacWindows(x.serial as string, x.selected as string, x.windows as MacWindow[]);
      if (typeof x.window === 'string') return `${x.serial}: driving ${x.window}${x.size ? ` (${x.size})` : ''}`;
      return `${x.serial}: ${x.mode === 'fullscreen' ? 'app fullscreen' : x.mode === 'resize' ? `window resized to ${x.bounds}` : `app in a freeform window${x.bounds ? ` at ${x.bounds}` : ''}`}`;
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
    case 'perf': {
      if (x.reset) {
        const tracing = x.tracing === true ? ' · platform trace started' : typeof x.tracing === 'string' ? ` · ${x.tracing}` : '';
        return `${String(x.note ?? 'frame stats reset')}${x.jsProfiling ? ' · JS profiler started' : ''}${x.reactRecording ? ' · React commits recorded' : ''}${tracing} — interact, then read perf`;
      }
      // Without a frame counter (simulators) only the memory line, not a row of question marks.
      const head =
        x.frames === undefined
          ? `memory ${x.memoryMb ?? '?'} MB${x.note ? ` · ${x.note}` : ''}`
          : // With no frames Android still prints percentiles: the top bucket of an empty histogram (4950 ms).
            x.frames === 0
            ? `frames 0 — nothing drawn since the reset (no motion, or the app draws on a surface of its own) · memory ${x.memoryMb ?? '?'} MB`
          : `frames ${x.frames ?? '?'} · janky ${x.janky ?? '?'}% · frame time p50 ${x.p50 ?? '?'} ms, p90 ${x.p90 ?? '?'} ms, p99 ${x.p99 ?? '?'} ms · memory ${x.memoryMb ?? '?'} MB`;
      return [head, ...fmtJsProfile(x.js as JsProfile | undefined), ...fmtRenders(x.react as ReactRenders | undefined), ...fmtTrace(x.trace as (TraceSummary & {note?: string}) | undefined)].join('\n');
    }
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
      return f.apps
        .map(a => {
          const hot = a.hot ? ` · ${a.hot.updates} hot update${a.hot.updates === 1 ? '' : 's'}, the last ${a.hot.lastS}s ago (${a.hot.modules} module${a.hot.modules === 1 ? '' : 's'})` : '';
          if (a.compileError) return [`✗ app ${a.id} (${a.platform}): ${a.note}${hot}`, ...a.compileError.split('\n').filter(l => l.trim()).slice(0, 8).map(l => `    ${l}`)].join('\n');
          if (!a.fresh) return `✗ app ${a.id} (${a.platform}) is stale: ${a.note}${hot}`;
          return a.latest === a.bundle || !a.hot ? `✓ app ${a.id} (${a.platform}) runs the newest bundle ${a.bundle}${hot}` : `✓ app ${a.id} (${a.platform}) runs the newest code: bundle ${a.bundle} with hot updates${hot}`;
        })
        .join('\n');
    }
    case 'devEmbed': {
      const r = x as unknown as EmbedResult & {notIgnored: string[]};
      const lines = r.bundles.map(b => (b.error ? `✗ ${b.platform}: ${b.error}` : `✓ ${b.platform}: ${b.kind} ${b.kb} KB in ${seconds(b.ms)} → ${b.file}`));
      if (r.build) lines.push(`${r.build.code === 0 ? '✓' : '✗'} build in ${seconds(r.build.ms)}: ${r.build.command}`, ...(r.build.code === 0 ? [] : r.build.tail.map(l => `    ${l}`)));
      else if (!r.bundles.some(b => b.error)) lines.push('no build command (devserver.embed.build): build the app now; it runs its own bundle when no dev server answers');
      for (const f of r.notIgnored) lines.push(`! ${f} is not ignored by git: keep it out of commits (.gitignore)`);
      return lines.join('\n');
    }
    case 'pair':
      if (x.serial) return `connected ${x.serial} over Wi-Fi`;
      if (x.waiting) return `still waiting for a phone to scan the QR (${x.file})`;
      return [
        x.terminal as string | undefined,
        `QR: ${x.file}`,
        'on the phone: Developer options → Wireless debugging → Pair device with QR code, on the same network; then pair wait',
      ]
        .filter(Boolean)
        .join('\n');
    case 'push':
      return fmtPush(x);
    case 'llm': {
      type Rule = {id: string; action: string; match?: string; text?: string; status?: number; ms?: number; once?: boolean};
      type Req = {at: number; model: string; stream: boolean; prompt: string; source: string; status: number; reply?: string};
      const rules = (x.rules as Rule[]).map(r => `${r.id}: ${r.action}${r.action === 'fail' ? ` ${r.status}` : r.action === 'delay' ? ` ${r.ms} ms` : ` ${JSON.stringify((r.text ?? '').slice(0, 80))}`}${r.match ? ` for /${r.match}/` : ' for every prompt'}${r.once ? ' (once)' : ''}`);
      const head = `LLM mock :${x.port} · ${x.requests} request${x.requests === 1 ? '' : 's'} · ${x.fixtures} fixture${x.fixtures === 1 ? '' : 's'}`;
      const now = Date.now();
      const log = ((x.log as Req[] | undefined) ?? []).map(r => `  ${seconds(now - r.at)} ago  ${r.status}  ${JSON.stringify(r.prompt.slice(0, 80))} → ${r.source}${r.reply !== undefined ? `: ${JSON.stringify(r.reply.slice(0, 60))}` : ''}`);
      return [head, ...(rules.length ? rules : ['no rules: replies come from the fixtures']), ...(x.log ? (log.length ? ['requests:', ...log] : ['no requests yet']) : [])].join('\n');
    }
    case 'trace': {
      const found = x.found as {name: string; lines: string[]}[];
      const when = x.at ? ` (the last action, ${seconds(Date.now() - (x.at as number))} ago)` : '';
      if (!found.length) return `trace ${x.id}${when}: no line in the logs of ${x.searched} service(s) and actor(s) mentions it — the backend may not log the trace id of the traceparent header`;
      return [`trace ${x.id}${when}`, ...found.flatMap(s => [`${s.name} (${s.lines.length} line${s.lines.length === 1 ? '' : 's'})`, ...s.lines.map(l => `  ${l.length > 220 ? `${l.slice(0, 220)}…` : l}`)])].join('\n');
    }
    case 'jsEval': {
      const e = x as unknown as EvalResult;
      const where = e.apps > 1 ? `  (in ${e.app}${e.picked ? '' : `; ${e.apps} apps are debuggable — pick one with device`})` : '';
      return `${e.error !== undefined ? `! ${e.error}` : `= ${e.value}`}${where}`;
    }
    case 'jsLog': {
      const lp = x.logpoint as Logpoint;
      return [
        `${lp.id} at ${fmtLogpoint(lp)}`,
        ...(x.reloaded ? ['reloaded the app to source: host bytecode has no debug info for locals (js clear returns to bytecode on the next start)'] : []),
        'the values come with: js hits',
      ].join('\n');
    }
    case 'jsHits': {
      const lps = x.logpoints as Logpoint[];
      if (!lps.length) return 'no logpoints — set one with js log <file:line> [expr…]';
      const now = Date.now();
      const out = lps.flatMap(lp => [
        `${lp.id} at ${fmtLogpoint(lp)} · ${lp.count} hit${lp.count === 1 ? '' : 's'}${lp.error ? ` · ! ${lp.error}` : ''}`,
        ...lp.hits.map(h => `  ${seconds(now - h.at)} ago  ${h.v || '(hit)'}`),
      ]);
      if (x.paused) out.push(`(the app stopped at ${x.paused} other breakpoint(s) or debugger statement(s); pitbox let it go on)`);
      return out.join('\n');
    }
    case 'jsClear': {
      const ids = x.cleared as string[];
      return `cleared ${ids.join(', ') || 'nothing'}${x.bytecodeBack ? ' · the app gets bytecode again on its next start' : ''}`;
    }
    case 'appConsole': {
      type Line = {l: string; at: number; m: string; from?: string};
      const apps = x.apps as {app: number; platform?: string; total: number; matching: number; entries: Line[]}[];
      if (!apps.length) return 'no app connected';
      const now = Date.now();
      const letter: Record<string, string> = {debug: 'D', log: 'L', info: 'I', warn: 'W', error: 'E'};
      return apps
        .map(a => {
          const head = `app ${a.app} (${a.platform ?? '?'}) · ${a.matching === a.total ? a.total : `${a.matching} of ${a.total}`} entries${a.entries.length < a.matching ? `, the last ${a.entries.length}` : ''}`;
          const lines = a.entries.map(e => {
            const [first = '', ...more] = e.m.split('\n');
            const text = first.length > 300 ? `${first.slice(0, 300)}…` : first;
            return `  ${seconds(now - e.at)} ago  ${letter[e.l] ?? '?'}  ${text}${more.length ? ` (+${more.length} lines)` : ''}${e.from ? `  ← ${e.from}` : ''}`;
          });
          return [head, ...lines].join('\n');
        })
        .join('\n');
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
      return [
        ...fmtDevices(x.devices as AndroidDevice[], x.avds as {name: string; kind: string}[], x.simulators as SimRow[] | undefined),
        ...(x.simulatorsError ? [`✗ simulators: ${x.simulatorsError}`] : []),
        ...((x.web as {name: string; url: string}[] | undefined) ?? []).map(w => `· ${w.name}  ${w.url}`),
        ...((x.mac as {name: string; app: string}[] | undefined) ?? []).map(m => `· ${m.name}  ${m.app}`),
      ].join('\n');
    case 'doctor':
      return fmtDoctor(x as unknown as DoctorReport);
    case 'tool':
      return fmtTool(x as unknown as ToolResult);
    case 'actors':
      return fmtActors(r as ActorState[]).join('\n') || 'no actors running';
    case 'actorStart':
      return fmtActors([r as ActorState]).join('\n');
    case 'actorStop':
      return `stopped actor ${x.name} (${x.type})`;
    case 'reverse': {
      const applied = (x.applied as {serial: string; ports: number[]}[] | undefined) ?? [];
      const where = applied.length ? ` · set up on ${applied.map(a => a.serial).join(', ')}` : x.devices ? ' · already in place' : ' · no Android device online';
      return `forwarded to devices: ${((x.ports as number[]) ?? []).join(', ') || 'no exposed ports'}${where}`;
    }
    case 'actorCall':
      return `HTTP ${x.status}\n${String(x.body).slice(0, 6000)}`;
    case 'tools':
      return (r as {name: string; description: string; params: {name: string; optional: boolean}[]}[]).map(t => `${t.name}(${t.params.map(p => (p.optional ? `${p.name}?` : p.name)).join(', ')}) — ${t.description}`).join('\n') || 'no tools configured';
    case 'boot':
      return (
        (x.already ? `${x.avd ?? x.name} already running as ${x.serial ?? x.udid}` : `${x.avd ?? x.name} booted as ${x.serial ?? x.udid} in ${seconds(x.ms as number)}`) +
        (x.instead ? `\ninstead: ${x.instead}` : '') +
        (x.note ? `\nnote: ${x.note}` : '') +
        (x.warning ? `\nwarning: ${x.warning}` : '')
      );
    case 'install':
      return `installed${x.bundleId ? ` ${x.bundleId}` : ''} on ${x.serial ?? x.udid} in ${seconds(x.ms as number)}${x.replaced ? ' (uninstalled the old build first)' : ''}`;
    case 'open':
    {
      const b = x.bundle as {kind: string; kb: number; ms: number; note?: string} | undefined;
      const parts = [
        x.totalMs !== undefined ? `${x.udid ? 'launch' : 'activity'} ${x.totalMs} ms` : '',
        x.jsMs !== undefined ? `JS running at ${seconds(x.jsMs as number)}` : '',
        b ? `${b.kind} bundle ${(b.kb / 1024).toFixed(1)} MB in ${b.ms} ms${b.note ? `, ${b.note}` : ''}` : '',
      ].filter(Boolean);
      return `opened ${x.target} on ${x.serial ?? x.udid}${parts.length ? ` (${parts.join(' · ')})` : ''}`;
    }
    case 'screenshot':
      return `${x.file} (${Math.round((x.bytes as number) / 1024)} KB)`;
    case 'shutdown':
      return (x.gone ? `${x.serial ?? x.udid} shut down in ${seconds(x.ms as number)}` : `${x.serial ?? x.udid} still listed after ${seconds(x.ms as number)}`) + (x.note ? `\nnote: ${x.note}` : '');
    case 'cleanDevices':
      return (x.deleted as string[]).length ? `deleted ${(x.deleted as string[]).join(', ')}` : 'no simulators pitbox created are left over';
    case 'lease':
      return `${x.leased} (${x.id}) is held by "${x.label}"${x.booted ? ', booted by it' : ''}`;
    case 'release':
      return `released ${x.released}${x.gone !== undefined ? (x.gone ? `, shut down in ${seconds(x.ms as number)}` : ', still listed after shutdown') : ''}${x.note ? `\nnote: ${x.note}` : ''}`;
    case 'apps':
      return (x.packages as string[]).join('\n') || 'no third-party packages';
    case 'downloads': {
      const list = x.downloads as WebDownload[];
      const rel = (f: string) => (x.root ? path.relative(x.root as string, f) : f);
      if (!list.length) return `no downloads on ${x.serial} yet (they are saved to ${rel(x.dir as string)})`;
      const size = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
      const line = (d: WebDownload) =>
        d.state === 'failed'
          ? `✗ ${d.name}: ${d.error ?? 'failed'} (${d.url})`
          : d.state === 'saving'
            ? `… ${d.name} still downloading (${d.url})`
            : `✓ ${d.name} · ${size(d.size ?? 0)} · ${d.type ?? 'unknown type'} · ${rel(d.file!)}`;
      return [...(x.waited !== undefined ? [`new download after ${seconds(x.waited as number)}:`] : []), ...list.map(line)].join('\n');
    }
    default:
      return fmtObject(r);
  }
};
