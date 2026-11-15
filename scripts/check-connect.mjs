// Builds the Android connect library in both variants and checks what an app's build of each would take in:
// the release AAR declares no component, carries no class but the empty package class and no consumer rules; the
// debug AAR has the provider, the connect activity, the push receiver and the Wear OS relay (its receiver and
// PitboxWearable), and the release AAR none of the relay. `yarn check-connect`; CI runs it too.
// Needs a JDK and the Android SDK, and `unzip`.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const gradlew = path.join(root, 'runners', 'android', win ? 'gradlew.bat' : 'gradlew');
execFileSync(gradlew, ['-p', path.join(root, 'android', 'standalone'), ':connect:assembleRelease', ':connect:assembleDebug', ':connect:generatePomFileForConnectPublication', '-q'], {cwd: root, stdio: 'inherit', shell: win});

const aar = variant => path.join(root, 'android', 'build', 'outputs', 'aar', `connect-${variant}.aar`);
const unzip = (...args) => execFileSync('unzip', args, {encoding: 'utf8', maxBuffer: 16 << 20});
const entries = file => unzip('-Z1', file).split('\n').filter(Boolean);
/** The classes in an AAR's classes.jar, unpacked next to the build outputs (android/build is ignored). */
const classes = (file, variant) => {
  const jar = path.join(root, 'android', 'build', `connect-${variant}-classes.jar`);
  fs.writeFileSync(jar, execFileSync('unzip', ['-p', file, 'classes.jar'], {maxBuffer: 16 << 20}));
  return entries(jar).filter(e => e.endsWith('.class'));
};

const COMPONENTS = ['PitboxConnectProvider', 'PitboxConnectActivity', 'PitboxPushReceiver', 'PitboxWearReceiver'];
/** The Wear OS relay: what pairs two emulators' Data Layer through pitbox. A release build must carry none of it. */
const RELAY = /PitboxWear|PitboxNode|PitboxCapability|PitboxMessageEvent/;
const problems = [];

const release = aar('release');
const releaseManifest = unzip('-p', release, 'AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
if (/<(application|provider|activity|activity-alias|receiver|service|uses-permission|permission|queries)\b/.test(releaseManifest)) {
  problems.push('the release AAR manifest declares a component, a permission or queries');
}
if (entries(release).includes('proguard.txt')) problems.push('the release AAR carries consumer ProGuard rules');
const releaseClasses = classes(release, 'release');
const relayInRelease = releaseClasses.filter(c => RELAY.test(c));
if (relayInRelease.length || RELAY.test(releaseManifest)) problems.push(`the release AAR carries the Wear OS relay: ${relayInRelease.join(', ') || 'in its manifest'}`);
if (releaseClasses.join(',') !== 'dev/pitbox/connect/PitboxPackage.class') {
  problems.push(`the release AAR carries classes besides the package class: ${releaseClasses.join(', ')}`);
}

const debug = aar('debug');
const debugManifest = unzip('-p', debug, 'AndroidManifest.xml');
for (const name of COMPONENTS) {
  if (!debugManifest.includes(`dev.pitbox.connect.${name}`)) problems.push(`the debug AAR manifest lacks ${name}`);
}
const debugClasses = classes(debug, 'debug');
for (const name of ['PitboxWearable', 'PitboxWearReceiver']) {
  if (!debugClasses.includes(`dev/pitbox/connect/${name}.class`)) problems.push(`the debug AAR lacks ${name}`);
}

// The Maven artifact: an app on Kotlin 2.1 must be able to read it — the stdlib its POM declares and the metadata of
// its classes are of Kotlin 2.1 at most, whatever compiler built it.
const KOTLIN_MAX = [2, 1];
const newer = v => v[0] > KOTLIN_MAX[0] || (v[0] === KOTLIN_MAX[0] && v[1] > KOTLIN_MAX[1]);
const pom = fs.readFileSync(path.join(root, 'android', 'build', 'publications', 'connect', 'pom-default.xml'), 'utf8');
for (const m of pom.matchAll(/<artifactId>(kotlin-stdlib[\w-]*)<\/artifactId>\s*<version>([\d.]+)<\/version>/g)) {
  if (newer(m[2].split('.').map(Number))) problems.push(`the published POM declares ${m[1]} ${m[2]}, newer than Kotlin ${KOTLIN_MAX.join('.')}`);
}
const javap = path.join(process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : '', win ? 'javap.exe' : 'javap');
const metadata = execFileSync(javap, ['-v', '-cp', path.join(root, 'android', 'build', 'connect-debug-classes.jar'), 'dev.pitbox.connect.PitboxWearable'], {encoding: 'utf8', maxBuffer: 16 << 20});
const mv = /mv=\[(\d+),(\d+)/.exec(metadata.replace(/\s/g, ''));
if (!mv) problems.push('could not read the Kotlin metadata version of PitboxWearable');
else if (newer([Number(mv[1]), Number(mv[2])])) problems.push(`the debug AAR's classes carry Kotlin metadata ${mv[1]}.${mv[2]}, newer than ${KOTLIN_MAX.join('.')}`);

if (problems.length) {
  console.error(`check-connect: ${problems.join('; ')}`);
  process.exit(1);
}
console.log(`check-connect: release AAR holds only ${releaseClasses[0]}, no component, no rules, no Wear relay; debug AAR has ${COMPONENTS.join(', ')} and PitboxWearable; Kotlin ${KOTLIN_MAX.join('.')} metadata and stdlib`);
