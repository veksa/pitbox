// pitbox against a real app on real simulators: builds examples/apple, then for every kind of Apple device that
// has a simulator on this Mac (phone, foldable, tablet, tv, watch, xr) boots one, installs the app and runs the kind's flows
// through the CLI. A simulator that was already booted is left booted. macOS only.
//
//   yarn e2e:apple                                   every kind with a simulator
//   PITBOX_E2E_KINDS=phone,tv yarn e2e:apple
//   PITBOX_E2E_SIM_TV="Apple TV 4K (at 1080p)" yarn e2e:apple   a given simulator (name or udid) for a kind
//   PITBOX_E2E_EXAMPLES=react-native yarn e2e:apple            only examples/react-native, on a phone
//   PITBOX_E2E_DEVICE=<udid> yarn e2e:apple          examples/apple on a physical iPhone (connected, unlocked):
//                                                    signed with the Mac's Apple Development team (PITBOX_E2E_TEAM
//                                                    when several), its ids made the team's own; pushes go through the
//                                                    app's PitboxNotifications hook (no APNs entitlement)

import {execFileSync, spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rnChecks} from './e2e-rn.mjs';
import {featureChecks} from './e2e-features.mjs';

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
  phone: {platform: 'iOS Simulator', scheme: 'PitboxExample', app: 'Debug-iphonesimulator/PitboxExample.app', flows: ['smoke', 'rotate', 'modal', 'permission'], fails: ['crash'], features: true},
  foldable: {platform: 'iOS Simulator', scheme: 'PitboxExample', app: 'Debug-iphonesimulator/PitboxExample.app', flows: ['smoke', 'fold'], fails: ['crash'], cover: true},
  tablet: {platform: 'iOS Simulator', scheme: 'PitboxExample', app: 'Debug-iphonesimulator/PitboxExample.app', flows: ['smoke', 'rotate', 'pointer', 'modal'], fails: []},
  tv: {platform: 'tvOS Simulator', scheme: 'PitboxExample', app: 'Debug-appletvsimulator/PitboxExample.app', flows: ['tv'], fails: [], focusMap: true},
  watch: {platform: 'watchOS Simulator', scheme: 'PitboxExampleWatch', app: 'Debug-watchsimulator/PitboxExampleWatch.app', flows: ['watch', 'crown'], fails: ['crash']},
  xr: {platform: 'visionOS Simulator', scheme: 'PitboxExample', app: 'Debug-xrsimulator/PitboxExample.app', flows: ['smoke', 'vision'], fails: ['crash'], windowShot: true},
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
  // A physical device is listed too: it runs only in the device mode.
  const ofKind = simulators.filter(s => !s.physical && (named ? s.name === named || s.udid === named : s.kind === kind)).sort(newer);
  return ofKind.find(s => s.state === 'Booted') ?? ofKind[0];
};

// The device mode: examples/apple on a physical iPhone, and nothing else.
const deviceUdid = process.env.PITBOX_E2E_DEVICE;
if (deviceUdid) {
  await runOnDevice(deviceUdid);
  summary();
  process.exit(process.exitCode ?? 0);
}

if (examples.includes('apple')) step('stand');
// A daemon left from an older build would answer with the older code.
if (examples.includes('apple')) must(['daemon', 'restart']);
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
      // The camera request asks again only once its answer is forgotten.
      if (flow === 'permission') execFileSync('xcrun', ['simctl', 'privacy', sim.udid, 'reset', 'camera', 'dev.pitbox.example']);
      const r = pitbox(['run', flow, '--device', sim.udid]);
      console.log(r.out.split('\n').slice(0, 6).join('\n'));
      checks.push({name: flow, ok: r.code === 0 && r.out.startsWith('✓')});
    }
    for (const flow of plan.fails) {
      const r = pitbox(['run', flow, '--device', sim.udid]);
      console.log(r.out.split('\n').slice(0, 6).join('\n'));
      checks.push({name: `${flow} (fails with the crash)`, ok: r.out.startsWith('✗') && /app crashed: EXC_BREAKPOINT[\s\S]*_checkSubscript/.test(r.out)});
    }
    if (plan.cover) {
      // Folded, the app is on the cover screen: info names it and a screenshot is of it.
      pitbox(['posture', 'closed', '--device', sim.udid]);
      const info = pitbox(['info', '--device', sim.udid]);
      checks.push({name: 'folded on the cover screen', ok: /fold: folded: cover screen/.test(info.out)});
      const shot = pitbox(['screenshot', '--device', sim.udid]);
      checks.push({name: 'screenshot of the lit screen', ok: shot.code === 0 && /\.png \(\d+ KB\)/.test(shot.out)});
    }
    if (plan.features) checks.push(...(await featureChecks({pitbox, device: sim.udid, dir: example, platform: 'apple', bin})));
    if (plan.windowShot) {
      // visionOS's screen shot is 1×1: images come from the app's window, or visual checks would always match.
      // The crash flow left no app running: it comes back first.
      pitbox(['run', '--steps', 'open!\nwait id=title 30', '--device', sim.udid]);
      const shot = pitbox(['shot', 'window', '--device', sim.udid]);
      const size = /\((\d+)×(\d+),/.exec(shot.out);
      checks.push({name: 'shot of the window, not an empty screen', ok: !!size && Number(size[1]) > 100 && Number(size[2]) > 100});
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

// A remote Mac, both ends on this one: `serve-devices` with a token, and a project elsewhere that drives this Mac's
// iPhone through `apple.remote` — the upload of the app, a flow with a deep link, a screenshot coming back.
const remoteSim = examples.includes('apple') && wanted.includes('phone') ? simFor('phone') : undefined;
if (remoteSim) {
  step(`remote Mac: ${remoteSim.name}`);
  const checks = [];
  const token = `e2e-${process.pid}`;
  const port = 7790;
  const host = spawn(process.execPath, [bin, 'serve-devices', '--listen', `127.0.0.1:${port}`], {env: {...process.env, PITBOX_TOKEN: token}, stdio: 'ignore'});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-remote-'));
  fs.writeFileSync(path.join(dir, 'pitbox.config.json'), JSON.stringify({app: {apple: 'dev.pitbox.example'}, apple: {remote: `http://127.0.0.1:${port}`}, routes: {detail: 'pitboxexample://detail/{id}'}}));
  const far = (args, opts = {}) => {
    const r = spawnSync(process.execPath, [bin, ...args], {cwd: dir, encoding: 'utf8', timeout: opts.timeout ?? 900_000, env: {...process.env, PITBOX_REMOTE_TOKEN: token}});
    return {code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()};
  };
  const wasBooted = remoteSim.state === 'Booted';
  try {
    await new Promise(r => setTimeout(r, 1500));
    const devices = far(['devices']);
    checks.push({name: 'the remote Mac lists its simulators', ok: devices.out.includes(remoteSim.name)});
    if (!wasBooted) far(['boot', remoteSim.udid]);
    const installed = far(['install', path.join(products, PLAN.phone.app), '--device', remoteSim.udid]);
    console.log(installed.out.split('\n')[0]);
    const run = far(['run', '--steps', 'open!\nwait id=title 60\nfill id=name "Remote"\npress id=greet\nexpect text="Hello, Remote"\ngoto detail id=5\nwait text="Detail 5" 15\npress id=back\nexpect id=content_list', '--device', remoteSim.udid]);
    console.log(run.out.split('\n').slice(0, 2).join('\n'));
    const shot = far(['screenshot', '--device', remoteSim.udid]);
    checks.push({name: 'an app uploaded, a flow and a deep link through the remote Mac, a screenshot back', ok: installed.code === 0 && run.code === 0 && /\.png \(\d+ KB\)/.test(shot.out) && shot.out.includes(dir)});
    // A daemon of its own with the wrong token: the one above keeps the token it started with.
    far(['daemon', 'stop']);
    const wrong = spawnSync(process.execPath, [bin, 'devices'], {cwd: dir, encoding: 'utf8', env: {...process.env, PITBOX_REMOTE_TOKEN: 'wrong'}});
    console.log(`${wrong.stdout}${wrong.stderr}`.trim().split('\n')[0]);
    checks.push({name: 'a wrong token is turned away, and said so', ok: !`${wrong.stdout}${wrong.stderr}`.includes(remoteSim.udid) && /refused the token/.test(`${wrong.stdout}${wrong.stderr}`)});
  } catch (e) {
    checks.push({name: 'setup', ok: false, note: e.message.split('\n').slice(0, 4).join(' ')});
  } finally {
    // Given back through the remote Mac, whose session booted and holds it: this project's daemon holds no lease on
    // it and would leave it running, unleased, and the React Native section would then boot a copy beside it. The
    // daemon with the wrong token goes first.
    far(['daemon', 'stop']);
    if (!wasBooted) {
      const back = far(['shutdown', '--device', remoteSim.udid], {timeout: 120_000});
      checks.push({name: 'the simulator is given back through the remote Mac', ok: back.code === 0, ...(back.code === 0 ? {} : {note: back.out.split('\n')[0]})});
    }
    far(['daemon', 'stop']);
    host.kill();
    fs.rmSync(dir, {recursive: true, force: true});
  }
  results.push({kind: 'remote', sim: remoteSim.name, status: checks.every(c => c.ok) ? 'pass' : 'fail', checks});
}

// examples/react-native on a phone: through pitbox's dev server (the app reads it from its defaults), the same
// checks as on Android (scripts/e2e-rn.mjs): the in-app channel, the JS runtime, perf and hot updates.
const rnSim = wanted.includes('phone') ? simFor('phone') : undefined;
if (examples.includes('react-native') && rnSim) {
  const rn = (args, opts = {}) => pitbox(args, {...opts, cwd: rnDir});
  const checks = [];
  const wasBooted = rnSim.state === 'Booted';
  step(`react-native: ${rnSim.name} (${rnSim.os})`);
  try {
    if (!fs.existsSync(path.join(rnDir, 'node_modules', 'react-native'))) execFileSync('yarn', ['install'], {cwd: rnDir, stdio: 'inherit'});
    const ios = path.join(rnDir, 'ios');
    // Codegen writes into ios/build/generated during `pod install`: a deleted build needs it again. Pods that no
    // longer match the lock file (a pull changed it) fail the build, so they are installed again too.
    const lock = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    const stale = lock(path.join(ios, 'Podfile.lock')) !== lock(path.join(ios, 'Pods', 'Manifest.lock'));
    if (stale || !fs.existsSync(path.join(ios, 'Pods')) || !fs.existsSync(path.join(ios, 'build', 'generated'))) execFileSync('pod', ['install'], {cwd: ios, stdio: 'inherit'});
    execFileSync('xcodebuild', ['build', '-workspace', path.join(ios, 'PitboxExample.xcworkspace'), '-scheme', 'PitboxExample', '-configuration', 'Debug', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', path.join(ios, 'build'), '-quiet'], {stdio: 'inherit'});
    const app = path.join(ios, 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'PitboxExample.app');
    const ok = r => {
      if (r.code !== 0) throw new Error(r.out);
      return r.out;
    };
    ok(rn(['daemon', 'restart']));
    console.log(ok(rn(['up'])));
    if (!wasBooted) console.log(ok(rn(['boot', rnSim.udid])));
    console.log(ok(rn(['install', app, '--device', rnSim.udid])));
    checks.push(...rnChecks({rn, device: rnSim.udid, rnDir, platform: 'apple'}));
  } catch (e) {
    checks.push({name: 'setup', ok: false, note: e.message.split('\n').slice(0, 4).join(' ')});
  } finally {
    if (!wasBooted) rn(['shutdown', '--device', rnSim.udid], {timeout: 120_000});
    rn(['down']);
    rn(['daemon', 'stop']);
  }
  results.push({kind: 'rn phone', sim: rnSim.name, status: checks.every(c => c.ok) ? 'pass' : 'fail', checks});
}

summary();

function summary() {
  step('summary');
  for (const r of results) {
    const detail = r.checks ? r.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}${c.note ? ` — ${c.note}` : ''}`).join(', ') : r.note;
    console.log(`${r.status === 'pass' ? '✓' : r.status === 'skip' ? '·' : '✗'} ${r.kind.padEnd(9)} ${r.sim ?? ''}  ${detail}`);
  }
  if (results.some(r => r.status === 'fail')) process.exitCode = 1;
}

/**
 * examples/apple on a physical iPhone: built for iphoneos and signed by the Mac's team (a free Personal Team signs
 * no push, so the app's entitlements are left out, and registers no id another team has, so the ids get the team's
 * suffix, as the runner's do). The stand is reached on the phone's own localhost through the runner's relay.
 */
async function runOnDevice(udid) {
  const {pickTeam, readSigningIdentities, teamSuffix} = await import('../src/drivers/apple/physical.ts');
  const team = pickTeam(await readSigningIdentities(), process.env.PITBOX_E2E_TEAM);
  const bundleId = `dev.pitbox.example${teamSuffix(team)}`;
  // The daemon reads the app id from the example's config, which takes it from here; one left from an older build
  // would answer with the older code.
  process.env.PITBOX_EXAMPLE_APPLE_ID = bundleId;
  must(['daemon', 'restart']);
  const dev = JSON.parse(must(['devices', '--json'])).simulators?.find(s => s.udid === udid && s.physical);
  if (!dev) {
    results.push({kind: 'device', status: 'fail', checks: [{name: 'setup', ok: false, note: `no physical device ${udid} (pitbox devices lists them)`}]});
    return;
  }
  step(`device: ${dev.name} (${dev.os})`);
  const checks = [];
  try {
    console.log(must(['up']));
    // Xcode reads the target's entitlements for the profile whatever the build is told: an empty set of its own.
    const entitlements = path.join(example, 'build', 'device.entitlements');
    fs.mkdirSync(path.dirname(entitlements), {recursive: true});
    fs.writeFileSync(entitlements, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>\n');
    execFileSync(
      'xcodebuild',
      ['build', '-project', path.join(example, 'PitboxExample.xcodeproj'), '-scheme', 'PitboxExample', '-destination', `id=${udid}`, '-derivedDataPath', path.join(example, 'build'), '-quiet', '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'CODE_SIGN_STYLE=Automatic', `DEVELOPMENT_TEAM=${team}`, 'CODE_SIGN_IDENTITY=Apple Development', `PITBOX_ID_SUFFIX=${teamSuffix(team)}`, `CODE_SIGN_ENTITLEMENTS=${entitlements}`],
      {stdio: 'inherit'},
    );
    const app = path.join(products, 'Debug-iphoneos', 'PitboxExample.app');
    if (!fs.existsSync(app)) throw new Error('the build left no Debug-iphoneos/PitboxExample.app');
    // A fresh install: the camera permission is asked again (a device's answers cannot be reset from the Mac).
    pitbox(['uninstall', '--device', udid, '--pkg', bundleId]);
    console.log(must(['install', app, '--device', udid]));
    for (const flow of ['permission', 'smoke', 'modal', 'rotate']) {
      const r = pitbox(['run', flow, '--device', udid]);
      console.log(r.out.split('\n').slice(0, 6).join('\n'));
      checks.push({name: flow, ok: r.code === 0 && r.out.startsWith('✓')});
    }
    const r = pitbox(['run', 'crash', '--device', udid]);
    console.log(r.out.split('\n').slice(0, 6).join('\n'));
    checks.push({name: 'crash (fails with the crash)', ok: r.out.startsWith('✗') && /app crashed/.test(r.out)});
    // The report is copied off the device: the crash names its frames, not only that the app stopped.
    checks.push({name: 'crash report pulled', ok: /app crashed/.test(r.out) && !/no crash report yet/.test(r.out)});
    // What the app keeps between launches (a launch counter in UserDefaults): wiped, saved and brought back.
    const on = args => pitbox([...args, '--device', udid]);
    const launches = n => (on(['open', '--relaunch']), on(['wait', `text="launches ${n}"`, '20']).code === 0);
    // A context menu's list runs past the bottom of the screen: a swipe over it must start on the screen, not at
    // the bottom edge, where the system takes it for the gesture that goes to the Home Screen.
    on(['open', '--relaunch']);
    on(['longpress', 'id=menu_target']);
    on(['swipe', 'up']);
    const menu = on(['snapshot']).out;
    checks.push({name: 'swipe over a context menu stays in the app', ok: /button "Copy"/.test(menu) && !/Home screen icons/.test(menu), ...(/Home screen icons/.test(menu) ? {note: 'the swipe went to the Home Screen'} : {})});
    // The menu hides the app from accessibility and has no back button: back taps outside it.
    const closed = on(['key', 'back']);
    const after = on(['snapshot']).out;
    checks.push({name: 'key back closes a context menu', ok: closed.code === 0 && !/button "Copy"/.test(after) && /#menu_target/.test(after), ...(closed.code || /button "Copy"/.test(after) ? {note: closed.out.split('\n')[0]} : {})});
    // Screen video: the runner's screenshots made into an MP4, a few frames a second.
    const rec = on(['capture', 'start', 'name=e2e-device']);
    on(['swipe', 'up']);
    on(['swipe', 'down']);
    const recStop = on(['capture', 'stop']);
    const recFps = Number(/screenshots, ([\d.]+) a second/.exec(recStop.out)?.[1] ?? 0);
    checks.push({name: 'screen video from screenshots', ok: rec.code === 0 && recStop.code === 0 && /e2e-device\.mp4/.test(recStop.out) && recFps >= 1, note: recStop.code || rec.code ? (rec.code ? rec : recStop).out.split('\n')[0] : `${recFps} frames a second`});
    // Memory and CPU come from an Activity Monitor recording (xctrace): ps on the Mac does not see a device's apps.
    on(['open', '--relaunch']);
    const perf = on(['perf']);
    checks.push({name: 'perf on the device', ok: perf.code === 0 && /memory [1-9]\d* MB/.test(perf.out), ...(perf.code ? {note: perf.out.split('\n')[0]} : {})});
    // A push, which a device takes only from APNs: the app's debug hook shows it, its banner is read, and the tap
    // reaches the app's notification delegate through the same hook. Before the restore below, which reinstalls the
    // app and so takes its notification permission away.
    // The prompt is the system's, in the device's language and with no ids on its buttons: its last one allows.
    on(['open', '--relaunch']);
    on(['press', 'id=notifications']);
    const prompt = on(['snapshot', '--system']).out.split('— com.apple.springboard')[1] ?? '';
    const allow = [...prompt.matchAll(/^(@e\d+) button /gm)].pop()?.[1];
    if (allow) on(['press', allow]);
    on(['wait', 'text="notifications allowed"', '10']);
    const pushed = on(['push', 'title=Hello device', 'body=From the hook']);
    checks.push({name: 'push through the app\'s hook', ok: pushed.code === 0 && /banner shown "Hello device"/.test(pushed.out), ...(pushed.code || !/banner shown/.test(pushed.out) ? {note: pushed.out.split('\n')[0]} : {})});
    const tapped = on(['push', 'respond', 'open', 'title=Hello device']);
    checks.push({name: 'push respond on the device', ok: tapped.code === 0 && /opened "Hello device"/.test(tapped.out), ...(tapped.code ? {note: tapped.out.split('\n')[0]} : {})});
    // push clear through the same hook: the notification is gone, so a tap on it finds nothing.
    on(['push', 'title=Clear me', 'body=From the hook']);
    const cleared = on(['push', 'clear']);
    const gone = on(['push', 'respond', 'open', 'title=Clear me']);
    checks.push({name: 'push clear on the device', ok: cleared.code === 0 && /[1-9]\d* notifications? cleared/.test(cleared.out) && gone.code !== 0 && /no delivered notification/.test(gone.out), ...(cleared.code || !/cleared/.test(cleared.out) ? {note: cleared.out.split('\n')[0]} : {})});
    // A Live Activity through the same kind of hook: its state is copied off the device.
    const started = on(['push', 'activity', 'start', 'type=DeliveryAttributes', 'attributes={"order":"42"}', 'state={"status":"Packed","progress":0.2}']);
    const updated = on(['push', 'activity', 'update', 'state={"status":"On the way","progress":0.6}']);
    const ended = on(['push', 'activity', 'end', 'dismissal=0']);
    checks.push({name: 'a Live Activity on the device', ok: /✓ .*Live Activity started/.test(started.out) && /✓ .*Live Activity updated/.test(updated.out) && /✓ .*Live Activity ended/.test(ended.out), ...([started, updated, ended].find(r => !/✓/.test(r.out)) ? {note: [started, updated, ended].find(r => !/✓/.test(r.out)).out.split('\n')[0]} : {})});
    on(['clear-app']);
    checks.push({name: 'clear-app', ok: launches(1)});
    on(['state', 'save', 'e2e-device']);
    const saved = launches(3);
    on(['state', 'restore', 'e2e-device']);
    checks.push({name: 'app state saved and restored', ok: saved && launches(2)});
    on(['state', 'rm', 'e2e-device']);
    // The device's own language stays: the app gets it in the arguments of pitbox's launches.
    on(['settings', 'locale=fr']);
    const french = (on(['open', '--relaunch']), on(['wait', 'text="fr"', '20']).code === 0);
    on(['settings', 'locale=']);
    checks.push({name: 'locale', ok: french && (on(['open', '--relaunch']), on(['wait', 'text="fr"', '3']).code !== 0)});
    const logs = on(['app-logs', '--lines', '20']);
    checks.push({name: 'app logs', ok: logs.code === 0 && /PitboxExample\[\d+\]/.test(logs.out), ...(logs.code ? {note: logs.out.split('\n')[0]} : {})});
  } catch (e) {
    checks.push({name: 'setup', ok: false, note: e.message.split('\n').slice(0, 4).join(' ')});
  } finally {
    pitbox(['down']);
    pitbox(['daemon', 'stop']);
  }
  // The device stays on after `down`: its runner's xcodebuild must end with the session, not outlive it.
  const left = spawnSync('pgrep', ['-f', `test-without-building.*id=${udid}`], {encoding: 'utf8'}).stdout.trim();
  checks.push({name: 'runner ends with down', ok: !left, ...(left ? {note: `xcodebuild still running: ${left.split('\n').join(', ')}`} : {})});
  results.push({kind: 'device', sim: dev.name, status: checks.every(c => c.ok) ? 'pass' : 'fail', checks});
}
