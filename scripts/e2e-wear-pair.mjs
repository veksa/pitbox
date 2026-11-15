// The Wear OS Data Layer stand-in end to end: examples/android/relay — one APK with a Ping button and a
// WearableListenerService that answers a ping with a pong — on a phone emulator and a Wear OS emulator, paired with
// `device pair watch`. Checks the nodes and the capability each side sees, a ping each way that wakes the other
// side's app from not running (its listener service answers), unpair, and that the release build of the example
// carries no pitbox code.
//
//   yarn e2e:wear-pair
//   PITBOX_E2E_AVD_PHONE=My_Phone PITBOX_E2E_AVD_WEAR=My_Watch yarn e2e:wear-pair
//
// Boots its devices through pitbox (own ones, or free twins of the AVDs) and gives them back at the end.

import {execFileSync, spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'dist', 'bin.js');
const exampleDir = path.join(root, 'examples', 'android');
const dir = path.join(exampleDir, 'relay');
const apk = path.join(dir, 'build', 'outputs', 'apk', 'debug', 'relay-debug.apk');
const releaseApk = path.join(dir, 'build', 'outputs', 'apk', 'release', 'relay-release-unsigned.apk');
const win = process.platform === 'win32';
const gradlew = d => path.join(d, win ? 'gradlew.bat' : 'gradlew');
const exec = (file, args, cwd) => execFileSync(file, args, {cwd, stdio: 'inherit', shell: win});

const pitbox = (args, timeout = 600_000) => {
  const r = spawnSync(process.execPath, [bin, ...args], {cwd: dir, encoding: 'utf8', timeout});
  return {code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), stdout: r.stdout ?? ''};
};
const must = (args, timeout) => {
  const r = pitbox(args, timeout);
  if (r.code !== 0) throw new Error(`pitbox ${args.join(' ')} failed:\n${r.out}`);
  return r.out;
};
const json = (args, timeout) => JSON.parse(must([...args, '--json'], timeout).replace(/^pitbox:.*\n/gm, ''));
const step = msg => process.stdout.write(`\n▸ ${msg}\n`);

const checks = [];
const check = (name, ok, note = '') => {
  checks.push({name, ok, note});
  console.log(`${ok ? '✓' : '✗'} ${name}${note ? ` — ${note}` : ''}`);
};

/** The screen's line for a resource id, from a snapshot. */
const line = (device, id) => must(['snapshot', '--device', device]).split('\n').find(l => l.includes(`#${id}`)) ?? '';

/** Waits until a resource id's line matches. */
const until = async (device, id, re, ms = 20_000) => {
  for (const end = Date.now() + ms; ; ) {
    const l = line(device, id);
    if (re.test(l) || Date.now() > end) return l;
    await new Promise(r => setTimeout(r, 1000));
  }
};

/**
 * Opens the example until its screen shows: a Wear OS emulator just booted puts its startup screen, then a charging
 * screen, over the app for about half a minute.
 */
const openUntil = device => {
  for (let i = 0; ; i++) {
    must(['open', '--device', device]);
    if (pitbox(['wait', 'id=relay_nodes', '--timeout', '10', '--device', device]).code === 0) return;
    if (i === 5) throw new Error(`the example did not come to the front on ${device}`);
  }
};

const pidOf = serial => {
  const adb = path.join(process.env.ANDROID_HOME ?? path.join(process.env.HOME ?? '', 'Library', 'Android', 'sdk'), 'platform-tools', 'adb');
  return spawnSync(adb, ['-s', serial, 'shell', 'pidof', 'dev.pitbox.example.relay'], {encoding: 'utf8'}).stdout.trim();
};

const booted = [];
try {
  step('build: connect library, relay example (debug and release)');
  exec(gradlew(path.join(root, 'runners', 'android')), ['-p', path.join(root, 'android', 'standalone'), ':connect:assembleDebug', '-q'], root);
  exec(gradlew(exampleDir), [':relay:assembleDebug', ':relay:assembleRelease', '-q'], exampleDir);
  const dex = execFileSync('unzip', ['-p', releaseApk, 'classes*.dex'], {maxBuffer: 64 << 20});
  check('the release build carries no pitbox code', !dex.includes('dev/pitbox/connect'));
  must(['daemon', 'restart']);

  step('devices');
  const {avds} = json(['devices']);
  const pick = kind => process.env[`PITBOX_E2E_AVD_${kind.toUpperCase()}`] ?? avds.find(a => a.kind === kind)?.name;
  const phoneAvd = pick('phone') ?? avds.find(a => !a.kind || a.kind === 'unknown')?.name;
  const wearAvd = pick('wear');
  if (!phoneAvd || !wearAvd) throw new Error(`needs a phone and a Wear OS AVD (have: ${avds.map(a => a.name).join(', ')})`);
  const phone = json(['boot', phoneAvd, '--headless'], 900_000);
  if (!phone.already) booted.push(phone.serial);
  const watch = json(['boot', wearAvd, '--headless'], 900_000);
  if (!watch.already) booted.push(watch.serial);
  console.log(`phone ${phone.avd} as ${phone.serial}, watch ${watch.avd} as ${watch.serial}`);
  // A clean start: the pong carries the count of pings the other side answered.
  for (const s of [phone.serial, watch.serial]) must(['install', apk, '--device', s, '--replace']), must(['clear-app', '--device', s]);

  step('pair');
  const pair = json(['device', 'pair', 'watch', '--device', phone.serial]);
  check('pair', pair.serial === watch.serial && !pair.warnings, `${pair.nodes.phone} ↔ ${pair.nodes.watch}${pair.warnings ? ` ${pair.warnings.join('; ')}` : ''}`);
  check('pair again answers the same pair', json(['device', 'pair', 'watch']).already === true);

  step('watch → phone, the phone app not running');
  must(['stop-app', '--device', phone.serial]);
  openUntil('watch');
  check('the watch sees the phone and its capability', /nodes: .+\(capable 1\)/.test(await until('watch', 'relay_nodes', /capable/)));
  const before = pidOf(phone.serial);
  must(['press', 'id=relay_ping', '--device', 'watch']);
  check('the phone answers a ping from not running', /pong 1 from /.test(await until('watch', 'relay_status', /pong/)) && !before && !!pidOf(phone.serial));

  step('phone → watch, the watch app not running');
  must(['stop-app', '--device', 'watch']);
  openUntil(phone.serial);
  await until(phone.serial, 'relay_nodes', /capable 1/);
  must(['press', 'id=relay_ping', '--device', phone.serial]);
  check('the watch answers a ping from not running', /pong 1 from /.test(await until(phone.serial, 'relay_status', /pong/)));
  const log = json(['device', 'pair', 'watch']);
  check('both listener services were woken', log.last?.filter(l => /\/ping .*services=PingService/.test(l)).length === 2, log.last?.join(' | '));

  step('unpair');
  const u = json(['device', 'unpair', 'watch']);
  check('unpair', u.done?.[0]?.startsWith('unpaired') === true, JSON.stringify(u));
  if (u.released) booted.splice(booted.indexOf(watch.serial), 1);
} catch (e) {
  check('run', false, e.message.split('\n').slice(0, 4).join(' '));
} finally {
  for (const s of booted) pitbox(['device', 'release', '--device', s], 120_000);
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${failed.length ? `✗ ${failed.length} of ${checks.length} checks failed` : `✓ ${checks.length} checks passed`}`);
process.exit(failed.length ? 1 : 0);
