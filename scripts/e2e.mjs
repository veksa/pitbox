// pitbox against a real app on real emulators: builds examples/android, then for every kind of device that has an
// AVD on this machine (phone, foldable, tablet, tv, xr, wear, automotive) boots one, installs the app and runs the
// kind's flows through the CLI. A device that was already running is left running.
//
//   yarn e2e                         every kind with an AVD
//   PITBOX_E2E_KINDS=phone,tv yarn e2e
//   PITBOX_E2E_AVD_TV=My_TV yarn e2e  a given AVD for a kind

import {execFileSync, spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = path.join(root, 'examples', 'android');
const bin = path.join(root, 'dist', 'bin.js');
const apk = path.join(example, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

/** What each kind runs; `fails` flows must fail, and with the app's crash in the verdict. */
const PLAN = {
  phone: {flows: ['smoke'], fails: ['crash']},
  foldable: {flows: ['smoke'], fails: []},
  tablet: {flows: ['smoke'], fails: []},
  xr: {flows: ['smoke'], fails: []},
  tv: {flows: ['tv'], fails: [], focusMap: true},
};

const pitbox = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [bin, ...args], {cwd: example, encoding: 'utf8', timeout: opts.timeout ?? 600_000});
  return {code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()};
};

const must = (args, opts) => {
  const r = pitbox(args, opts);
  if (r.code !== 0) throw new Error(`pitbox ${args.join(' ')} failed:\n${r.out}`);
  return r.out;
};

const step = msg => process.stdout.write(`\n▸ ${msg}\n`);

step('build the example app');
const gradlew = path.join(example, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
if (process.platform === 'win32') execFileSync('cmd.exe', ['/d', '/c', gradlew, 'assembleDebug', '-q'], {cwd: example, stdio: 'inherit'});
else execFileSync(gradlew, ['assembleDebug', '-q'], {cwd: example, stdio: 'inherit'});

step('stand');
console.log(must(['up']));

const {devices, avds} = JSON.parse(must(['devices', '--json']));
const wanted = process.env.PITBOX_E2E_KINDS?.split(',').map(s => s.trim()) ?? Object.keys(PLAN);
const results = [];

for (const kind of wanted) {
  const plan = PLAN[kind];
  if (!plan) {
    results.push({kind, status: 'skip', note: `no plan for "${kind}"`});
    continue;
  }
  const named = process.env[`PITBOX_E2E_AVD_${kind.toUpperCase()}`];
  const running = devices.find(d => d.state === 'device' && (named ? d.avd === named : d.kind === kind));
  const avd = running?.avd ?? named ?? avds.find(a => a.kind === kind)?.name;
  if (!avd) {
    results.push({kind, status: 'skip', note: 'no AVD of this kind'});
    continue;
  }
  step(`${kind}: ${avd}`);
  const checks = [];
  try {
    if (!running) console.log(must(['boot', avd], {timeout: 900_000}));
    console.log(must(['install', apk, '--device', avd, '--replace']));
    for (const flow of plan.flows) {
      const r = pitbox(['run', flow, '--device', avd]);
      console.log(r.out.split('\n').slice(0, 6).join('\n'));
      checks.push({name: flow, ok: r.code === 0 && r.out.startsWith('✓')});
    }
    for (const flow of plan.fails) {
      const r = pitbox(['run', flow, '--device', avd]);
      console.log(r.out.split('\n').slice(0, 6).join('\n'));
      checks.push({name: `${flow} (fails with the crash)`, ok: r.out.startsWith('✗') && /app crashed: java\.lang\.IllegalStateException: example crash/.test(r.out)});
    }
    if (plan.focusMap) {
      const r = pitbox(['focusmap', '--device', avd]);
      console.log(r.out.split('\n').slice(0, 6).join('\n'));
      checks.push({name: 'focus map', ok: r.code === 0 && !/trap/i.test(r.out.split('\n')[0] ?? '')});
    }
  } catch (e) {
    checks.push({name: 'setup', ok: false, note: e.message.split('\n').slice(0, 4).join(' ')});
  } finally {
    if (!running) pitbox(['shutdown', '--device', avd], {timeout: 120_000});
  }
  results.push({kind, avd, status: checks.every(c => c.ok) ? 'pass' : 'fail', checks});
}

step('summary');
for (const r of results) {
  const detail = r.checks ? r.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}${c.note ? ` — ${c.note}` : ''}`).join(', ') : r.note;
  console.log(`${r.status === 'pass' ? '✓' : r.status === 'skip' ? '·' : '✗'} ${r.kind.padEnd(9)} ${r.avd ?? ''}  ${detail}`);
}
if (results.some(r => r.status === 'fail')) process.exitCode = 1;
