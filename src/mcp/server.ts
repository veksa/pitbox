// MCP server on stdio. A thin client of the project's daemon: every tool is one daemon call, answered in the
// same compact text the CLI prints. Project tools from the config become MCP tools of their own.

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {loadConfig} from '../config/load.ts';
import {connect, resolveProject, type DaemonClient} from '../daemon/client.ts';
import {VERSION} from '../daemon/server.ts';
import {formatResult} from '../format.ts';

type Shape = Record<string, z.ZodType>;

const device = z.string().optional().describe('serial, AVD name or model; omit when one device is online');
const pkg = z.string().optional().describe('package; defaults to app.android from the config');

export const startMcp = async (opts: {config?: string} = {}) => {
  const {file} = resolveProject(opts);
  const {config} = await loadConfig({file});
  const server = new McpServer({name: 'pitbox', version: VERSION});
  let client: DaemonClient | undefined;
  const daemon = async () => (client ??= await connect({config: file}));

  const tool = (name: string, description: string, shape: Shape, method: string, map: (a: Record<string, unknown>) => Record<string, unknown> = a => a) => {
    server.registerTool(name, {description, inputSchema: shape}, async (args: Record<string, unknown>) => {
      try {
        const c = await daemon();
        const result = await c.call(method, map(args));
        return {content: [{type: 'text' as const, text: formatResult(method, result)}]};
      } catch (e) {
        client = undefined;
        return {content: [{type: 'text' as const, text: (e as Error).message}], isError: true};
      }
    });
  };

  // Stand
  tool('status', 'Stand at a glance: services, actors, LLM mock, Android devices, forwarded ports.', {}, 'status');
  tool('up', 'Start the stand: every autostart service in dependency order (services already answering are adopted, not restarted), the LLM mock, port forwards. Or only the named services.', {services: z.array(z.string()).optional()}, 'up');
  tool('down', 'Stop what pitbox started (all, or the named services). Processes it did not start are left alone.', {services: z.array(z.string()).optional()}, 'down');
  tool('restart', 'Restart named services.', {services: z.array(z.string())}, 'restart');
  tool('logs', 'Tail of a service or actor log.', {name: z.string(), lines: z.number().int().optional(), grep: z.string().optional().describe('regex, case-insensitive')}, 'logs');
  tool('actor_start', 'Start an actor (an extra user of the app) of a configured type on a free port.', {type: z.string(), name: z.string(), port: z.number().int().optional()}, 'actorStart');
  tool('actor_stop', 'Stop an actor.', {name: z.string()}, 'actorStop');
  tool('actor_call', "Send a JSON body to an actor's HTTP endpoint and return its answer.", {name: z.string(), body: z.record(z.string(), z.unknown()).optional()}, 'actorCall');

  for (const [name, t] of Object.entries(config.tools ?? {})) {
    const shape: Shape = Object.fromEntries(Object.entries(t.params ?? {}).map(([k, d]) => [k, z.string().describe(d)]));
    tool(`tool_${name}`, `${t.description ?? t.run} (project tool)`, shape, 'tool', a => ({name, params: a}));
  }

  // Dev server
  if (config.devserver) {
    tool('dev_status', 'Dev server: proxy, bytecode cache, prewarm results, the last bundle requests from devices with their timing.', {}, 'devStatus');
    tool('dev_prewarm', 'Build the main bundle (and its bytecode) now so the next app start is served from cache.', {}, 'devPrewarm');
    tool('dev_reload', 'Ask every connected app to reload its JS.', {}, 'devReload');
    tool('qr', 'The link that points the app at this dev server, as a QR image file (for a phone camera) and as text (for adb or a simulator). lan=true for phones on Wi-Fi.', {lan: z.boolean().optional()}, 'qr');
    tool('fresh', 'Does the running app execute the newest code? Reported from inside the app; answers stale with the reason (old bundle, rebuild pending) before you debug a fix that never arrived.', {}, 'fresh');
    tool('app_network', "The app's recent network requests (method, URL, status, time) and socket events, from inside the app.", {limit: z.number().int().optional()}, 'appLog');
    tool(
      'net',
      'Network rules applied inside the app: fail (connection error), mock (status/body), delay (ms), freeze (a WebSocket stays open but silent), offline (all of it), clear, list. match is a URL substring or *.',
      {action: z.enum(['fail', 'mock', 'delay', 'freeze', 'offline', 'clear', 'list']), match: z.string().optional(), kind: z.enum(['http', 'ws']).optional(), status: z.number().int().optional(), body: z.unknown().optional(), ms: z.number().int().optional()},
      'net',
    );
  }

  // Android
  tool('devices', 'Online Android devices (with AVD name and kind: phone, foldable, tv, xr) and idle AVDs.', {}, 'devices');
  tool('boot', 'Boot an emulator and wait until it is ready; forwards exposed ports.', {avd: z.string().optional(), wipe: z.boolean().optional(), headless: z.boolean().optional()}, 'boot');
  tool('shutdown', 'Shut an emulator down.', {device}, 'shutdown');
  tool('install', 'Install an APK. replace=true uninstalls an app signed with another key first (its data is lost).', {apk: z.string(), replace: z.boolean().optional(), device}, 'install');
  tool('open', 'Launch the app or open a deep link URL; relaunch=true force-stops it first.', {target: z.string().optional().describe('package or URL; defaults to the app'), relaunch: z.boolean().optional(), device, pkg}, 'open');
  tool('stop_app', 'Force-stop the app.', {device, pkg}, 'stopApp');
  tool('clear_app', "Clear the app's data.", {device, pkg}, 'clearApp');
  tool('uninstall', 'Uninstall the app.', {device, pkg}, 'uninstall');
  tool('apps', 'Third-party packages on the device.', {filter: z.string().optional(), device}, 'apps');
  tool('app_logs', "Recent log lines of the app's process (all=true for the whole device).", {lines: z.number().int().optional(), grep: z.string().optional(), level: z.enum(['V', 'D', 'I', 'W', 'E']).optional(), all: z.boolean().optional(), device, pkg}, 'appLogs');
  tool(
    'settings',
    'Device settings: font scale, dark mode, animations, display size/density (or "reset"), per-app locale, permissions.',
    {fontScale: z.number().optional(), dark: z.boolean().optional(), animations: z.boolean().optional(), size: z.string().optional(), density: z.string().optional(), locale: z.string().optional(), grant: z.string().optional(), revoke: z.string().optional(), device, pkg},
    'settings',
  );
  tool('network', 'Network conditions: speed profile (emulator) or offline/online (airplane mode).', {profile: z.enum(['full', 'lte', 'umts', 'edge', 'gsm', 'offline', 'online']), device}, 'network');
  tool('screenshot', 'Save a screenshot to a file and return its path (the image is not sent; read the file only if you need to look).', {file: z.string().optional(), device}, 'screenshot');
  tool('reverse', 'Forward every exposed stand port to every online device now (pitbox also does this on its own every few seconds).', {}, 'reverse');
  tool('info', 'Device facts: model, Android version, SDK, ABI, display, free space.', {device}, 'info');

  // UI — through the on-device runner. Every action waits for the UI to settle and answers with what changed.
  const target = z.string().describe('@ref from the last snapshot, id=…, text=… (text~= contains), label=…, plain words, or x,y');
  tool('snapshot', 'The screen as short lines with refs (@e12): role, text, (label), #id, [state]. Take one before acting on a new screen; after an action you get the diff instead.', {system: z.boolean().optional(), device}, 'snapshot');
  tool('press', 'Tap a target (kind: longpress, doubletap). Waits for the UI to settle; answers with the screen diff.', {target, kind: z.enum(['tap', 'longpress', 'doubletap']).optional(), device}, 'press');
  tool('fill', 'Replace the text of a field.', {target, text: z.string(), device}, 'fill');
  tool('type', 'Append text to the focused field.', {text: z.string(), device}, 'type');
  tool('key', 'Press keys: back, home, up, down, left, right, center, enter, menu, … or keycodes (TV remote included).', {keys: z.array(z.string()), device}, 'uiKey');
  tool('swipe', 'Swipe up/down/left/right or "x1,y1,x2,y2"; duration in ms sets the velocity.', {direction: z.string(), duration: z.number().int().optional(), device}, 'swipe');
  tool('scroll', 'Scroll in a direction until a target is on screen.', {direction: z.enum(['down', 'up', 'left', 'right']).optional(), until: target, device}, 'scroll');
  tool('wait', 'Wait until a target appears (gone=true: disappears).', {target, gone: z.boolean().optional(), timeout: z.number().optional().describe('seconds, default 10'), device}, 'wait');
  tool('media', 'Is a video (or any region) playing? Compares frames on the device: motion between frames and brightness; black is not playing. No image is sent.', {target: z.string().optional(), count: z.number().int().optional(), interval: z.number().int().optional(), device}, 'media');
  tool('focus', 'Which node has input focus (what a D-pad or keyboard acts on) and accessibility focus.', {device}, 'focus');
  tool('ui_screenshot', 'Downscaled JPEG of the screen saved to a file; returns the path. Read the file only when text and snapshot are not enough.', {name: z.string().optional(), scale: z.number().optional(), device}, 'uiShot');

  // Flows — run in the daemon: one call, one verdict.
  tool('run', 'Run a flow file (or inline steps, one per line) in the daemon and get one verdict; on failure, the failing line, the error and the screen. Steps: open, goto, as, press, fill, type, key, swipe, scroll … until, wait, expect [gone|focus], tool … contains, sleep, screenshot, run.', {flow: z.string().optional(), steps: z.string().optional(), params: z.record(z.string(), z.string()).optional(), device}, 'run');
  tool('goto', 'Open a screen by a route from the config (deep link template).', {route: z.string(), params: z.record(z.string(), z.string()).optional(), device}, 'goto');
  tool('as', 'Sign in as a user with the signIn flow from the config.', {user: z.string(), device}, 'as');
  tool('record_start', 'Start recording UI actions as flow steps (semantic selectors, not coordinates).', {device}, 'recordStart');
  tool('record_stop', 'Stop recording; with a name, save it as a flow file.', {name: z.string().optional(), device}, 'recordStop');

  // Support
  tool('doctor', 'Check the stand and devices for known problems; fix=true applies the remedies that have one.', {fix: z.boolean().optional(), only: z.array(z.string()).optional()}, 'doctor');
  tool(
    'docs',
    'Read project documents cheaply: toc, a section by heading, grep with line numbers, or a line range. No name lists the documents.',
    {name: z.string().optional(), op: z.enum(['toc', 'section', 'grep', 'lines']).optional(), query: z.string().optional(), context: z.number().int().optional(), from: z.number().int().optional(), to: z.number().int().optional()},
    'docs',
  );

  await server.connect(new StdioServerTransport());
};
