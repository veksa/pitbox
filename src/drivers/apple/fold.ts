// The helper that folds a foldable iPhone simulator (runners/apple/Fold): a small Swift tool for the iOS
// simulator, built with swiftc on first use and cached per source hash and Xcode under ~/Library/Caches/pitbox.
// simctl has no hinge; the simulator's motion inputs, which Xcode's device window drives, do.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {run} from '../../util/proc.ts';
import {AppleError} from './driver.ts';
import {runnerSources, sourceHash} from './runner.ts';

let built: Promise<string> | undefined;

/** The helper's path, built if this source and Xcode have none yet. */
export const foldTool = (): Promise<string> => {
  built ??= build().catch(e => {
    built = undefined;
    throw e;
  });
  return built;
};

const build = async (): Promise<string> => {
  const src = path.join(runnerSources(), 'Fold');
  if (!fs.existsSync(path.join(src, 'fold.swift'))) throw new AppleError(`fold helper sources missing: ${src}`);
  const xcode = (await run('xcodebuild', ['-version'], {timeoutMs: 20_000})).stdout.match(/Build version (\S+)/)?.[1] ?? 'unknown';
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'pitbox', 'apple-fold');
  const version = `${sourceHash(src)}-${xcode}`;
  const bin = path.join(cache, version, 'fold');
  if (fs.existsSync(bin)) return bin;
  if (fs.existsSync(cache)) for (const v of fs.readdirSync(cache)) if (v !== version) fs.rmSync(path.join(cache, v), {recursive: true, force: true});
  fs.mkdirSync(path.dirname(bin), {recursive: true});
  // A simulator binary carries its entitlements in a section of its own, not in the signature.
  const swift = await run(
    'xcrun',
    ['-sdk', 'iphonesimulator', 'swiftc', '-O', '-target', `${process.arch === 'x64' ? 'x86_64' : 'arm64'}-apple-ios17.0-simulator`, '-import-objc-header', path.join(src, 'Fold.h'), path.join(src, 'fold.swift'), '-o', bin, '-framework', 'IOKit', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__entitlements', '-Xlinker', path.join(src, 'fold.entitlements')],
    {timeoutMs: 300_000},
  );
  if (swift.code !== 0) throw new AppleError(`fold helper build failed: ${swift.stderr.trim().split('\n').filter(l => /error:/.test(l)).slice(0, 2).join(' ') || swift.stderr.trim().split('\n').pop()}`);
  const sign = await run('codesign', ['-s', '-', '-f', bin], {timeoutMs: 30_000});
  if (sign.code !== 0) throw new AppleError(`fold helper signing failed: ${sign.stderr.trim()}`);
  return bin;
};
