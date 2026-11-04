// Cuts a release: `yarn release 0.2.0`. Sets the version in package.json (the podspec reads it from there),
// commits it, tags it and pushes both; the tag's workflow publishes npm and warms JitPack, and the tag itself
// is the Swift package's version. Runs from a clean, up-to-date main after the checks pass.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, {cwd: root, encoding: 'utf8', shell: process.platform === 'win32', ...opts});
const fail = msg => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const version = process.argv[2];
// Plain semver, no `v`: SwiftPM, CocoaPods and JitPack read the tag as the version.
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail('usage: yarn release <major.minor.patch[-pre]>');

if (sh('git', ['branch', '--show-current']).trim() !== 'main') fail('not on main');
if (sh('git', ['status', '--porcelain']).trim()) fail('the working tree has changes');
sh('git', ['fetch', '--quiet', '--tags', 'origin']);
if (sh('git', ['rev-parse', 'HEAD']).trim() !== sh('git', ['rev-parse', 'origin/main']).trim()) fail('main differs from origin/main');
if (sh('git', ['tag', '--list', version]).trim()) fail(`tag ${version} exists`);

const file = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
if (pkg.version === version) fail(`package.json is already at ${version}`);

sh('yarn', ['check-all'], {stdio: 'inherit'});

pkg.version = version;
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
sh('git', ['commit', '--quiet', '-m', `chore(release): ${version}`, 'package.json'], {stdio: 'inherit'});
sh('git', ['tag', '-s', version, '-m', version], {stdio: 'inherit'});
sh('git', ['push', '--quiet', '--atomic', 'origin', 'main', version], {stdio: 'inherit'});
console.log(`release: ${version} tagged and pushed; the release workflow publishes it`);
