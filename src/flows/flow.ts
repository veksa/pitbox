// Flows: a line-per-step script the daemon executes on its own, so an agent spends one call — and one verdict —
// instead of a turn per tap.
//
//   # comment
//   open                         launch the app (open! relaunches); `open <url|package>`
//   goto item id=42           a route from the config (deep link template)
//   as viewer                    the config's sign-in flow with {user}
//   press id=start | longpress … | doubletap …
//   fill id=email "a@example.test"
//   type " more text"
//   key back | key down down center
//   swipe up [ms] | swipe 540,1800,540,600 [ms]
//   touch down id=seek | touch move 900,1500 | touch up    (a finger held across steps)
//   scroll down until text="Popular items"
//   wait text="Home" [seconds] | wait gone id=spinner [seconds]
//   expect text="Welcome" | expect gone id=error | expect focus id=play
//   expect playing id=player | expect paused id=player   (frames compared on the device; black is not playing)
//   tool sql query="select 1" contains "1"
//   state signed-in              restore a named stand state (device snapshot + backend)
//   device Pixel_8               the following steps run on another device (several devices in one flow)
//   visual home mask id=player   compare with a stored baseline (stored on the first run)
//   sleep 500
//   screenshot [name] [full]     JPEG for a look, or full-resolution PNG (store screenshots)
//   run sign-in user=viewer      another flow file
//
// `${name}` in any step is replaced by a run parameter.

export type Step = {line: number; cmd: string; args: string[]; text: string};

/** Splits a step into tokens; quotes keep spaces together and stay on the token (`text="A b"`). */
export const tokenize = (s: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < s.length) {
        cur += s[++i];
      } else if (ch === quote) {
        quote = undefined;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new Error(`unclosed ${quote} in: ${s}`);
  if (has || cur) out.push(cur);
  return out;
};

export const unquote = (s: string): string => {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return JSON.parse(s) as string;
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
};

/** `k=v` tokens into params, the value unquoted. */
export const kvArgs = (tokens: string[]): Record<string, string> =>
  Object.fromEntries(
    tokens.map(t => {
      const i = t.indexOf('=');
      if (i <= 0) throw new Error(`expected key=value, got ${t}`);
      return [t.slice(0, i), unquote(t.slice(i + 1))];
    }),
  );

export const substitute = (s: string, params: Record<string, string>): string =>
  s.replace(/\$\{(\w+)\}/g, (_, k: string) => {
    if (params[k] === undefined) throw new Error(`missing flow parameter \${${k}}`);
    return params[k]!;
  });

/** A route's deep link with its `{param}`s filled in (URL-encoded); a missing parameter is an error. */
export const fillRoute = (route: string, template: string, params: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => {
    if (params[k] === undefined) throw new Error(`route ${route} needs ${k}`);
    return encodeURIComponent(params[k]!);
  });

export const parseFlow =(source: string, params: Record<string, string> = {}): Step[] =>
  source
    .split(/\r?\n/)
    .map((raw, i) => ({raw: raw.trim(), line: i + 1}))
    .filter(({raw}) => raw && !raw.startsWith('#'))
    .map(({raw, line}) => {
      try {
        const [cmd = '', ...args] = tokenize(substitute(raw, params));
        return {line, cmd, args, text: raw};
      } catch (e) {
        throw new Error(`line ${line}: ${(e as Error).message}`);
      }
    });

export const STEP_COMMANDS = ['open', 'open!', 'goto', 'as', 'press', 'longpress', 'doubletap', 'fill', 'type', 'key', 'touch', 'swipe', 'scroll', 'mouse', 'rotary', 'posture', 'rotate', 'window', 'wait', 'expect', 'tool', 'state', 'device', 'visual', 'sleep', 'screenshot', 'run'];

/** Static check before running: unknown commands and missing arguments fail with the line, not mid-run. */
export const validateFlow = (steps: Step[]): string[] => {
  const errors: string[] = [];
  for (const s of steps) {
    const need = (n: number) => s.args.length < n && errors.push(`line ${s.line}: ${s.cmd} needs ${n} argument${n > 1 ? 's' : ''}`);
    switch (s.cmd) {
      case 'open':
      case 'open!':
      case 'screenshot':
        break;
      case 'goto':
      case 'as':
      case 'press':
      case 'longpress':
      case 'doubletap':
      case 'type':
      case 'key':
      case 'swipe':
      case 'touch':
      case 'state':
      case 'device':
      case 'visual':
      case 'sleep':
      case 'run':
      case 'tool':
      case 'rotary':
      case 'posture':
      case 'rotate':
      case 'window':
        need(1);
        break;
      case 'mouse':
        if (!['right', 'hover', 'wheel'].includes(s.args[0] ?? '') || (s.args[0] !== 'wheel' && s.args.length < 2)) errors.push(`line ${s.line}: mouse right|hover <selector> or mouse wheel up|down [steps] [selector]`);
        break;
      case 'fill':
        need(2);
        break;
      case 'scroll':
        if (s.args.length < 3 || s.args[1] !== 'until') errors.push(`line ${s.line}: scroll <direction> until <selector>`);
        break;
      case 'wait':
      case 'expect':
        need(1);
        break;
      default:
        errors.push(`line ${s.line}: unknown step "${s.cmd}" (${STEP_COMMANDS.join(', ')})`);
    }
  }
  return errors;
};
