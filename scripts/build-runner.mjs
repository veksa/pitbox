// Builds the Android runner and puts the APK where the package ships it (runners/android/pitbox-runner.apk).
// Needs a JDK and the Android SDK; users of the package get the prebuilt APK and need neither.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runners', 'android');
const gradlew = path.join(dir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
execFileSync(gradlew, ['assembleRelease', '-q'], {cwd: dir, stdio: 'inherit', shell: process.platform === 'win32'});
const built = path.join(dir, 'build', 'outputs', 'apk', 'release', 'pitbox-runner-release.apk');
fs.copyFileSync(built, path.join(dir, 'pitbox-runner.apk'));
console.log(`runner: ${path.join(dir, 'pitbox-runner.apk')} (${Math.round(fs.statSync(built).size / 1024)} KB)`);
