// MCP server on stdio. A thin client of the project's daemon: every tool is one daemon call, answered in the
// same compact text the CLI prints. Project tools from the config become MCP tools of their own.

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {loadConfig} from '../config/load.ts';
import {toolParams, type PitboxConfig} from '../config/schema.ts';
import {connect, refused, resolveProject, type DaemonClient} from '../daemon/client.ts';
import {stopProjectDaemon, waitDaemonGone} from '../daemon/stop.ts';
import {VERSION} from '../daemon/info.ts';
import {formatResult} from '../format.ts';

type Shape = Record<string, z.ZodType>;

const device = z.string().optional().describe('serial, AVD, simulator, web:<app> or mac:<app> (a web or Mac app from the config); default: the only online device');

type Caller = {call: (method: string, params: Record<string, unknown>) => Promise<unknown>; note?: string};
type ToolServer = {registerTool: (name: string, def: {description: string; inputSchema: Shape}, handler: (args: Record<string, unknown>) => Promise<{content: {type: 'text'; text: string}[]; isError?: boolean}>) => unknown};

/** Registers every tool on `server`; separate from the transport so a test can call each tool against a fake. */
/**
 * What runs on the MCP server's side rather than in the daemon: stopping the daemon itself (`stand action=stop`), and
 * waiting for it to go after a whole-stand `down` answered that it stops (the next call then starts a new one).
 */
export type LocalHooks = {stopDaemon?: () => Promise<string>; daemonStopping?: (c: Caller) => Promise<string | undefined>};

/** The method name `stand action=stop` maps to: handled by the MCP server, never sent to the daemon. */
export const STOP_DAEMON = 'stopDaemon';

export const registerTools = (server: ToolServer, config: PitboxConfig, daemon: () => Promise<Caller>, onError: () => void = () => undefined, hooks: LocalHooks = {}) => {

  // `method` may depend on the arguments (tools with an `action`).
  const tool = (name: string, description: string, shape: Shape, method: string | ((a: Record<string, unknown>) => string), map: (a: Record<string, unknown>) => Record<string, unknown> = a => a) => {
    server.registerTool(name, {description, inputSchema: shape}, async (args: Record<string, unknown>) => {
      try {
        const m = typeof method === 'string' ? method : method(args);
        if (m === STOP_DAEMON) {
          if (!hooks.stopDaemon) throw new Error('stopping the daemon is not available here');
          const text = await hooks.stopDaemon();
          onError();
          return {content: [{type: 'text' as const, text}]};
        }
        let c = await daemon();
        let result: unknown;
        try {
          result = await c.call(m, map(args));
        } catch (e) {
          // The daemon this server knew is gone (a `down` or `daemon stop` from elsewhere): nothing reached it, so the
          // call goes once more, to the project's daemon as it is now — started again when none runs.
          if (!refused(e)) throw e;
          onError();
          c = await daemon();
          result = await c.call(m, map(args));
        }
        if ((result as {daemon?: string} | undefined)?.daemon === 'stopping') {
          onError();
          const left = await hooks.daemonStopping?.(c);
          if (left) result = {...(result as object), daemon: left};
        }
        // A note about the daemon (one of another version kept as it is) reaches the agent once.
        const note = c.note;
        c.note = undefined;
        return {content: [{type: 'text' as const, text: note ? `${note}\n${formatResult(m, result)}` : formatResult(m, result)}]};
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
  // Route and flow parameters end up in a URL or a flow's text: a number or a boolean is taken as its string.
  const params = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('name → value; numbers and booleans are fine');
  const target = z.string().describe('@ref, id=…, text=… (text~= contains), label=…, words, or x,y');

  // Stand
  tool('status', 'Services, dev server, devices, forwarded ports.', {}, 'status');
  tool(
    'stand',
    "Services: up (all autostart, or named; running ones are adopted), down (all: also gives the devices back and stops the project's daemon with the browsers it started; keep=true keeps the daemon), restart, logs <name>, stop (the project's daemon now, with its browsers; devices given back).",
    {action: z.enum(['up', 'down', 'restart', 'logs', 'stop']), services: opt.list(), name: opt.str(), lines: opt.num(), grep: opt.str(), keep: opt.bool()},
    a => ({up: 'up', down: 'down', restart: 'restart', logs: 'logs', stop: STOP_DAEMON})[a.action as string]!,
    a => (a.action === 'down' && a.keep ? {...a, keepDaemon: true} : a),
  );
  if (config.actors && Object.keys(config.actors).length) {
    tool('actor', 'Extra app users: start <type> <name>, stop <name>, call <name> with a JSON body.', {action: z.enum(['start', 'stop', 'call']), type: opt.str(), name: z.string(), port: opt.num(), body: z.record(z.string(), z.unknown()).optional()}, a => ({start: 'actorStart', stop: 'actorStop', call: 'actorCall'})[a.action as string]!);
  }
  if (config.mocks?.llm) {
    // Typical answer: a line per rule and per logged request.
    tool(
      'llm',
      'The LLM mock: log (requests: prompt, which reply), reply text=… (forced answer), fail status=500|429, delay ms=…, each for prompts matching `match` (regex) or all, once=true for one request; clear (rules), reload (fixtures).',
      {action: z.enum(['log', 'reply', 'fail', 'delay', 'clear', 'reload']), match: opt.str(), text: opt.str(), status: opt.num(), ms: opt.num(), once: opt.bool(), limit: opt.num()},
      'llm',
    );
  }
  // Typical answer: the matching log lines per service, up to 20 each.
  tool('trace', "What the stand's services and actors logged for an action: its trace id (from the action's answer, or the last action) searched in their logs.", {id: opt.str(), lines: opt.num()}, 'trace');
  for (const [name, t] of Object.entries(config.tools ?? {})) {
    const shape: Shape = Object.fromEntries(toolParams(t).map(p => [p.name, p.optional ? z.string().optional().describe(p.description) : z.string().describe(p.description)]));
    tool(`tool_${name}`, t.description ?? t.run, shape, 'tool', a => ({name, params: a}));
  }

  // Dev server
  if (config.devserver) {
    tool(
      'dev',
      'Dev server: status (device requests, bytecode), fresh (does the app run the newest code?), prewarm, reload, qr (connect link; lan for Wi-Fi), embed (the bundle into the app\'s sources and the configured build: an app that runs with no dev server).',
      {action: z.enum(['status', 'fresh', 'prewarm', 'reload', 'qr', 'embed']), lan: opt.bool()},
      a => ({status: 'devStatus', fresh: 'fresh', prewarm: 'devPrewarm', reload: 'devReload', qr: 'qr', embed: 'devEmbed'})[a.action as string]!,
    );
    // Typical answer: one line for eval (values cut at 4 KB), a few lines per logpoint for hits.
    tool(
      'js',
      "The app's JS runtime: eval <expr> (global scope; statements and promises fine); log at=<file:line> exprs=[…] records the values each time the line runs (locals included), without stopping the app or editing code — a bytecode app reloads to source once; hits [id] (with 0 hits it says which: the line has not run, the app restarted since and start-up code ran before the logpoint was placed again, or the app is not attached); clear [id].",
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
    'Devices: list (with who holds each), boot <avd|simulator> (leased to this session; when another session holds it, a free one of the same model or a new instance instead; audio=true starts an Android emulator with audio, which mic needs), shutdown (only a device this session holds; force=true otherwise), lease (hold a device; value=purpose), release (give it back: one pitbox booted shuts down unless keep=true), clean (delete the shut-down simulators and AVDs pitbox created for this project; force=true also those an older pitbox recorded without a project), info, reverse (forward stand ports now); pair (a phone on Wi-Fi: a QR to scan in Wireless debugging, then value=wait; or value="<ip:port> <code>"; value=watch pairs a watch with the phone this session holds, both leased: an Apple Watch simulator with an iPhone (watch=<name|udid>, default apple.watch) or a Wear OS emulator with an Android phone emulator through a Data Layer stand-in (watch=<avd|serial>, default android.watch; asked again: the last messages relayed) — then device=watch names it), unpair value=watch (the pair pitbox made goes, the watch is given back); posture value=closed|half|open|rear|reset (foldables), rotate value=0|90|180|270|auto, window value="freeform [x,y,w,h]"|fullscreen|"resize x,y,w,h" (relaunches the app; on mac:<app> value="<title>"|#2|front picks the window to drive, none lists them), wear value="tile add|show|remove <component>"|"face <package>"|"ambient on|off"|home, xr value="look yaw,pitch"|"move dx,dy,dz"|"spin yaw,pitch,roll,ms"|"drift dx,dy,dz,ms"|recenter|"env day|night"|"passthrough 0…1"|options|"panel minimize|close|menu|info|spatial-audio|tidy|close-app", car value=day|night|auto|"drive [m/s]"|park|"rotary cw|ccw [n]", widget value="add <name> [app=<label>] [size=4x2|small|medium|large|extra large]"|"remove <name>"|"list [app]" (home-screen widgets, Android 10+: Launcher3 / Pixel Launcher; iOS simulators: SpringBoard, which names widgets by app), mic value=<file.wav> (plays a PCM WAV, up to 48 kHz, into an Android emulator\'s microphone in real time and answers when it has played: one line; the emulator needs boot audio=true).',
    {action: z.enum(['list', 'boot', 'shutdown', 'lease', 'release', 'clean', 'info', 'reverse', 'pair', 'unpair', 'posture', 'rotate', 'window', 'wear', 'xr', 'car', 'widget', 'mic']), avd: opt.str(), wipe: opt.bool(), audio: opt.bool(), value: opt.str(), watch: opt.str(), force: opt.bool(), keep: opt.bool(), device},
    a => ({list: 'devices', boot: 'boot', shutdown: 'shutdown', lease: 'lease', release: 'release', clean: 'cleanDevices', info: 'info', reverse: 'reverse', pair: 'pair', unpair: 'unpair', posture: 'posture', rotate: 'rotate', window: 'window', wear: 'wear', xr: 'xr', car: 'car', widget: 'widget', mic: 'mic'})[a.action as string]!,
    a => (a.action === 'lease' ? {...a, purpose: a.value} : a.action === 'clean' ? {all: a.force} : a),
  );
  // Typical answer for downloads: a line per file (name, size, type, path), the last 10.
  tool(
    'app',
    'The app: open (or a deep link target; relaunch; web: relaunch keeps the profile, fresh starts clean), install <apk|.app> (replace: uninstall first), stop, clear, uninstall, logs, downloads (web: saved files; grep name; timeout s waits for a new one).',
    {action: z.enum(['open', 'install', 'stop', 'clear', 'uninstall', 'logs', 'downloads']), target: opt.str(), relaunch: opt.bool(), fresh: opt.bool(), apk: opt.str(), replace: opt.bool(), lines: opt.num(), grep: opt.str(), timeout: opt.num(), device},
    a => ({open: 'open', install: 'install', stop: 'stopApp', clear: 'clearApp', uninstall: 'uninstall', logs: 'appLogs', downloads: 'downloads'})[a.action as string]!,
  );
  tool(
    'settings',
    'Device settings: fontScale, dark, animations, size/density ("reset"), locale (app), grant/revoke permission, network (full|lte|umts|edge|gsm|offline|online). Web: emulate=<Playwright device, "iPhone 15">|reset, size=WxH, density=<scale>, touch, mobile, userAgent, dark, locale (login kept).',
    {fontScale: opt.num(), dark: opt.bool(), animations: opt.bool(), size: opt.str(), density: opt.str(), locale: opt.str(), grant: opt.str(), revoke: opt.str(), network: opt.str(), emulate: opt.str(), touch: opt.bool(), mobile: opt.bool(), userAgent: opt.str(), device},
    a => (a.network ? 'network' : 'settings'),
    a => (a.network ? {device: a.device, profile: a.network} : a),
  );

  // UI — every action waits for the UI to settle and answers with what changed.
  tool('snapshot', 'The screen as lines with refs (@e12). Once per new screen; actions then answer with diffs.', {bounds: opt.bool(), system: opt.bool(), device}, 'snapshot');
  tool('press', 'Tap (kind: longpress, doubletap; right = mouse right click, hover = mouse over). x,y are screen coordinates (the screenshot answer gives the factor from its image); the answer names what a point hit, or says it hit no element.', {target, kind: z.enum(['tap', 'longpress', 'doubletap', 'right', 'hover']).optional(), device}, a =>
    a.kind === 'right' || a.kind === 'hover' ? 'mouse' : 'press',
    a => (a.kind === 'right' || a.kind === 'hover' ? {...a, action: a.kind} : a),
  );
  tool('fill', 'Replace a field\'s text.', {target, text: z.string(), device}, 'fill');
  tool('type', 'Append text to the focused field.', {text: z.string(), device}, 'type');
  tool('touchpad', 'The temple touchpad of AI glasses: forward/back/up/down swipes move focus, tap presses.', {gesture: z.enum(['forward', 'back', 'up', 'down', 'tap']), device}, 'touchpad');
  tool('key', 'Keys: back home up down left right center enter menu, media/TV (play next channel_up guide …), watch (stem_1), combos (ctrl+c), or keycodes. On Vision Pro, keyboard keys (space, arrows, letters, escape, combos) come from the simulator\'s hardware keyboard, as an app\'s GameController reads them; the answer is the usual one line.', {keys: z.array(z.string()), device}, 'uiKey');
  tool(
    'swipe',
    'Swipe up/down/left/right or "x1,y1,x2,y2" (duration ms = velocity); with until, scroll until the target shows; via=wheel (mouse) or rotary (watch crown) turns steps notches up/down instead. hold=ms keeps the finger down at the end and takes the screen halfway through (a scrubber\'s preview under the finger): the answer adds one line, the image\'s path (a JPEG, about 100–300 KB; read it only if needed).',
    {direction: z.string(), duration: opt.num(), until: opt.str(), via: z.enum(['wheel', 'rotary']).optional(), steps: opt.num(), target: opt.str(), hold: opt.num(), device},
    a => (a.via === 'wheel' ? 'mouse' : a.via === 'rotary' ? 'rotary' : a.until ? 'scroll' : 'swipe'),
    a => (a.via === 'wheel' ? {...a, action: 'wheel'} : a),
  );
  tool('touch', 'A finger held across calls: down <target>, move <target>, up.', {phase: z.enum(['down', 'move', 'up']), target: opt.str(), device}, 'touch');
  tool('wait', 'Wait for a target (gone: until it disappears; timeout s), or with no target a plain pause of seconds=n (a countdown, a timer).', {target: target.optional(), gone: opt.bool(), timeout: opt.num(), seconds: opt.num(), device}, 'wait');
  tool(
    'inspect',
    'Checks: media (video playing?), visual <name> (vs baseline; update, masks), focus, focus_map (D-pad audit), perf (reset first; trace=true adds the platform trace), tree (React tree from inside), network (app requests and WebSocket frames: #order, +time, → sent / ← received; with device, only the app on that device), errors (JS errors, source stacks), console (app console, level=warn|error, grep; warnings point at their source line), screenshot (file path; says how image x,y maps to press x,y — the image is downscaled, except on a watch).',
    {what: z.enum(['media', 'visual', 'focus', 'focus_map', 'perf', 'tree', 'network', 'errors', 'console', 'screenshot']), target: opt.str(), name: opt.str(), update: opt.bool(), masks: opt.list(), reset: opt.bool(), level: z.enum(['log', 'warn', 'error']).optional(), grep: opt.str(), trace: opt.bool(), device},
    a => ({media: 'media', visual: 'visual', focus: 'focus', focus_map: 'focusMap', perf: 'perf', tree: 'appTree', network: 'appLog', errors: 'appErrors', console: 'appConsole', screenshot: 'uiShot'})[a.what as string]!,
  );

  // Typical answer: one or two lines — the verdict (notification posted / banner shown / handled in front) and how
  // it was delivered; log is a line per push.
  tool(
    'push',
    'Push notification, no credentials: send title/body/data (or file, apns, fcm raw payload) → one-line verdict from the system UI; tap (latest notification; expect=away when its tap opens another app, such as a page in the browser), respond value=<action identifier or title>|open|dismiss [title=… id=… text=… for a reply] (a notification action: iOS through the PitboxNotifications hook in the app, Android by its button in the shade; an unknown one lists the actions), clear, grant (Android notification permission), status (can the app take pushes), log, bind token=… (stand gateway). delay s, repeat n, wait ms (send: for the notification; log: for a new push to land — a scheduled one or a gateway delivery — answering as soon as it does). iOS Live Activities (a stand-in through the app debug hook): activity event=start|update|end type=<ActivityAttributes> attributes={…} state={…} [stale dismissal relevance alert id token], activities (types, running ones, tokens); a Live Activity payload in send/file/apns/fcm goes the same way. Typical answer: one or two lines.',
    {
      action: z.enum(['send', 'tap', 'respond', 'clear', 'grant', 'status', 'log', 'bind', 'activity', 'activities']).optional(),
      value: opt.str(),
      text: opt.str(),
      event: z.enum(['start', 'update', 'end']).optional(),
      type: opt.str(),
      attributes: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      state: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      stale: z.union([z.string(), z.number()]).optional(),
      dismissal: z.union([z.string(), z.number()]).optional(),
      relevance: opt.num(),
      alert: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      id: opt.str(),
      title: opt.str(),
      subtitle: opt.str(),
      body: opt.str(),
      image: opt.str(),
      tag: opt.str(),
      data: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      file: opt.str(),
      apns: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      fcm: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      badge: opt.num(),
      sound: opt.str(),
      category: opt.str(),
      threadId: opt.str(),
      collapseId: opt.str(),
      channel: opt.str(),
      silent: opt.bool(),
      priority: z.enum(['high', 'normal']).optional(),
      delay: opt.num(),
      repeat: opt.num(),
      wait: opt.num(),
      grant: opt.bool(),
      token: opt.str(),
      expect: z.enum(['app', 'away', 'any']).optional(),
      app: opt.str(),
      limit: opt.num(),
      device,
    },
    'push',
  );

  // Flows — run in the daemon: one call, one verdict.
  tool(
    'run',
    'Run a flow (file name or inline steps) in the daemon: one verdict; on failure the line, error, a suggested fix, crashes and screen. from: start at that line. matrix: once per config variant.',
    {flow: opt.str(), steps: opt.str(), params, from: opt.num(), matrix: opt.bool(), device},
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
  registerTools(server as unknown as ToolServer, config, async () => (client ??= await connect({config: file})), () => (client = undefined), {
    stopDaemon: async () => {
      const r = await stopProjectDaemon({config: file}, 'stop');
      return r.lines.join('\n');
    },
    daemonStopping: async c => {
      const r = await waitDaemonGone(c as DaemonClient);
      return r.failed ? r.lines.join('\n') : undefined;
    },
  });
  await server.connect(new StdioServerTransport());
};
