#!/usr/bin/env node
// pitbox against another device tool on the same app, device and backend: the calls an agent makes in a
// pass — a cold start to a usable home screen, a sign-in step by step, a snapshot, a deep link to a screen
// with a player — each timed from the shell (spawn to exit), with the size of what it printed in characters
// and tokens, which is what the agent reads. The other tool is agent-device (its CLI), on the app as it was
// built for it: an Expo dev client on plain Metro. The steps are the same selectors for both.
//
//   node bench/agents.mjs scenario.json [--runs 5] [--only pitbox|agent-device] [--tokenizer <dir>]
//
// --tokenizer   a directory with @anthropic-ai/tokenizer installed (`npm i @anthropic-ai/tokenizer`); tokens are
//               counted with it. Without it, tokens are estimated as characters / 3.5 and marked ≈.
//
// scenario.json (paths absolute; nothing about the app lives in this script):
//   {
//     "app": "com.example.app",
//     "home": "id=home",                         // the screen that says the app is usable
//     "player": "id=player",                     // what the deep link opens
//     "link": "myapp://item/1",
//     "signIn": [["press", "id=profile"], ["fill", "id=email", "user@example.test"], …, ["wait", "id=avatar"]],
//     "pitbox": {"cwd": "/…/app", "bin": "/…/pitbox/dist/bin.js", "config": "/…/pitbox.config.ts",
//                "signInFlow": "sign-in", "user": "user@example.test", "reset": "<shell: signed out, not timed>"},
//     "agentDevice": {"cwd": "/…/other-app", "bin": "/…/agent-device.mjs", "open": ["com.example.app", "<dev client link>"],
//                     "afterOpen": [["press?", "label=MyApp, http://localhost:8081"]], "reset": "<shell>",
//                     "signIn": [ … ]}             // a tool's own sign-in steps, when it needs one more (a system sheet)
//   }
//
// `press?` presses when the target shows within 3 s (or the seconds given third) and goes on otherwise; `["raw", "keyboard", "enter"]` runs a command
// of that tool as it is. Both are timed and counted like any step.
// Prints a table per tool and a JSON line with every sample.
import {execSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) {
  console.error('usage: node bench/agents.mjs scenario.json [--runs 5] [--only pitbox|agent-device] [--tokenizer <dir>]');
  process.exit(2);
}
const flag = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const runs = Number(flag('runs') ?? 5);
const only = flag('only');
const sc = JSON.parse(fs.readFileSync(file, 'utf8'));

const tokenizerDir = flag('tokenizer');
const countTokens = tokenizerDir ? createRequire(path.join(path.resolve(tokenizerDir), 'package.json'))('@anthropic-ai/tokenizer').countTokens : undefined;
const tokensOf = text => (countTokens ? countTokens(text) : Math.round(text.length / 3.5));

const time = (bin, cwd, argv, {allowFail = false} = {}) => {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [bin, ...argv], {cwd, encoding: 'utf8', maxBuffer: 64 << 20});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 && !allowFail) throw new Error(`${argv.join(' ')} → exit ${r.status}\n${out.slice(-600)}`);
  return {ms, chars: out.length, tokens: tokensOf(out), ok: r.status === 0};
};
const add = (a, b) => ({ms: a.ms + b.ms, chars: a.chars + b.chars, tokens: a.tokens + b.tokens, ok: b.ok});
const zero = {ms: 0, chars: 0, tokens: 0, ok: true};
const sh = cmd => cmd && execSync(cmd, {stdio: 'ignore', shell: '/bin/bash'});

// agent-device takes `id="x"` / `text="x"`; pitbox takes `id=x` / `text=x`.
// A selector already in its form (`role=button text="Not Now"`) is passed as it is.
const adSelector = s => (/="/.test(s) ? s : s.replace(/^(id|text|label)=(.*)$/, (_, k, v) => `${k}="${v.replace(/^"|"$/g, '')}"`));

const tools = {
  pitbox: {
    cfg: sc.pitbox,
    run: (argv, o) => time(sc.pitbox.bin, sc.pitbox.cwd, ['--config', sc.pitbox.config, ...argv], o),
    open: () => ['open', '--relaunch'],
    wait: (sel, s) => ['wait', sel, '--timeout', String(s)],
    press: sel => ['press', sel],
    fill: (sel, text) => ['fill', sel, text],
    snapshot: () => ['snapshot'],
    link: url => ['open', url],
    flow: () => ['run', sc.pitbox.signInFlow, `user=${sc.pitbox.user}`],
    close: () => undefined,
  },
  'agent-device': {
    cfg: sc.agentDevice,
    run: (argv, o) => time(sc.agentDevice.bin, sc.agentDevice.cwd, argv, o),
    open: () => ['open', ...sc.agentDevice.open, '--relaunch'],
    wait: (sel, s) => ['wait', adSelector(sel), String(s * 1000)],
    press: sel => ['press', adSelector(sel), '--settle'],
    fill: (sel, text) => ['fill', adSelector(sel), text, '--settle'],
    snapshot: () => ['snapshot', '-i'],
    link: url => ['open', url],
    close: () => time(sc.agentDevice.bin, sc.agentDevice.cwd, ['close'], {allowFail: true}),
    // The centre of a node by test id or label, from `snapshot -i --json`.
    atPoint: sel => {
      const want = sel.replace(/^(id|text|label)=/, '').replace(/^"|"$/g, '');
      const t0 = process.hrtime.bigint();
      const r = spawnSync(process.execPath, [sc.agentDevice.bin, 'snapshot', '-i', '--json'], {cwd: sc.agentDevice.cwd, encoding: 'utf8', maxBuffer: 64 << 20});
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const out = r.stdout ?? '';
      let rect;
      const walk = o => {
        if (rect || !o || typeof o !== 'object') return;
        if (!Array.isArray(o) && [o.identifier, o.label, o.id].includes(want) && o.rect) rect = o.rect;
        for (const v of Object.values(o)) walk(v);
      };
      walk(JSON.parse(out));
      if (!rect) throw new Error(`no rectangle for ${sel} in the snapshot`);
      return {x: String(Math.round(rect.x + rect.width / 2)), y: String(Math.round(rect.y + rect.height / 2)), r: {ms, chars: out.length, tokens: tokensOf(out), ok: true}};
    },
  },
};

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

const all = {};
for (const [name, t] of Object.entries(tools)) {
  if (only && only !== name) continue;
  const step = (op, sel, text) => {
    // A command of the tool as it is, for what only one tool needs (agent-device: `keyboard enter` on iOS).
    if (op === 'raw') return t.run([sel, text].filter(Boolean));
    if (op === 'press?') {
      // The third element is how long to look, in seconds (3 by default).
      const seen = t.run(t.wait(sel, Number(text ?? 3)), {allowFail: true});
      return seen.ok ? add(seen, t.run(t.press(sel))) : {...seen, ok: true};
    }
    if (op === 'press' || op === 'fill') {
      const first = t.run(op === 'press' ? t.press(sel) : t.fill(sel, text), {allowFail: !!t.atPoint});
      if (first.ok || !t.atPoint) return first;
      // The tool refused the selector (agent-device: "covered by another visible element"): what its hint tells the
      // agent to do — read the rectangle from a full snapshot and act on its centre. Every call counts.
      const located = t.atPoint(sel);
      const done = t.run(op === 'press' ? ['press', located.x, located.y, '--settle'] : ['fill', located.x, located.y, text, '--settle']);
      return add(add(first, located.r), done);
    }
    return t.run(t.wait(sel, 30));
  };
  // Opening the app, with whatever the tool needs answered after a cold launch (a dev client's server list); a
  // deep link goes to the running app as it is.
  const openHome = target => {
    if (target) return t.run(t.link(target));
    let r = t.run(t.open());
    for (const [op, sel, text] of t.cfg.afterOpen ?? []) r = add(r, step(op, sel, text));
    return r;
  };
  const metrics = ['cold', 'signIn', 'flow', 'press', 'snapshot', 'link'];
  const samples = Object.fromEntries(metrics.map(m => [m, []]));
  const keep = (m, r) => samples[m].push({ms: r.ms, chars: r.chars, tokens: r.tokens});
  // Every pass starts from the reset (signed out; with `install` in it, a fresh install), and the cold start is
  // the launch right after it: the same state for both tools whatever the reset does.
  const pass = record => {
    sh(t.cfg.reset);
    const cold = add(openHome(), t.run(t.wait(sc.home, 60)));
    if (record) keep('cold', cold);

    let signIn = zero;
    for (const [i, [op, sel, text]] of (t.cfg.signIn ?? sc.signIn).entries()) {
      const r = step(op, sel, text);
      signIn = add(signIn, r);
      if (record && i === 0) keep('press', r);
    }
    if (record) keep('signIn', signIn);

    const snap = t.run(t.snapshot());
    if (record) keep('snapshot', snap);

    const link = add(openHome(sc.link), t.run(t.wait(sc.player, 30)));
    if (record) keep('link', link);

    if (t.flow) {
      sh(t.cfg.reset);
      openHome();
      t.run(t.wait(sc.home, 60));
      const f = t.run(t.flow());
      if (record) keep('flow', f);
    }
  };
  try {
    // One warm-up pass: first launches pay for caches (bundle, runner) that every later run reuses.
    pass(false);
    for (let i = 0; i < runs; i++) pass(true);
  } finally {
    t.close();
  }
  all[name] = samples;
  const tok = countTokens ? 'tokens' : '≈tokens';
  const row = (label, key) => {
    const xs = samples[key];
    if (!xs.length) return undefined;
    const ms = Math.round(median(xs.map(x => x.ms)));
    return `  ${label.padEnd(30)} ${String(ms).padStart(7)} ms ${String(Math.round(median(xs.map(x => x.tokens)))).padStart(7)} ${tok} ${String(Math.round(median(xs.map(x => x.chars)))).padStart(8)} chars`;
  };
  console.log(
    [
      `${name} (median of ${runs})`,
      row('cold start → home usable', 'cold'),
      row(`sign-in, ${(t.cfg.signIn ?? sc.signIn).length} steps`, 'signIn'),
      row('sign-in as one flow call', 'flow'),
      row('one press', 'press'),
      row('snapshot', 'snapshot'),
      row('deep link → player on screen', 'link'),
    ]
      .filter(Boolean)
      .join('\n'),
  );
}
console.log(JSON.stringify(all));
