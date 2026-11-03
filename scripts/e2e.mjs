// pitbox against real apps on real emulators, through its CLI.
//
// examples/android, a native app (plus a watch app and a watch face for watches): for every kind of device that has an AVD on this machine (phone, foldable,
// tablet, desktop, tv, xr, glasses, wear, automotive) one AVD is booted, the app installed and the kind's flows run.
// examples/react-native: on a phone, through pitbox's dev server — the connect link, bytecode, the in-app channel
// (freshness, the network log) and a JS error mapped back to its source line.
// A device that was already running is left running; what the run booted it shuts down.
//
//   yarn e2e                                   both examples, every kind with an AVD
//   PITBOX_E2E_EXAMPLES=react-native yarn e2e
//   PITBOX_E2E_KINDS=phone,tv yarn e2e
//   PITBOX_E2E_AVD_TV=My_TV yarn e2e           a given AVD for a kind

import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rnChecks, rnEmbedChecks} from './e2e-rn.mjs';
import {featureChecks} from './e2e-features.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'dist', 'bin.js');
const nativeDir = path.join(root, 'examples', 'android');
const rnDir = path.join(root, 'examples', 'react-native');
const nativeApk = path.join(nativeDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const rnApk = path.join(rnDir, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

/** What each kind runs in the native example; `fails` flows must fail, with the app's crash in the verdict. */
const PLAN = {
  phone: {flows: ['smoke', 'rotate'], fails: ['crash'], features: true},
  foldable: {flows: ['smoke', 'fold', 'mouse', 'window'], fails: []},
  tablet: {flows: ['smoke', 'rotate', 'mouse', 'window'], fails: []},
  desktop: {flows: ['smoke', 'mouse', 'window'], fails: []},
  xr: {flows: ['smoke', 'mouse', 'xr', 'xr-poses', 'xr-panel', 'xr-world'], fails: []},
  tv: {flows: ['tv'], fails: [], focusMap: true},
  wear: {flows: ['wear', 'watch'], fails: [], apks: ['wear', 'wearface']},
  glasses: {flows: ['smoke', 'glasses'], fails: []},
  automotive: {flows: ['smoke', 'car'], fails: []},
};

const pitboxIn = cwd => (args, opts = {}) => {
  const r = spawnSync(process.execPath, [bin, ...args], {cwd, encoding: 'utf8', timeout: opts.timeout ?? 600_000});
  return {code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()};
};

const mustIn = cwd => (args, opts) => {
  const r = pitboxIn(cwd)(args, opts);
  if (r.code !== 0) throw new Error(`pitbox ${args.join(' ')} failed:\n${r.out}`);
  return r.out;
};

const step = msg => process.stdout.write(`\n▸ ${msg}\n`);
const head = (out, n = 6) => console.log(out.split('\n').slice(0, n).join('\n'));

/** Runs a project script: through cmd.exe on Windows, where gradlew and yarn are batch files. */
const exec = (file, args, cwd) =>
  process.platform === 'win32' ? execFileSync('cmd.exe', ['/d', '/c', file, ...args], {cwd, stdio: 'inherit'}) : execFileSync(file, args, {cwd, stdio: 'inherit'});

const gradlew = dir => path.join(dir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');

/**
 * A booted device of `kind`: a running one, the AVD named in the environment, or the first AVD of the kind that
 * can start apps (one with a screen lock cannot after a boot).
 */
const deviceOf = (kind, pitbox, must) => {
  const {devices, avds} = JSON.parse(must(['devices', '--json']));
  const named = process.env[`PITBOX_E2E_AVD_${kind.toUpperCase()}`];
  const running = devices.find(d => d.state === 'device' && (named ? d.avd === named : d.kind === kind));
  const candidates = running ? [running.avd] : named ? [named] : avds.filter(a => a.kind === kind).map(a => a.name);
  if (!candidates.length) return {skip: 'no AVD of this kind'};
  for (const name of candidates) {
    step(`${kind}: ${name}`);
    if (!running) console.log(must(['boot', name], {timeout: 900_000}));
    if (pitbox(['doctor']).out.includes(`${name}: locked after boot`)) {
      console.log(`${name} has a screen lock: apps cannot start after a boot — next`);
      if (!running) pitbox(['shutdown', '--device', name], {timeout: 120_000});
      continue;
    }
    return {avd: name, booted: !running};
  }
  return {skip: 'every AVD of this kind has a screen lock'};
};

const results = [];

const runKind = async (label, kind, pitbox, must, body) => {
  let dev;
  const checks = [];
  try {
    dev = deviceOf(kind, pitbox, must);
    if (dev.skip) return results.push({kind: label, status: 'skip', note: dev.skip});
    await body(dev.avd, checks);
  } catch (e) {
    checks.push({name: 'setup', ok: false, note: e.message.split('\n').slice(0, 4).join(' ')});
  } finally {
    if (dev?.booted) pitbox(['shutdown', '--device', dev.avd], {timeout: 120_000});
  }
  results.push({kind: label, avd: dev?.avd, status: checks.length && checks.every(c => c.ok) ? 'pass' : 'fail', checks});
};

const examples = process.env.PITBOX_E2E_EXAMPLES?.split(',').map(s => s.trim()) ?? ['android', 'react-native'];

// ---- native ---------------------------------------------------------------------------------------------------

if (examples.includes('android')) {
  const pitbox = pitboxIn(nativeDir);
  const must = mustIn(nativeDir);
  step('android example: build, stand');
  exec(gradlew(nativeDir), ['assembleDebug', '-q'], nativeDir);
  // A daemon left from an older build would answer with the older code.
  must(['daemon', 'restart']);
  console.log(must(['up']));
  const wanted = process.env.PITBOX_E2E_KINDS?.split(',').map(s => s.trim()) ?? Object.keys(PLAN);
  for (const kind of wanted) {
    const plan = PLAN[kind];
    if (!plan) {
      results.push({kind, status: 'skip', note: `no plan for "${kind}"`});
      continue;
    }
    await runKind(kind, kind, pitbox, must, async (avd, checks) => {
      console.log(must(['install', nativeApk, '--device', avd, '--replace']));
      // Watches also get the watch app (tile, complication, ambient) and the watch face that shows it.
      for (const m of plan.apks ?? []) console.log(must(['install', path.join(nativeDir, m, 'build', 'outputs', 'apk', 'debug', `${m}-debug.apk`), '--device', avd, '--replace']));
      for (const flow of plan.flows) {
        const r = pitbox(['run', flow, '--device', avd]);
        head(r.out);
        checks.push({name: flow, ok: r.code === 0 && r.out.startsWith('✓')});
      }
      for (const flow of plan.fails) {
        const r = pitbox(['run', flow, '--device', avd]);
        head(r.out);
        checks.push({name: `${flow} (fails with the crash)`, ok: r.out.startsWith('✗') && /app crashed: java\.lang\.IllegalStateException: example crash/.test(r.out)});
      }
      if (plan.features) checks.push(...(await featureChecks({pitbox, device: avd, dir: nativeDir, platform: 'android', bin})));
      if (plan.focusMap) {
        const r = pitbox(['focusmap', '--device', avd]);
        head(r.out);
        checks.push({name: 'focus map', ok: r.code === 0 && !/trap/i.test(r.out.split('\n')[0] ?? '')});
      }
    });
  }
  // The stand goes too: one left running would answer the next run as an external service, without its logs.
  pitbox(['down']);
  pitbox(['daemon', 'stop']);
}

// ---- react native -----------------------------------------------------------------------------------------------

if (examples.includes('react-native') && (!process.env.PITBOX_E2E_KINDS || process.env.PITBOX_E2E_KINDS.includes('phone'))) {
  const pitbox = pitboxIn(rnDir);
  const must = mustIn(rnDir);
  step('react-native example: install, build, stand and dev server');
  if (!fs.existsSync(path.join(rnDir, 'node_modules', 'react-native'))) exec(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', ['install'], rnDir);
  const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  exec(gradlew(path.join(rnDir, 'android')), ['assembleDebug', '-q', `-PreactNativeArchitectures=${abi}`], path.join(rnDir, 'android'));
  must(['daemon', 'restart']);
  console.log(must(['up'], {timeout: 900_000}));
  await runKind('react-native', 'phone', pitbox, must, async (avd, checks) => {
    console.log(must(['install', rnApk, '--device', avd, '--replace']));
    checks.push(...rnChecks({rn: pitbox, device: avd, rnDir, platform: 'android'}));
    checks.push(...rnEmbedChecks({rn: pitbox, device: avd, apk: rnApk, install: apk => console.log(must(['install', apk, '--device', avd, '--replace']))}));
  });
  pitbox(['down']);
  pitbox(['daemon', 'stop']);
}

step('summary');
for (const r of results) {
  const detail = r.checks ? r.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}${c.note ? ` — ${c.note}` : ''}`).join(', ') : r.note;
  console.log(`${r.status === 'pass' ? '✓' : r.status === 'skip' ? '·' : '✗'} ${r.kind.padEnd(12)} ${r.avd ?? ''}  ${detail}`);
}
if (results.some(r => r.status === 'fail')) process.exitCode = 1;
