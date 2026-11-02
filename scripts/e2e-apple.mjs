// pitbox against a real app on real simulators: builds examples/apple, then for every kind of Apple device that
// has a simulator on this Mac (phone, tablet, tv, watch, xr) boots one, installs the app and runs the kind's flows
// through the CLI. A simulator that was already booted is left booted. macOS only.
//
//   yarn e2e:apple                                   every kind with a simulator
//   PITBOX_E2E_KINDS=phone,tv yarn e2e:apple
//   PITBOX_E2E_SIM_TV="Apple TV 4K (at 1080p)" yarn e2e:apple   a given simulator (name or udid) for a kind
//   PITBOX_E2E_EXAMPLES=react-native yarn e2e:apple            only examples/react-native, on a phone

import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.platform !== 'darwin') {
  console.error('e2e:apple needs a Mac with Xcode');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = path.join(root, 'examples', 'apple');
const rnDir = path.join(root, 'examples', 'react-native');
const bin = path.join(root, 'dist', 'bin.js');
const products = path.join(example, 'build', 'Build', 'Products');

/** Per kind: the build that runs there, its flows, and the flows that must fail with the app's crash. */
const PLAN = {
  phone: {platform: 'iOS Simulator', scheme: 'PitboxExample', app: 'Debug-iphonesimulator/PitboxExample.app', flows: ['smoke'], fails: ['crash']},
  tablet: {platform: 'iOS Simulator', scheme: 'PitboxExample', app: 'Debug-iphonesimulator/PitboxExample.app', flows: ['smoke'], fails: []},
  tv: {platform: 'tvOS Simulator', scheme: 'PitboxExample', app: 'Debug-appletvsimulator/PitboxExample.app', flows: ['tv'], fails: [], focusMap: true},
  watch: {platform: 'watchOS Simulator', scheme: 'PitboxExampleWatch', app: 'Debug-watchsimulator/PitboxExampleWatch.app', flows: ['watch'], fails: ['crash']},
  xr: {platform: 'visionOS Simulator', scheme: 'PitboxExample', app: 'Debug-xrsimulator/PitboxExample.app', flows: ['smoke'], fails: ['crash']},
};

const pitbox = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [bin, ...args], {cwd: opts.cwd ?? example, encoding: 'utf8', timeout: opts.timeout ?? 900_000});
  return {code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()};
};

const must = (args, opts) => {
  const r = pitbox(args, opts);
  if (r.code !== 0) throw new Error(`pitbox ${args.join(' ')} failed:\n${r.out}`);
  return r.out;
};

const step = msg => process.stdout.write(`\n▸ ${msg}\n`);

/** `iOS 27.1` → [27, 1], for picking the newest runtime. */
const version = os => (os.match(/[\d.]+$/)?.[0] ?? '0').split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [version(a.os), version(b.os)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

const {simulators = []} = JSON.parse(must(['devices', '--json']));
const wanted = process.env.PITBOX_E2E_KINDS?.split(',').map(s => s.trim()) ?? Object.keys(PLAN);
const examples = process.env.PITBOX_E2E_EXAMPLES?.split(',').map(s => s.trim()) ?? ['apple', 'react-native'];
const built = new Map();
const results = [];

/** The simulator a kind runs on: the named one, else a booted one, else the newest runtime's. */
const simFor = kind => {
  const named = process.env[`PITBOX_E2E_SIM_${kind.toUpperCase()}`];
  const ofKind = simulators.filter(s => (named ? s.name === named || s.udid === named : s.kind === kind)).sort(newer);
  return ofKind.find(s => s.state === 'Booted') ?? ofKind[0];
};

if (examples.includes('apple')) step('stand');
if (examples.includes('apple')) console.log(must(['up']));

for (const kind of examples.includes('apple') ? wanted : []) {
  const plan = PLAN[kind];
  if (!plan) {
    results.push({kind, status: 'skip', note: `no plan for "${kind}"`});
    continue;
  }
  const sim = simFor(kind);
  if (!sim) {
    results.push({kind, status: 'skip', note: kind === 'xr' ? 'no visionOS runtime (Xcode › Settings › Components)' : 'no simulator of this kind'});
    continue;
  }
  const wasBooted = sim.state === 'Booted';
  step(`${kind}: ${sim.name} (${sim.os})`);
  const checks = [];
  try {
    const key = `${plan.scheme}|${plan.platform}`;
    if (!built.has(key)) {
      execFileSync('xcodebuild', ['build', '-project', path.join(example, 'PitboxExample.xcodeproj'), '-scheme', plan.scheme, '-destination', `generic/platform=${plan.platform}`, '-derivedDataPath', path.join(example, 'build'), '-quiet'], {stdio: 'inherit'});
      built.set(key, true);
    }
    const app = path.join(products, plan.app);
    if (!fs.existsSync(app)) throw new Error(`the build left no ${plan.app}`);
    if (!wasBooted) console.log(must(['boot', sim.udid]));
    console.log(must(['install', app, '--device', sim.udid]));
    for (const flow of plan.flows) {
      const r = pitbox(['run', flow, '--device', sim.udid]);
      console.log(r.out.split('\n').slice(0, 6).join('\n'));
      checks.push({name: flow, ok: r.code === 0 && r.out.startsWith('✓')});
    }
    for (const flow of plan.fails) {
      const r = pitbox(['run', flow, '--device', sim.udid]);
      console.log(r.out.split('\n').slice(0, 6).join('\n'));
      checks.push({name: `${flow} (fails with the crash)`, ok: r.out.startsWith('✗') && /app crashed: EXC_BREAKPOINT[\s\S]*_checkSubscript/.test(r.out)});
    }
    if (plan.focusMap) {
      const r = pitbox(['focusmap', '--device', sim.udid]);
      console.log(r.out.split('\n').slice(0, 6).join('\n'));
      checks.push({name: 'focus map', ok: r.code === 0 && /reached [1-9]\d* focusable/.test(r.out) && !/trap/i.test(r.out.split('\n')[0] ?? '')});
    }
  } catch (e) {
    checks.push({name: 'setup', ok: false, note: e.message.split('\n').slice(0, 4).join(' ')});
  } finally {
    if (!wasBooted) pitbox(['shutdown', '--device', sim.udid], {timeout: 120_000});
  }
  results.push({kind, sim: sim.name, status: checks.every(c => c.ok) ? 'pass' : 'fail', checks});
}

if (examples.includes('apple')) pitbox(['down']);

// examples/react-native on a phone: through pitbox's dev server (the app reads it from its defaults), the
// in-app channel (freshness, the network log) and a JS error mapped back to its source line.
const rnSim = wanted.includes('phone') ? simFor('phone') : undefined;
if (examples.includes('react-native') && rnSim) {
  const rn = (args, opts = {}) => pitbox(args, {...opts, cwd: rnDir});
  const checks = [];
  const wasBooted = rnSim.state === 'Booted';
  step(`react-native: ${rnSim.name} (${rnSim.os})`);
  try {
    if (!fs.existsSync(path.join(rnDir, 'node_modules', 'react-native'))) execFileSync('yarn', ['install'], {cwd: rnDir, stdio: 'inherit'});
    const ios = path.join(rnDir, 'ios');
    // Codegen writes into ios/build/generated during `pod install`: a deleted build needs it again.
    if (!fs.existsSync(path.join(ios, 'Pods')) || !fs.existsSync(path.join(ios, 'build', 'generated'))) execFileSync('pod', ['install'], {cwd: ios, stdio: 'inherit'});
    execFileSync('xcodebuild', ['build', '-workspace', path.join(ios, 'PitboxExample.xcworkspace'), '-scheme', 'PitboxExample', '-configuration', 'Debug', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', path.join(ios, 'build'), '-quiet'], {stdio: 'inherit'});
    const app = path.join(ios, 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'PitboxExample.app');
    const ok = r => {
      if (r.code !== 0) throw new Error(r.out);
      return r.out;
    };
    console.log(ok(rn(['up'])));
    if (!wasBooted) console.log(ok(rn(['boot', rnSim.udid])));
    console.log(ok(rn(['install', app, '--device', rnSim.udid])));
    const smoke = rn(['run', 'smoke-ios', '--device', rnSim.udid]);
    console.log(smoke.out.split('\n').slice(0, 6).join('\n'));
    checks.push({name: 'smoke', ok: smoke.code === 0 && smoke.out.startsWith('✓')});
    const fresh = rn(['fresh']);
    console.log(fresh.out.split('\n').slice(0, 3).join('\n'));
    checks.push({name: 'fresh bundle', ok: /runs the newest bundle/.test(fresh.out)});
    checks.push({name: 'network log', ok: /localhost:4100\/hello/.test(rn(['app-log', '-n', '50']).out)});
    const err = rn(['run', 'js-error', '--device', rnSim.udid]);
    console.log(err.out.split('\n').slice(0, 8).join('\n'));
    checks.push({name: 'js error with its source line', ok: err.out.startsWith('✓') && /! JS error: example js error/.test(err.out) && /App\.tsx:\d+:\d+/.test(err.out)});
  } catch (e) {
    checks.push({name: 'setup', ok: false, note: e.message.split('\n').slice(0, 4).join(' ')});
  } finally {
    if (!wasBooted) rn(['shutdown', '--device', rnSim.udid], {timeout: 120_000});
    rn(['down']);
    rn(['daemon', 'stop']);
  }
  results.push({kind: 'rn phone', sim: rnSim.name, status: checks.every(c => c.ok) ? 'pass' : 'fail', checks});
}

step('summary');
for (const r of results) {
  const detail = r.checks ? r.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}${c.note ? ` — ${c.note}` : ''}`).join(', ') : r.note;
  console.log(`${r.status === 'pass' ? '✓' : r.status === 'skip' ? '·' : '✗'} ${r.kind.padEnd(9)} ${r.sim ?? ''}  ${detail}`);
}
if (results.some(r => r.status === 'fail')) process.exitCode = 1;
