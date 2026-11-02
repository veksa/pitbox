// pitbox CLI. Every command is a call to the project's daemon (started on demand), printed in the same compact
// form the MCP server returns.

import {connect, resolveProject, runningDaemon} from './daemon/client.ts';
import {formatResult} from './format.ts';
import {DAEMON_STOP} from './daemon/info.ts';

const HELP = `pitbox — run, drive and debug apps from one tool

stand
  up [service…]                 start the stand (all autostart services, the LLM mock) or the named services
  down [service…]               stop what pitbox started
  restart <service…>
  status                        services, actors, mock, devices, forwarded ports
  logs <service|actor> [-n 40] [--grep re]
  tools                         project tools from the config
  tool <name> [param=value…]    run a project tool
  actors | actor start <type> <name> [--port n] | actor stop <name> | actor call <name> '<json>'

android
  devices                       online devices and idle AVDs
  boot [avd] [--wipe] [--headless]
  shutdown [--device d]
  install <apk> [--replace]     --replace uninstalls an app signed with another key first
  open [package|url] [--relaunch]
  stop-app | clear-app | uninstall [--pkg p]
  apps [filter]
  app-logs [-n 50] [--grep re] [--level E] [--all]
  settings fontScale=1.3 dark=true animations=false size=1080x2400 density=420 locale=fr-FR grant=<perm> revoke=<perm>
  network full|lte|umts|edge|gsm|offline|online
  screenshot [file]
  reverse                       forward every exposed port to every device now
  info

ui (through the on-device runner; every action waits for the UI to settle and prints what changed)
  snapshot [--system]           the screen as short lines with refs (@e12)
  press|longpress|doubletap <@ref | id=… | text=… | label=… | words | x,y>
  fill <selector> <text> · type <text> · key back|home|up|down|left|right|center|enter|…|<keycode> …
  swipe up|down|left|right|x1,y1,x2,y2 [ms] · scroll down until <selector>
  touch down <target> · touch move <target> · touch up   a finger held between calls (inspect mid-drag)
  wait [gone] <selector> [--timeout s] · focus · shot [name] [--scale 0.4]
  media [selector]              is it playing? motion and brightness of a region, compared on the device

flows
  run <flow> [param=value…] | run --steps "press id=a"   run a flow in the daemon, get one verdict
  goto <route> [param=value…] · as <user>
  record start | record stop [name]

devserver
  dev [status|prewarm|reload|restart]   the bundler behind pitbox's proxy: device requests, bytecode, prewarming
  fresh                         does the app run the newest code? (reported from inside the app)
  qr [--lan]                    QR with the link that points the app at this dev server
  app-log [-n 30]               the app's recent network requests and socket events
  net fail|mock|delay|freeze <match> [--kind http|ws] [--status 503] [--body '{…}'] [--ms 3000]
  net offline | net clear | net

support
  doctor [--fix] [--only rule,…]
  docs [name [toc|section|grep|lines] [query] [--context n] [--from a --to b]]
  daemon status|stop|restart
  mcp                           MCP server on stdio

global: --config <file>  --device <serial|avd>  --json`;

type Args = {positional: string[]; flags: Record<string, string | boolean>};

export const parseArgs = (argv: string[]): Args => {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-n') {
      flags.lines = argv[++i] ?? '';
    } else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') && !['wipe', 'headless', 'replace', 'relaunch', 'all', 'fix', 'json', 'lan', 'system', 'bounds'].includes(k)) flags[k] = argv[++i]!;
      else flags[k] = true;
    } else {
      positional.push(a);
    }
  }
  return {positional, flags};
};

const kv = (items: string[]) => Object.fromEntries(items.map(s => {
  const i = s.indexOf('=');
  if (i < 0) throw new Error(`expected key=value, got "${s}"`);
  return [s.slice(0, i), s.slice(i + 1)];
}));

/** Maps a command line to a daemon method and its params. */
export const toCall = ({positional, flags}: Args): {method: string; params: Record<string, unknown>} => {
  const [cmd, ...rest] = positional;
  const device = flags.device as string | undefined;
  const pkg = flags.pkg as string | undefined;
  const common = {device, pkg};
  switch (cmd) {
    case 'up':
    case 'down':
    case 'restart':
      return {method: cmd, params: {services: rest}};
    case 'status':
      return {method: 'status', params: {}};
    case 'logs':
      return {method: 'logs', params: {name: rest[0], lines: flags.lines, grep: flags.grep}};
    case 'tools':
      return {method: 'tools', params: {}};
    case 'tool':
      return {method: 'tool', params: {name: rest[0], params: kv(rest.slice(1))}};
    case 'actors':
      return {method: 'actors', params: {}};
    case 'actor': {
      const [sub, a, b] = rest;
      if (sub === 'start') return {method: 'actorStart', params: {type: a, name: b, port: flags.port}};
      if (sub === 'stop') return {method: 'actorStop', params: {name: a}};
      if (sub === 'call') return {method: 'actorCall', params: {name: a, body: b ? JSON.parse(b) : {}}};
      throw new Error('actor start|stop|call');
    }
    case 'devices':
      return {method: 'devices', params: {}};
    case 'boot':
      return {method: 'boot', params: {avd: rest[0], wipe: flags.wipe, headless: flags.headless}};
    case 'shutdown':
      return {method: 'shutdown', params: common};
    case 'install':
      return {method: 'install', params: {...common, apk: rest[0], replace: flags.replace}};
    case 'open':
      return {method: 'open', params: {...common, target: rest[0], relaunch: flags.relaunch}};
    case 'stop-app':
      return {method: 'stopApp', params: common};
    case 'clear-app':
      return {method: 'clearApp', params: common};
    case 'uninstall':
      return {method: 'uninstall', params: common};
    case 'apps':
      return {method: 'apps', params: {device, filter: rest[0]}};
    case 'app-logs':
      return {method: 'appLogs', params: {...common, lines: flags.lines, grep: flags.grep, level: flags.level, all: flags.all}};
    case 'settings':
      return {method: 'settings', params: {...common, ...kv(rest)}};
    case 'network':
      return {method: 'network', params: {device, profile: rest[0]}};
    case 'screenshot':
      return {method: 'screenshot', params: {device, file: rest[0]}};
    case 'key':
      return {method: 'uiKey', params: {device, keys: rest}};
    case 'snapshot':
      return {method: 'snapshot', params: {device, system: flags.system, bounds: flags.bounds}};
    case 'press':
    case 'longpress':
    case 'doubletap':
      return {method: 'press', params: {device, target: rest.join(' '), kind: cmd === 'press' ? 'tap' : cmd}};
    case 'fill':
      return {method: 'fill', params: {device, target: rest.slice(0, -1).join(' '), text: rest[rest.length - 1]}};
    case 'type':
      return {method: 'type', params: {device, text: rest.join(' ')}};
    case 'touch':
      return {method: 'touch', params: {device, phase: rest[0], target: rest.slice(1).join(' ') || undefined}};
    case 'swipe':
      return {method: 'swipe', params: {device, direction: rest[0], duration: rest[1]}};
    case 'scroll':
      return {method: 'scroll', params: {device, direction: rest[0], until: rest.slice(rest[1] === 'until' ? 2 : 1).join(' ')}};
    case 'wait':
      return {method: 'wait', params: {device, gone: rest[0] === 'gone', target: (rest[0] === 'gone' ? rest.slice(1) : rest).join(' '), timeout: flags.timeout}};
    case 'focus':
      return {method: 'focus', params: {device}};
    case 'media':
      return {method: 'media', params: {device, target: rest.join(' ') || undefined, count: flags.count, interval: flags.interval}};
    case 'shot':
      return {method: 'uiShot', params: {device, name: rest[0], scale: flags.scale}};
    case 'run':
      return {method: 'run', params: {device, flow: rest[0], steps: flags.steps, params: kv(rest.slice(1))}};
    case 'goto':
      return {method: 'goto', params: {device, route: rest[0], params: kv(rest.slice(1))}};
    case 'as':
      return {method: 'as', params: {device, user: rest[0]}};
    case 'record': {
      if (rest[0] === 'start') return {method: 'recordStart', params: {device}};
      if (rest[0] === 'stop') return {method: 'recordStop', params: {device, name: rest[1]}};
      throw new Error('record start | record stop [name]');
    }
    case 'reverse':
      return {method: 'reverse', params: {}};
    case 'info':
      return {method: 'info', params: {device}};
    case 'doctor':
      return {method: 'doctor', params: {fix: flags.fix, only: flags.only}};
    case 'dev': {
      const sub = rest[0] ?? 'status';
      const method = ({status: 'devStatus', prewarm: 'devPrewarm', reload: 'devReload', restart: 'restart'} as Record<string, string>)[sub];
      if (!method) throw new Error('dev status|prewarm|reload|restart');
      return {method, params: method === 'restart' ? {services: ['devserver']} : {}};
    }
    case 'fresh':
      return {method: 'fresh', params: {}};
    case 'qr':
      return {method: 'qr', params: {lan: flags.lan, terminal: true}};
    case 'app-log':
      return {method: 'appLog', params: {limit: flags.lines}};
    case 'net':
      return {method: 'net', params: {action: rest[0] ?? 'list', match: rest[1], kind: flags.kind, status: flags.status, body: flags.body, ms: flags.ms}};
    case 'docs': {
      const [name, op, ...q] = rest;
      return {method: 'docs', params: {name, op, query: q.join(' ') || undefined, context: flags.context, from: flags.from, to: flags.to, depth: flags.depth}};
    }
    default:
      throw new Error(`unknown command: ${cmd}\n\n${HELP}`);
  }
};

export const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, sub] = args.positional;
  const config = args.flags.config as string | undefined;
  if (!cmd || cmd === 'help' || args.flags.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (cmd === 'mcp') {
    const {startMcp} = await import('./mcp/server.ts');
    await startMcp({config});
    return;
  }
  if (cmd === 'daemon') {
    const running = await runningDaemon({config});
    if (sub === 'status' || !sub) {
      process.stdout.write(running ? `running: pid ${running.info.pid}, port ${running.info.port}, ${running.info.config}\n` : `not running (${resolveProject({config}).stateDir})\n`);
      return;
    }
    if (sub === 'stop' || sub === 'restart') {
      if (running) await running.call(DAEMON_STOP).catch(() => undefined);
      if (sub === 'stop') {
        process.stdout.write(running ? 'stopped\n' : 'not running\n');
        return;
      }
      await new Promise(r => setTimeout(r, 300));
      const c = await connect({config});
      process.stdout.write(`running: pid ${c.info.pid}\n`);
      return;
    }
    throw new Error('daemon status|stop|restart');
  }
  const {method, params} = toCall(args);
  const client = await connect({config});
  const result = await client.call(method, params);
  process.stdout.write(`${args.flags.json ? JSON.stringify(result, null, 2) : formatResult(method, result)}\n`);
  if (method === 'up' && (result as {services: {status: string}[]}).services.some(s => s.status === 'failed')) process.exitCode = 1;
};

