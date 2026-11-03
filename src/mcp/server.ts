// MCP server on stdio. A thin client of the project's daemon: every tool is one daemon call, answered in the
// same compact text the CLI prints. Project tools from the config become MCP tools of their own.

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {loadConfig} from '../config/load.ts';
import type {PitboxConfig} from '../config/schema.ts';
import {connect, resolveProject, type DaemonClient} from '../daemon/client.ts';
import {VERSION} from '../daemon/info.ts';
import {formatResult} from '../format.ts';

type Shape = Record<string, z.ZodType>;

const device = z.string().optional().describe('serial or AVD; default: the only online device');

type Caller = {call: (method: string, params: Record<string, unknown>) => Promise<unknown>};
type ToolServer = {registerTool: (name: string, def: {description: string; inputSchema: Shape}, handler: (args: Record<string, unknown>) => Promise<{content: {type: 'text'; text: string}[]; isError?: boolean}>) => unknown};

/** Registers every tool on `server`; separate from the transport so a test can call each tool against a fake. */
export const registerTools = (server: ToolServer, config: PitboxConfig, daemon: () => Promise<Caller>, onError: () => void = () => undefined) => {

  // `method` may depend on the arguments (tools with an `action`).
  const tool = (name: string, description: string, shape: Shape, method: string | ((a: Record<string, unknown>) => string), map: (a: Record<string, unknown>) => Record<string, unknown> = a => a) => {
    server.registerTool(name, {description, inputSchema: shape}, async (args: Record<string, unknown>) => {
      try {
        const c = await daemon();
        const m = typeof method === 'string' ? method : method(args);
        const result = await c.call(m, map(args));
        return {content: [{type: 'text' as const, text: formatResult(m, result)}]};
      } catch (e) {
        onError();
        return {content: [{type: 'text' as const, text: (e as Error).message}], isError: true};
      }
    });
  };

  // Few tools, short descriptions: an agent pays for every schema in every session. Frequent actions have their
  // own tool; rarer ones share one with an `action`.
  const opt = {
    str: () => z.string().optional(),
    num: () => z.number().optional(),
    bool: () => z.boolean().optional(),
    list: () => z.array(z.string()).optional(),
  };
  const params = z.record(z.string(), z.string()).optional();
  const target = z.string().describe('@ref, id=…, text=… (text~= contains), label=…, words, or x,y');

  // Stand
  tool('status', 'Services, dev server, devices, forwarded ports.', {}, 'status');
  tool(
    'stand',
    'Services: up (all autostart, or named; running ones are adopted), down, restart, logs <name>.',
    {action: z.enum(['up', 'down', 'restart', 'logs']), services: opt.list(), name: opt.str(), lines: opt.num(), grep: opt.str()},
    a => ({up: 'up', down: 'down', restart: 'restart', logs: 'logs'})[a.action as string]!,
  );
  if (config.actors && Object.keys(config.actors).length) {
    tool('actor', 'Extra app users: start <type> <name>, stop <name>, call <name> with a JSON body.', {action: z.enum(['start', 'stop', 'call']), type: opt.str(), name: z.string(), port: opt.num(), body: z.record(z.string(), z.unknown()).optional()}, a => ({start: 'actorStart', stop: 'actorStop', call: 'actorCall'})[a.action as string]!);
  }
  for (const [name, t] of Object.entries(config.tools ?? {})) {
    const shape: Shape = Object.fromEntries(Object.entries(t.params ?? {}).map(([k, d]) => [k, z.string().describe(d)]));
    tool(`tool_${name}`, t.description ?? t.run, shape, 'tool', a => ({name, params: a}));
  }

  // Dev server
  if (config.devserver) {
    tool(
      'dev',
      'Dev server: status (device requests, bytecode), fresh (does the app run the newest code?), prewarm, reload, qr (connect link; lan for Wi-Fi).',
      {action: z.enum(['status', 'fresh', 'prewarm', 'reload', 'qr']), lan: opt.bool()},
      a => ({status: 'devStatus', fresh: 'fresh', prewarm: 'devPrewarm', reload: 'devReload', qr: 'qr'})[a.action as string]!,
    );
    // Typical answer: one line for eval (values cut at 4 KB), a few lines per logpoint for hits.
    tool(
      'js',
      "The app's JS runtime: eval <expr> (global scope; statements and promises fine); log at=<file:line> exprs=[…] records the values each time the line runs (locals included), without stopping the app or editing code — a bytecode app reloads to source once; hits [id]; clear [id].",
      {action: z.enum(['eval', 'log', 'hits', 'clear']), expr: opt.str(), at: opt.str(), exprs: opt.list(), id: opt.str(), timeout: opt.num(), device},
      a => ({eval: 'jsEval', log: 'jsLog', hits: 'jsHits', clear: 'jsClear'})[a.action as string]!,
    );
    tool(
      'net',
      'Network rules inside the app: fail, mock (status/body), delay (ms), freeze (WebSocket silent but open), offline, clear, list. match: URL substring or *.',
      {action: z.enum(['fail', 'mock', 'delay', 'freeze', 'offline', 'clear', 'list']), match: opt.str(), kind: z.enum(['http', 'ws']).optional(), status: opt.num(), body: z.unknown().optional(), ms: opt.num()},
      'net',
    );
  }

  // Devices and the app
  tool(
    'device',
    'Devices: list, boot <avd|simulator>, shutdown, info, reverse (forward stand ports now); posture value=closed|half|open|rear|reset (foldables), rotate value=0|90|180|270|auto, window value="freeform [x,y,w,h]"|fullscreen|"resize x,y,w,h" (relaunches the app), wear value="tile add|show|remove <component>"|"face <package>"|"ambient on|off"|home, xr value="look yaw,pitch"|"move dx,dy,dz"|recenter|"panel minimize|close|menu|info|spatial-audio|tidy|close-app", car value=day|night|auto|"drive [m/s]"|park|"rotary cw|ccw [n]".',
    {action: z.enum(['list', 'boot', 'shutdown', 'info', 'reverse', 'posture', 'rotate', 'window', 'wear', 'xr', 'car']), avd: opt.str(), wipe: opt.bool(), value: opt.str(), device},
    a => ({list: 'devices', boot: 'boot', shutdown: 'shutdown', info: 'info', reverse: 'reverse', posture: 'posture', rotate: 'rotate', window: 'window', wear: 'wear', xr: 'xr', car: 'car'})[a.action as string]!,
  );
  tool(
    'app',
    'The app: open (or a deep link target; relaunch), install <apk|.app> (replace: uninstall first), stop, clear, uninstall, logs.',
    {action: z.enum(['open', 'install', 'stop', 'clear', 'uninstall', 'logs']), target: opt.str(), relaunch: opt.bool(), apk: opt.str(), replace: opt.bool(), lines: opt.num(), grep: opt.str(), device},
    a => ({open: 'open', install: 'install', stop: 'stopApp', clear: 'clearApp', uninstall: 'uninstall', logs: 'appLogs'})[a.action as string]!,
  );
  tool(
    'settings',
    'Device settings: fontScale, dark, animations, size/density ("reset"), locale (app), grant/revoke permission, network (full|lte|umts|edge|gsm|offline|online).',
    {fontScale: opt.num(), dark: opt.bool(), animations: opt.bool(), size: opt.str(), density: opt.str(), locale: opt.str(), grant: opt.str(), revoke: opt.str(), network: opt.str(), device},
    a => (a.network ? 'network' : 'settings'),
    a => (a.network ? {device: a.device, profile: a.network} : a),
  );

  // UI — every action waits for the UI to settle and answers with what changed.
  tool('snapshot', 'The screen as lines with refs (@e12). Once per new screen; actions then answer with diffs.', {bounds: opt.bool(), system: opt.bool(), device}, 'snapshot');
  tool('press', 'Tap (kind: longpress, doubletap; right = mouse right click, hover = mouse over).', {target, kind: z.enum(['tap', 'longpress', 'doubletap', 'right', 'hover']).optional(), device}, a =>
    a.kind === 'right' || a.kind === 'hover' ? 'mouse' : 'press',
    a => (a.kind === 'right' || a.kind === 'hover' ? {...a, action: a.kind} : a),
  );
  tool('fill', 'Replace a field\'s text.', {target, text: z.string(), device}, 'fill');
  tool('type', 'Append text to the focused field.', {text: z.string(), device}, 'type');
  tool('touchpad', 'The temple touchpad of AI glasses: forward/back/up/down swipes move focus, tap presses.', {gesture: z.enum(['forward', 'back', 'up', 'down', 'tap']), device}, 'touchpad');
  tool('key', 'Keys: back home up down left right center enter menu, media/TV (play next channel_up guide …), watch (stem_1), combos (ctrl+c), or keycodes.', {keys: z.array(z.string()), device}, 'uiKey');
  tool(
    'swipe',
    'Swipe up/down/left/right or "x1,y1,x2,y2" (duration ms = velocity); with until, scroll until the target shows; via=wheel (mouse) or rotary (watch crown) turns steps notches up/down instead.',
    {direction: z.string(), duration: opt.num(), until: opt.str(), via: z.enum(['wheel', 'rotary']).optional(), steps: opt.num(), target: opt.str(), device},
    a => (a.via === 'wheel' ? 'mouse' : a.via === 'rotary' ? 'rotary' : a.until ? 'scroll' : 'swipe'),
    a => (a.via === 'wheel' ? {...a, action: 'wheel'} : a),
  );
  tool('touch', 'A finger held across calls: down <target>, move <target>, up.', {phase: z.enum(['down', 'move', 'up']), target: opt.str(), device}, 'touch');
  tool('wait', 'Wait for a target (gone: until it disappears; timeout s).', {target, gone: opt.bool(), timeout: opt.num(), device}, 'wait');
  tool(
    'inspect',
    'Checks: media (video playing?), visual <name> (vs baseline; update, masks), focus, focus_map (D-pad audit), perf (reset first), tree (React tree from inside), network (app requests), errors (JS errors, source stacks), console (app console, level=warn|error, grep; warnings point at their source line), screenshot (file path).',
    {what: z.enum(['media', 'visual', 'focus', 'focus_map', 'perf', 'tree', 'network', 'errors', 'console', 'screenshot']), target: opt.str(), name: opt.str(), update: opt.bool(), masks: opt.list(), reset: opt.bool(), level: z.enum(['log', 'warn', 'error']).optional(), grep: opt.str(), device},
    a => ({media: 'media', visual: 'visual', focus: 'focus', focus_map: 'focusMap', perf: 'perf', tree: 'appTree', network: 'appLog', errors: 'appErrors', console: 'appConsole', screenshot: 'uiShot'})[a.what as string]!,
  );

  // Flows — run in the daemon: one call, one verdict.
  tool(
    'run',
    'Run a flow (file name or inline steps) in the daemon: one verdict; on failure the line, error, crashes and screen. matrix: once per config variant.',
    {flow: opt.str(), steps: opt.str(), params, matrix: opt.bool(), device},
    a => (a.matrix ? 'matrix' : 'run'),
  );
  tool('goto', 'Open a screen by a config route.', {route: z.string(), params, device}, 'goto');
  tool('as', 'Sign in as a user (config signIn flow).', {user: z.string(), device}, 'as');
  tool(
    'state',
    'Stand states (emulator snapshot + backend dump): save, restore, list.',
    {action: z.enum(['save', 'restore', 'list']), name: opt.str(), device},
    a => ({save: 'stateSave', restore: 'stateRestore', list: 'stateList'})[a.action as string]!,
  );
  tool('record', 'Record actions as flow steps: start, stop (name saves a file).', {action: z.enum(['start', 'stop']), name: opt.str(), device}, a => (a.action === 'start' ? 'recordStart' : 'recordStop'));

  // Support
  tool('doctor', 'Known problems with remedies (fix applies them).', {fix: opt.bool(), only: opt.list()}, 'doctor');
  tool('docs', 'Project documents: list, toc, section <query>, grep <query>, lines from–to.', {name: opt.str(), op: z.enum(['toc', 'section', 'grep', 'lines']).optional(), query: opt.str(), from: opt.num(), to: opt.num()}, 'docs');
};

export const startMcp = async (opts: {config?: string} = {}) => {
  const {file} = resolveProject(opts);
  const {config} = await loadConfig({file});
  const server = new McpServer({name: 'pitbox', version: VERSION});
  let client: DaemonClient | undefined;
  registerTools(server as unknown as ToolServer, config, async () => (client ??= await connect({config: file})), () => (client = undefined));
  await server.connect(new StdioServerTransport());
};
