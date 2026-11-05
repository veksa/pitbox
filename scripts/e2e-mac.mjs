// pitbox against a native app on this Mac: builds examples/mac (swiftc, no Xcode project) and drives it through the
// CLI as the device `mac` — the smoke flow (native controls, a secure field, a shortcut, the menu bar item, a web
// page in a second window), input with another app in front, images of the window, and a crash that comes back
// with its step. The app is quit at the end. macOS only; needs Accessibility (and Screen Recording for images) for
// the app that runs this script — `doctor` says which.
//
//   yarn e2e:mac

import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.platform !== 'darwin') {
  console.error('e2e:mac needs a Mac');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = path.join(root, 'examples', 'mac');
const bin = path.join(root, 'dist', 'bin.js');
const app = path.join(example, 'build', 'PitboxExample.app');

const pitbox = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [bin, ...args], {cwd: example, encoding: 'utf8', timeout: opts.timeout ?? 300_000});
  return {code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()};
};
const step = msg => process.stdout.write(`\n▸ ${msg}\n`);
const checks = [];
const check = (name, ok, note) => {
  checks.push({name, ok, note});
  console.log(`${ok ? '✓' : '✗'} ${name}${note && !ok ? ` — ${note}` : ''}`);
};

step('build examples/mac');
fs.rmSync(app, {recursive: true, force: true});
fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), {recursive: true});
fs.copyFileSync(path.join(example, 'App', 'Info.plist'), path.join(app, 'Contents', 'Info.plist'));
execFileSync('xcrun', ['swiftc', '-Onone', path.join(example, 'App', 'main.swift'), '-o', path.join(app, 'Contents', 'MacOS', 'PitboxExample')], {stdio: 'inherit'});
execFileSync('codesign', ['-s', '-', '-f', app], {stdio: 'ignore'});

// The keyboard layout in use: the run types with whatever it is, a Cyrillic one included.
const layout = spawnSync('defaults', ['read', 'com.apple.HIToolbox', 'AppleSelectedInputSources'], {encoding: 'utf8'}).stdout.match(/"KeyboardLayout Name" = "?([^";]+)/)?.[1];
console.log(`keyboard layout: ${layout ?? 'unknown'}`);

try {
  step('daemon and permissions');
  // A daemon left from an older build would answer with the older code.
  pitbox(['daemon', 'restart']);
  const doctor = pitbox(['doctor', '--only', 'mac-permissions']);
  console.log(doctor.out);
  if (/Accessibility is off/.test(doctor.out)) throw new Error('Accessibility is off: see the hint above');
  const images = !/Screen Recording is off/.test(doctor.out);

  step('smoke flow');
  const smoke = pitbox(['run', 'smoke', '--device', 'mac']);
  console.log(smoke.out.split('\n').slice(0, 12).join('\n'));
  check('smoke: native input, a secure field, ⌘K, the menu bar item, a web page in a second window, scrolling, windows', smoke.code === 0 && smoke.out.startsWith('✓'));

  step('another app in front');
  // Finder in front, as a person's terminal would be: the press brings the app forward first, and lands.
  execFileSync('open', ['-a', 'Finder']);
  await new Promise(r => setTimeout(r, 800));
  // The main window, whichever window the smoke flow left in front.
  pitbox(['window', 'PitboxExample', '--device', 'mac']);
  pitbox(['fill', 'id=name', 'Front', '--device', 'mac']);
  execFileSync('open', ['-a', 'Finder']);
  await new Promise(r => setTimeout(r, 800));
  const press = pitbox(['press', 'id=greet', '--device', 'mac']);
  const front = pitbox(['run', '--steps', 'expect text="Hello, Front"', '--device', 'mac']);
  pitbox(['window', 'front', '--device', 'mac']);
  check('input with another app in front brings the app forward first', press.code === 0 && front.code === 0, `${press.out}\n${front.out}`.split('\n').slice(0, 4).join(' '));

  step('images of the window');
  if (images) {
    const shot = pitbox(['screenshot', '--device', 'mac']);
    const file = /(\S+\.png)/.exec(shot.out)?.[1];
    check('a screenshot of the window', shot.code === 0 && !!file && fs.existsSync(path.resolve(example, file)), shot.out);
    const visual = pitbox(['run', '--steps', 'visual e2e-mac mask id=greeting\nvisual e2e-mac mask id=greeting', '--device', 'mac']);
    check('a visual check against its own baseline', visual.code === 0, visual.out.split('\n').slice(0, 3).join(' '));
    fs.rmSync(path.join(example, 'visual'), {recursive: true, force: true});
  } else check('images of the window', true, 'skipped: Screen Recording is off');

  step('crash');
  const crash = pitbox(['run', 'crash', '--device', 'mac']);
  console.log(crash.out.split('\n').slice(0, 6).join('\n'));
  check('crash flow fails with the crash and its stack', crash.out.startsWith('✗') && /app crashed: EXC_BREAKPOINT/.test(crash.out), crash.out.split('\n').slice(0, 3).join(' '));
} catch (e) {
  check('setup', false, e.message.split('\n').slice(0, 4).join(' '));
} finally {
  pitbox(['stop-app', '--device', 'mac']);
  pitbox(['daemon', 'stop']);
}

step('summary');
console.log(`${checks.every(c => c.ok) ? '✓' : '✗'} mac  ${checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}`).join(', ')}`);
if (!checks.every(c => c.ok)) process.exitCode = 1;
