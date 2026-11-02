// Edit-to-running-JS on an Android device: append a marker log line to a module that runs at startup, relaunch
// the app through a deep link, and time intent → `Running "main"`, checking that the marker (the new code) ran.
// The edit is reverted afterwards.
//
//   node bench/editloop.mjs --file <app>/src/startup.tsx --pkg com.example.app --url '<deep link>' [--wait 0] [--runs 2] [--adb adb]

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const file = arg('file');
const pkg = arg('pkg');
const url = arg('url');
const adb = arg('adb', 'adb');
const waitMs = Number(arg('wait', '0'));
const runs = Number(arg('runs', '1'));
if (!file || !pkg || !url) throw new Error('required: --file --pkg --url');

const sh = (...a) => execFileSync(adb, a, {encoding: 'utf8'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const original = fs.readFileSync(file);

const measure = async marker => {
  sh('shell', 'am', 'force-stop', pkg);
  await sleep(800);
  sh('logcat', '-c');
  sh('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, pkg);
  const deadline = Date.now() + 90_000;
  let log = '';
  while (Date.now() < deadline) {
    await sleep(1000);
    log = sh('logcat', '-d', '-v', 'epoch');
    if (log.includes(marker)) break;
  }
  const lines = log.split('\n');
  const t = re => {
    const l = lines.find(x => re.test(x));
    return l ? parseFloat(l.trim().split(/\s+/)[0]) : NaN;
  };
  const start = t(/ActivityTaskManager: START u0/);
  const main = t(/Running "main"/);
  const mark = t(new RegExp(marker));
  return {runningMainMs: Math.round((main - start) * 1000), markerMs: Math.round((mark - start) * 1000), fresh: !Number.isNaN(mark)};
};

try {
  for (let i = 1; i <= runs; i++) {
    const marker = `PBXMARK${Date.now()}`;
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from(`\nconsole.log('${marker}');\n`)]));
    const tEdit = Date.now();
    await sleep(waitMs);
    const r = await measure(marker);
    console.log(JSON.stringify({run: i, waitMs, editToIntentMs: Date.now() - tEdit - (r.markerMs || 0), ...r}));
  }
} finally {
  fs.writeFileSync(file, original);
}
