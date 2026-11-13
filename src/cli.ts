// pitbox CLI. Every command is a call to the project's daemon (started on demand), printed in the same compact
// form the MCP server returns.

import path from 'node:path';
import {connect, resolveProject, runningDaemon} from './daemon/client.ts';
import {formatResult} from './format.ts';
import {DAEMON_STOP} from './daemon/info.ts';

const HELP = `pitbox — run, drive and debug apps from one tool

setup
  init [--dry-run] [--force]    a first pitbox.config.ts from the project's files; lets Android debug builds use plain HTTP
  serve-devices [--listen host:port]  serve this Mac's simulators to a pitbox on another machine (apple.remote there)

stand
  up [service…]                 start the stand (all autostart services, the LLM mock) or the named services
  down [service…]               stop what pitbox started
  restart <service…>            stop and start again, with the running services that depend on them
  status                        services, actors, mock, devices, forwarded ports
  logs <service|actor> [-n 40] [--grep re]
  llm [log [-n 10]] | llm reply <text> [--match re] [--once] | llm fail [status] | llm delay <ms> | llm clear | llm reload   the LLM mock
  trace [id] [-n 20]            what the services and actors logged for an action (its trace id; the last action by default)
  tools                         project tools from the config
  tool <name> [param=value…]    run a project tool
  actors | actor start <type> <name> [--port n] | actor stop <name> | actor call <name> '<json>'

android
  devices [clean]               online devices with who holds each, idle AVDs and simulators · clean deletes the shut-down simulators and AVDs pitbox created for sessions
  boot [avd|simulator] [--wipe] [--headless]   leased to this session; a device another session holds is not touched: a free one of the same model, or a new instance, is booted instead
  shutdown [--device d] [--force]   only a device this session holds; --force shuts down another's and names its holder
  device lease [--device d] [--purpose text] · device release [--device d] [--keep]   hold a device for this session · give it back (one pitbox booted shuts down unless --keep)
  install <apk|app> [--replace] --replace uninstalls an app signed with another key first
  open [package|url] [--relaunch] [--fresh]   web: --relaunch keeps cookies and storage, --fresh starts from a clean profile
  stop-app | clear-app | uninstall [--pkg p]
  apps [filter]
  app-logs [-n 50] [--grep re] [--level E] [--all]
  settings fontScale=1.3 dark=true animations=false size=1080x2400 density=420 locale=fr-FR grant=<perm> revoke=<perm>
  settings emulate="iPhone 15"|reset size=390x844 density=3 touch=true mobile=true userAgent=… dark=true locale=fr-FR   a web app (login kept)
  downloads [name-regex] [-n 10] [--wait s]   a web app's downloaded files; --wait waits for a new one
  network full|lte|umts|edge|gsm|offline|online
  screenshot [file]
  reverse                       forward every exposed port to every device now
  pair [wait | <ip:port> <code>]   a phone on Wi-Fi: a QR for Wireless debugging (then pair wait), or its pairing code
  info
  perf [reset [trace]]          since reset: frames, memory, the JS thread, React commits, the JS heap; trace adds the platform's trace (Android)

ui (through the on-device runner; every action waits for the UI to settle and prints what changed)
  snapshot [--system]           the screen as short lines with refs (@e12)
  press|longpress|doubletap <@ref | id=… | text=… | label=… | words | x,y>
  fill <selector> <text> · type <text> · key back|home|up|down|left|right|center|enter|…|<keycode> …
  swipe up|down|left|right|x1,y1,x2,y2 [ms] · scroll down until <selector>
  mouse right|hover <selector> · mouse wheel up|down [steps] [selector]    tablets, desktops, headsets
  rotary up|down [steps]        a watch crown or bezel
  touchpad forward|back|up|down|tap    the temple touchpad of AI glasses (moves focus)
  posture closed|half|open|rear|reset    fold a foldable · rotate 0|90|180|270|auto
  window freeform [x,y,w,h] | fullscreen | resize x,y,w,h    the app as a desktop-style window (relaunches it)
  wear tile add|show|remove <component> | face <package|component> | ambient on|off | home    watches
  widget add <name> [--app <label>] [--size 4x2|small|medium|large|extra large] | widget remove <name> | widget list [app]    home-screen widgets (Android 10+: Launcher3 / Pixel Launcher; iOS simulators: SpringBoard)
  car day|night|auto | drive [m/s] | park | rotary cw|ccw [n]    cars (driving blocks apps not made for it)
  xr look yaw[,pitch[,roll]] | move dx,dy,dz | spin yaw,pitch,roll[,ms] | drift dx,dy,dz[,ms] | recenter | env day|night | passthrough 0…1 | options | panel minimize|close|menu|info|spatial-audio|tidy|close-app    XR headsets
  touch down <target> · touch move <target> · touch up   a finger held between calls (inspect mid-drag)
  wait [gone] <selector> [--timeout s] · focus · shot [name] [--scale 0.4]
  focusmap [--max 150]           walk the screen with the D-pad: unreachable nodes, focus traps, moves that do not reverse
  visual <name> [--update] [--mask <selector>]   compare the screen with a baseline (stored on first use)
  media [selector]              is it playing? motion and brightness of a region, compared on the device

push (no credentials: simctl push on simulators, the app's own FCM service on Android through the connect library)
  push title=… body=… [data='{"k":"v"}'] [badge= sound= category= threadId= collapseId= channel= image= tag= priority=high|normal silent=true]
  push file=payload.json | push apns='{"aps":{…}}' | push fcm='{"notification":{…},"data":{…}}'   raw payloads, converted for the other platform
       [delay=s] [repeat=n] [grant=true] [--app <package|bundle id>]   one-line verdict: posted / banner shown / handled in front
  push tap [title] [--expect app|away|any] · push clear · push grant · push status · push log [-n 10] · push bind <token>

flows
  run <flow> [param=value…] [--from line] | run --steps "press id=a"   run a flow in the daemon, get one verdict
  matrix <flow> [param=value…]  run a flow over the config's variants (devices, font scale, dark, locale)
  goto <route> [param=value…] · as <user>
  record start | record stop [name]
  state save|restore|rm <name> · state list   device snapshot + backend dump, back in seconds

devserver
  dev [status|prewarm|reload|restart|embed]   the bundler behind pitbox's proxy; embed writes the bundle into the app and builds it
  fresh                         does the app run the newest code? (reported from inside the app)
  qr [--lan]                    QR with the link that points the app at this dev server
  app-tree                      the React tree from inside the app (testIDs, labels, text): reaches what accessibility does not
  app-log [-n 30]               the app's recent network requests and socket events
  app-errors [-n 5]             the app's recent JS errors, stacks mapped to source files
  app-console [-n 30] [--level warn|error] [--grep re]   the app's console, warnings with their source line
  js eval <expr…>               evaluate in the app's JS runtime (statements and promises fine)
  js log <file:line> [expr…]    a logpoint: the values each time the line runs, without stopping the app
  js hits [id] [-n 20] · js clear [id]
  net fail|mock|delay|freeze <match> [--kind http|ws] [--status 503] [--body '{…}'] [--ms 3000]
  net offline | net clear | net

support
  doctor [--fix] [--only rule,…]
  docs [name [toc|section|grep|lines] [query] [--context n] [--from a --to b]]
  daemon status|stop|restart
  mcp                           MCP server on stdio

leases (no daemon: for scripts and skills that drive a device with simctl or adb)
  lease acquire <device> --as "<label>" [--ttl 30m] [--purpose text] [--pid n] [--wait 5m]   take a device or renew; exits 1 naming the holder when someone else has it
  lease release <device> --as "<label>" [--force] · lease list

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
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') && !['wipe', 'headless', 'replace', 'relaunch', 'fresh', 'all', 'fix', 'json', 'lan', 'system', 'bounds', 'update', 'force', 'dry-run', 'keep'].includes(k)) flags[k] = argv[++i]!;
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
      return {method: rest[0] === 'clean' ? 'cleanDevices' : 'devices', params: {}};
    case 'boot':
      return {method: 'boot', params: {avd: rest[0], wipe: flags.wipe, headless: flags.headless}};
    case 'shutdown':
      return {method: 'shutdown', params: {...common, force: flags.force}};
    case 'device': {
      if (rest[0] === 'lease') return {method: 'lease', params: {device: device ?? rest[1], purpose: flags.purpose}};
      if (rest[0] === 'release') return {method: 'release', params: {device: device ?? rest[1], keep: flags.keep, force: flags.force}};
      throw new Error('device lease [--device d] [--purpose text] | device release [--device d] [--keep]');
    }
    case 'install':
      return {method: 'install', params: {...common, apk: rest[0], replace: flags.replace}};
    case 'open':
      return {method: 'open', params: {...common, target: rest[0], relaunch: flags.relaunch, fresh: flags.fresh}};
    case 'downloads':
      return {method: 'downloads', params: {device, grep: rest[0], lines: flags.lines, timeout: flags.wait === true ? 10 : flags.wait}};
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
    case 'mouse': {
      // mouse right|hover <target> · mouse wheel up|down [steps] [target]
      if (rest[0] === 'wheel') {
        const steps = /^\d+$/.test(rest[2] ?? '') ? Number(rest[2]) : undefined;
        return {method: 'mouse', params: {device, action: 'wheel', direction: rest[1], steps, target: rest.slice(steps === undefined ? 2 : 3).join(' ') || undefined}};
      }
      return {method: 'mouse', params: {device, action: rest[0], target: rest.slice(1).join(' ')}};
    }
    case 'touchpad':
      return {method: 'touchpad', params: {device, gesture: rest[0]}};
    case 'rotary':
      return {method: 'rotary', params: {device, direction: rest[0], steps: rest[1] ? Number(rest[1]) : undefined}};
    case 'posture':
    case 'rotate':
      return {method: cmd, params: {device, value: rest[0]}};
    case 'window':
      return {method: 'window', params: {...common, value: rest.join(' ')}};
    case 'wear':
    case 'xr':
    case 'car':
      return {method: cmd, params: {device, value: rest.join(' ')}};
    case 'widget':
      // Each word the shell kept together stays one token: `widget add "World clock"`.
      return {method: 'widget', params: {device, value: rest.map(r => (/\s/.test(r) ? JSON.stringify(r) : r)).join(' '), app: flags.app, size: flags.size}};
    case 'scroll':
      return {method: 'scroll', params: {device, direction: rest[0], until: rest.slice(rest[1] === 'until' ? 2 : 1).join(' ')}};
    case 'wait': {
      // `wait id=x 30` as in a flow: a trailing number is the timeout, not part of the selector.
      const words = rest[0] === 'gone' ? rest.slice(1) : rest;
      const last = words[words.length - 1];
      const trailing = words.length > 1 && /^\d+(\.\d+)?$/.test(last ?? '') ? last : undefined;
      return {method: 'wait', params: {device, gone: rest[0] === 'gone', target: (trailing ? words.slice(0, -1) : words).join(' '), timeout: flags.timeout ?? trailing}};
    }
    case 'focus':
      return {method: 'focus', params: {device}};
    case 'focusmap':
      return {method: 'focusMap', params: {device, max: flags.max}};
    case 'visual':
      return {method: 'visual', params: {device, name: rest[0], update: flags.update, masks: flags.mask}};
    case 'media':
      return {method: 'media', params: {device, target: rest.join(' ') || undefined, count: flags.count, interval: flags.interval}};
    case 'shot':
      return {method: 'uiShot', params: {device, name: rest[0], scale: flags.scale}};
    case 'run':
      return {method: 'run', params: {device, flow: rest[0], steps: flags.steps, from: flags.from, params: kv(rest.slice(1))}};
    case 'matrix':
      return {method: 'matrix', params: {device, flow: rest[0], steps: flags.steps, params: kv(rest.slice(1))}};
    case 'goto':
      return {method: 'goto', params: {device, route: rest[0], params: kv(rest.slice(1))}};
    case 'as':
      return {method: 'as', params: {device, user: rest[0]}};
    case 'state': {
      const [sub, name] = rest;
      const method = ({save: 'stateSave', restore: 'stateRestore', list: 'stateList', rm: 'stateDelete'} as Record<string, string>)[sub ?? 'list'];
      if (!method) throw new Error('state save|restore|rm <name> | state list');
      return {method, params: {device, name}};
    }
    case 'record': {
      if (rest[0] === 'start') return {method: 'recordStart', params: {device}};
      if (rest[0] === 'stop') return {method: 'recordStop', params: {device, name: rest[1]}};
      throw new Error('record start | record stop [name]');
    }
    case 'reverse':
      return {method: 'reverse', params: {}};
    case 'perf':
      return {method: 'perf', params: {...common, reset: rest[0] === 'reset', trace: rest.includes('trace') || flags.trace}};
    case 'info':
      return {method: 'info', params: {device}};
    case 'doctor':
      return {method: 'doctor', params: {fix: flags.fix, only: flags.only}};
    case 'dev': {
      const sub = rest[0] ?? 'status';
      const method = ({status: 'devStatus', prewarm: 'devPrewarm', reload: 'devReload', restart: 'restart', embed: 'devEmbed'} as Record<string, string>)[sub];
      if (!method) throw new Error('dev status|prewarm|reload|restart|embed');
      return {method, params: method === 'restart' ? {services: ['devserver']} : {}};
    }
    case 'fresh':
      return {method: 'fresh', params: {}};
    case 'qr':
      return {method: 'qr', params: {lan: flags.lan, terminal: true}};
    case 'app-tree':
      return {method: 'appTree', params: {limit: flags.lines}};
    case 'app-errors':
      return {method: 'appErrors', params: {limit: flags.lines}};
    case 'llm': {
      const [action = 'log', arg] = rest;
      const common = {action, match: flags.match, once: flags.once, limit: flags.lines};
      if (action === 'reply') return {method: 'llm', params: {...common, text: rest.slice(1).join(' ')}};
      if (action === 'fail') return {method: 'llm', params: {...common, status: arg ? Number(arg) : undefined, text: flags.text}};
      if (action === 'delay') return {method: 'llm', params: {...common, ms: arg ? Number(arg) : undefined}};
      return {method: 'llm', params: common};
    }
    case 'pair':
      return {method: 'pair', params: {value: rest.join(' ') || undefined, terminal: true, timeout: flags.timeout}};
    case 'trace':
      return {method: 'trace', params: {id: rest[0], lines: flags.lines}};
    case 'app-console':
      return {method: 'appConsole', params: {limit: flags.lines, level: flags.level, grep: flags.grep}};
    case 'app-log':
      return {method: 'appLog', params: {limit: flags.lines}};
    case 'js': {
      const [sub, ...args] = rest;
      if (sub === 'eval') return {method: 'jsEval', params: {expr: args.join(' '), timeout: flags.timeout, device}};
      if (sub === 'log') return {method: 'jsLog', params: {at: args[0], exprs: args.slice(1), device}};
      if (sub === 'hits' || sub === undefined) return {method: 'jsHits', params: {id: args[0], limit: flags.lines}};
      if (sub === 'clear') return {method: 'jsClear', params: {id: args[0]}};
      throw new Error('js eval <expr> | js log <file:line> [expr…] | js hits [id] | js clear [id]');
    }
    case 'net':
      return {method: 'net', params: {action: rest[0] ?? 'list', match: rest[1], kind: flags.kind, status: flags.status, body: flags.body, ms: flags.ms}};
    case 'push': {
      const sub = ['tap', 'clear', 'grant', 'status', 'log', 'bind', 'send'].includes(rest[0] ?? '') ? rest[0]! : 'send';
      const args = sub === 'send' && rest[0] !== 'send' ? rest : rest.slice(1);
      const app = flags.app ?? flags.pkg;
      if (sub === 'tap') return {method: 'push', params: {action: sub, device, app, title: args.join(' ') || undefined, ...(typeof flags.expect === 'string' && {expect: flags.expect})}};
      if (sub === 'bind') return {method: 'push', params: {action: sub, device, token: args[0]}};
      if (sub === 'log') return {method: 'push', params: {action: sub, limit: flags.lines}};
      if (sub !== 'send') return {method: 'push', params: {action: sub, device, app}};
      const fields = kv(args);
      // A payload file is read by the daemon, which runs in the project's root: make the path absolute here.
      if (fields.file) fields.file = path.resolve(fields.file);
      return {method: 'push', params: {action: 'send', device, app, ...fields}};
    }
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
  if (cmd === 'init') {
    const {init} = await import('./init/init.ts');
    const r = init({cwd: process.cwd(), force: !!args.flags.force, dryRun: !!args.flags['dry-run']});
    process.stdout.write(`${r.lines.join('\n')}\n`);
    return;
  }
  if (cmd === 'serve-devices') {
    const {serveDevices} = await import('./remote/deviceHost.ts');
    await serveDevices(String(args.flags.listen ?? sub ?? '127.0.0.1:7700'));
    await new Promise(() => undefined);
    return;
  }
  if (cmd === 'mcp') {
    const {startMcp} = await import('./mcp/server.ts');
    await startMcp({config});
    return;
  }
  if (cmd === 'lease') {
    const {leaseCommand} = await import('./lease/cli.ts');
    const r = await leaseCommand(args.positional.slice(1), args.flags);
    process.stdout.write(`${r.text}\n`);
    if (r.failed) process.exitCode = 1;
    return;
  }
  if (cmd === 'daemon') {
    const running = await runningDaemon({config});
    // Every daemon process of the config, not only the one the daemon file names: one whose file another overwrote
    // runs on unreachable (daemon/siblings.ts).
    const {daemonsOf, stopDaemons} = await import('./daemon/siblings.ts');
    const strays = daemonsOf(resolveProject({config}).file).filter(pid => pid !== running?.info.pid);
    if (sub === 'status' || !sub) {
      process.stdout.write(running ? `running: pid ${running.info.pid}, port ${running.info.port}, ${running.info.config}\n` : `not running (${resolveProject({config}).stateDir})\n`);
      if (strays.length) {
        process.stdout.write(`also running for this config, unreachable (not in its daemon file): pid ${strays.join(', ')}\nhint: \`pitbox daemon restart\` (or stop) ends them too\n`);
        process.exitCode = 1;
      }
      return;
    }
    if (sub === 'stop' || sub === 'restart') {
      // Unreachable daemons first, by SIGTERM (their leases stay with the project), so the stop below gives their
      // devices back with its own.
      const left = strays.length ? await stopDaemons(strays) : [];
      const stray = strays.length ? `; ${strays.length - left.length} unreachable daemon${strays.length > 1 ? 's' : ''} of this config stopped too (pid ${strays.join(', ')})` : '';
      if (left.length) {
        process.stdout.write(`pid ${left.join(', ')} (a daemon of this config) did not stop on SIGTERM\n`);
        process.exitCode = 1;
      }
      // A restart keeps the devices this project holds; a stop gives them back (and shuts down those it booted).
      // `keepLeases` is what a daemon from before `release` reads; `by` says a person asked, so it stops even in use.
      if (running) await running.call(DAEMON_STOP, sub === 'stop' ? {release: true, by: 'user'} : {keepLeases: true, by: 'user'}).catch(() => undefined);
      // Stopped means gone: devices it booted shut down first, and a script that boots next must not race that.
      const {isAlive} = await import('./util/proc.ts');
      const end = Date.now() + 120_000;
      while (running && isAlive(running.info.pid) && Date.now() < end) await new Promise(r => setTimeout(r, 200));
      if (running && isAlive(running.info.pid)) {
        process.stdout.write(`still stopping: pid ${running.info.pid} is giving its devices back (a device that will not shut down holds it up)\n`);
        process.exitCode = 1;
        return;
      }
      if (sub === 'stop') {
        process.stdout.write(running ? `stopped${stray}\n` : strays.length ? `stopped${stray.replace(/^; /, ': ')}\n` : 'not running\n');
        return;
      }
      const c = await connect({config});
      process.stdout.write(`running: pid ${c.info.pid}${stray}\n`);
      return;
    }
    throw new Error('daemon status|stop|restart');
  }
  const {method, params} = toCall(args);
  const client = await connect({config});
  const result = await client.call(method, params);
  process.stdout.write(`${args.flags.json ? JSON.stringify(result, null, 2) : formatResult(method, result)}\n`);
  if (failed(method, result)) process.exitCode = 1;
};

/** A verdict that failed exits non-zero, so a script or a shell `&&` sees it. */
export const failed = (method: string, result: unknown): boolean => {
  const r = result as {ok?: boolean; services?: {status: string}[]; results?: {ok: boolean}[]};
  if (method === 'up') return !!r.services?.some(s => s.status === 'failed');
  if (method === 'run' || method === 'as' || method === 'push') return r.ok === false;
  if (method === 'matrix') return !!r.results?.some(v => !v.ok);
  return false;
};

