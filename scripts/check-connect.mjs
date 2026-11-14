// Builds the Android connect library in both variants and checks what an app's build of each would take in:
// the release AAR declares no component, carries no class but the empty package class and no consumer rules; the
// debug AAR has the provider, the connect activity and the push receiver. `yarn check-connect`; CI runs it too.
// Needs a JDK and the Android SDK, and `unzip`.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const gradlew = path.join(root, 'runners', 'android', win ? 'gradlew.bat' : 'gradlew');
execFileSync(gradlew, ['-p', path.join(root, 'android', 'standalone'), ':connect:assembleRelease', ':connect:assembleDebug', '-q'], {cwd: root, stdio: 'inherit', shell: win});

const aar = variant => path.join(root, 'android', 'build', 'outputs', 'aar', `connect-${variant}.aar`);
const unzip = (...args) => execFileSync('unzip', args, {encoding: 'utf8', maxBuffer: 16 << 20});
const entries = file => unzip('-Z1', file).split('\n').filter(Boolean);
/** The classes in an AAR's classes.jar, unpacked next to the build outputs (android/build is ignored). */
const classes = (file, variant) => {
  const jar = path.join(root, 'android', 'build', `connect-${variant}-classes.jar`);
  fs.writeFileSync(jar, execFileSync('unzip', ['-p', file, 'classes.jar'], {maxBuffer: 16 << 20}));
  return entries(jar).filter(e => e.endsWith('.class'));
};

const COMPONENTS = ['PitboxConnectProvider', 'PitboxConnectActivity', 'PitboxPushReceiver'];
const problems = [];

const release = aar('release');
const releaseManifest = unzip('-p', release, 'AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
if (/<(application|provider|activity|activity-alias|receiver|service|uses-permission|permission|queries)\b/.test(releaseManifest)) {
  problems.push('the release AAR manifest declares a component, a permission or queries');
}
if (entries(release).includes('proguard.txt')) problems.push('the release AAR carries consumer ProGuard rules');
const releaseClasses = classes(release, 'release');
if (releaseClasses.join(',') !== 'dev/pitbox/connect/PitboxPackage.class') {
  problems.push(`the release AAR carries classes besides the package class: ${releaseClasses.join(', ')}`);
}

const debug = aar('debug');
const debugManifest = unzip('-p', debug, 'AndroidManifest.xml');
for (const name of COMPONENTS) {
  if (!debugManifest.includes(`dev.pitbox.connect.${name}`)) problems.push(`the debug AAR manifest lacks ${name}`);
}

if (problems.length) {
  console.error(`check-connect: ${problems.join('; ')}`);
  process.exit(1);
}
console.log(`check-connect: release AAR holds only ${releaseClasses[0]}, no component, no rules; debug AAR has ${COMPONENTS.join(', ')}`);
