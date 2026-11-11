// Shared build caches: GC leaves versions that are in use, being built or recent alone, and one build of a version
// runs at a time. Everything runs in temporary folders: no real cache of this machine is read or touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {builder, gcVersions, markInUse, usersOf, withBuildLock} from './util/cache.ts';

/** A pid that runs nothing: far above any real one. */
const DEAD_PID = 2 ** 22 - 3;

describe('shared caches', () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-cache-'));
  afterAll(() => fs.rmSync(cacheRoot, {recursive: true, force: true}));

  const version = (cache: string, name: string, daysAgo: number) => {
    const dir = path.join(cache, name);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'payload'), 'x');
    const t = new Date(Date.now() - daysAgo * 86_400_000);
    fs.writeFileSync(path.join(dir, '.last-used'), '');
    fs.utimesSync(path.join(dir, '.last-used'), t, t);
    return dir;
  };

  it('removes only old versions nobody uses, keeping the newest few', () => {
    const cache = fs.mkdtempSync(path.join(cacheRoot, 'gc-'));
    version(cache, 'current', 0);
    version(cache, 'recent', 1);
    version(cache, 'kept-newest', 20);
    version(cache, 'old', 30);
    version(cache, 'older', 40);
    const inUse = version(cache, 'old-but-used', 50);
    fs.writeFileSync(path.join(inUse, `.in-use-${process.pid}`), '');
    const deadUser = version(cache, 'old-dead-user', 60);
    fs.writeFileSync(path.join(deadUser, `.in-use-${DEAD_PID}`), '');
    const removed = gcVersions(cache, 'current', {keep: 3});
    expect(removed.sort()).toEqual(['old', 'old-dead-user', 'older']);
    expect(fs.readdirSync(cache).sort()).toEqual(['current', 'kept-newest', 'old-but-used', 'recent']);
  });

  it('never removes a version another process is building', () => {
    const cache = fs.mkdtempSync(path.join(cacheRoot, 'gc-'));
    version(cache, 'current', 0);
    version(cache, 'building', 90);
    fs.writeFileSync(path.join(cache, 'building.lock'), String(process.pid));
    expect(gcVersions(cache, 'current', {keep: 1})).toEqual([]);
    expect(builder(cache, 'building')).toBe(process.pid);
  });

  it('marks a version in use for this process', () => {
    const cache = fs.mkdtempSync(path.join(cacheRoot, 'mark-'));
    const dir = path.join(cache, 'v1');
    markInUse(dir);
    expect(usersOf(dir)).toEqual([process.pid]);
    expect(usersOf(dir, () => false)).toEqual([]);
  });

  it('lets one build run at a time and the second find it done', async () => {
    const cache = fs.mkdtempSync(path.join(cacheRoot, 'lock-'));
    const events: string[] = [];
    let built = false;
    const build = (who: string) =>
      withBuildLock(cache, 'v1', async () => {
        events.push(`${who} in`);
        if (!built) {
          await new Promise(r => setTimeout(r, 150));
          built = true;
          events.push(`${who} built`);
        }
        events.push(`${who} out`);
        return built;
      }, {pollMs: 20});
    await Promise.all([build('a'), new Promise(r => setTimeout(r, 20)).then(() => build('b'))]);
    expect(events).toEqual(['a in', 'a built', 'a out', 'b in', 'b out']);
    expect(fs.existsSync(path.join(cache, 'v1.lock'))).toBe(false);
  });

  it('takes over the build lock of a builder that died', async () => {
    const cache = fs.mkdtempSync(path.join(cacheRoot, 'lock-'));
    fs.writeFileSync(path.join(cache, 'v1.lock'), String(DEAD_PID));
    expect(await withBuildLock(cache, 'v1', async () => 'ran', {pollMs: 20, waitMs: 2000})).toBe('ran');
  });
});
