// The helper that tells which Mac processes record from an input device (runners/apple/Audio): how `mic` on iOS
// knows that a simulator's app has started recording before it plays. A small Swift tool for the Mac, built with
// swiftc on first use and cached per source hash and Xcode under ~/Library/Caches/pitbox, like the keyboard helper.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gcVersions, markInUse, withBuildLock} from '../../util/cache.ts';
import {run} from '../../util/proc.ts';
import {parseRecorders, type Recorder} from '../../media/loopback.ts';
import {AppleError} from './driver.ts';
import {runnerSources, sourceHash} from './runner.ts';

let built: Promise<string> | undefined;

/** The helper's path, built if this source and Xcode have none yet. */
export const audioTool = (): Promise<string> => {
  built ??= build().catch(e => {
    built = undefined;
    throw e;
  });
  return built;
};

const build = async (): Promise<string> => {
  const src = path.join(runnerSources(), 'Audio');
  if (!fs.existsSync(path.join(src, 'audio.swift'))) throw new AppleError(`audio helper sources missing: ${src}`);
  const xcode = (await run('xcodebuild', ['-version'], {timeoutMs: 20_000})).stdout.match(/Build version (\S+)/)?.[1] ?? 'unknown';
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'pitbox', 'apple-audio');
  const version = `${sourceHash(src)}-${xcode}`;
  const bin = path.join(cache, version, 'audio');
  markInUse(path.dirname(bin));
  gcVersions(cache, version);
  return withBuildLock(cache, version, async () => (fs.existsSync(bin) ? bin : compile(src, bin)));
};

const compile = async (src: string, bin: string): Promise<string> => {
  const partial = `${bin}.partial`;
  const swift = await run('xcrun', ['-sdk', 'macosx', 'swiftc', '-O', path.join(src, 'audio.swift'), '-o', partial], {timeoutMs: 300_000});
  if (swift.code !== 0) throw new AppleError(`audio helper build failed: ${swift.stderr.trim().split('\n').filter(l => /error:/.test(l)).slice(0, 2).join(' ') || swift.stderr.trim().split('\n').pop()}`);
  fs.renameSync(partial, bin);
  return bin;
};

/** The Mac processes recording now, each with its executable's path (`command`). */
export const macRecorders = async (): Promise<(Recorder & {command: string})[]> => {
  const r = await run(await audioTool(), ['recorders'], {timeoutMs: 10_000});
  if (r.code !== 0) throw new AppleError(`audio helper: ${r.stderr.trim() || `exit ${r.code}`}`);
  const list = parseRecorders(r.stdout);
  if (!list.length) return [];
  const ps = await run('ps', ['-o', 'pid=,comm=', '-p', list.map(x => x.pid).join(',')], {timeoutMs: 10_000});
  const commands = new Map(
    ps.stdout
      .split('\n')
      .map(l => /^\s*(\d+)\s+(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map(m => [Number(m[1]), m[2]!]),
  );
  return list.map(x => ({...x, command: commands.get(x.pid) ?? ''}));
};
