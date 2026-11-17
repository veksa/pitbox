import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {cameraArg, sameCamera, swapFeed} from './drivers/android/camera.ts';
import {bootArgs, launchedWith} from './drivers/android/driver.ts';
import {parseArgs, toCall} from './cli.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-camera-'));

describe('emulator camera', () => {
  it('passes modes as they are and copies an image or a video to a feed file of its own', () => {
    const root = tmp();
    const stateDir = path.join(root, '.pitbox');
    fs.writeFileSync(path.join(root, 'card.png'), 'png');
    expect(cameraArg('virtualscene', {root, stateDir, avd: 'Pixel'})).toBe('virtualscene');
    expect(cameraArg('webcam0', {root, stateDir, avd: 'Pixel'})).toBe('webcam0');
    const arg = cameraArg('image:card.png', {root, stateDir, avd: 'Pixel 8'});
    expect(arg).toBe(`imagefile:${path.join(stateDir, 'camera', 'Pixel_8-feed.png')}`);
    expect(fs.readFileSync(arg.slice('imagefile:'.length), 'utf8')).toBe('png');
    expect(() => cameraArg('image:missing.png', {root, stateDir, avd: 'P'})).toThrow(/no file/);
    expect(() => cameraArg('video:card.png', {root, stateDir, avd: 'P'})).toThrow(/not a video/);
    expect(() => cameraArg('front', {root, stateDir, avd: 'P'})).toThrow(/emulated, virtualscene/);
  });

  it('boots with -camera-back and reads it back from the command line', () => {
    expect(bootArgs('Pixel', {audio: true, camera: 'imagefile:/f.png'}, false)).toEqual(['-avd', 'Pixel', '-no-boot-anim', '-no-snapshot', '-camera-back', 'imagefile:/f.png']);
    expect(launchedWith('"/qemu" "-avd" "P" "-camera-back" "videofile:/a b.mp4"')).toEqual({audio: true, camera: 'videofile:/a b.mp4'});
    expect(launchedWith('"/qemu" "-avd" "P" "-no-audio"')).toEqual({audio: false});
    expect(sameCamera('imagefile:/x.png', 'imagefile:/y.png')).toBe(true);
    expect(sameCamera('emulated', 'imagefile:/y.png')).toBe(false);
    expect(sameCamera(undefined, 'emulated')).toBe(false);
  });

  it('swaps the feed file only for an emulator started with one of the same kind and type', () => {
    const dir = tmp();
    const feed = path.join(dir, 'P-feed.png');
    fs.writeFileSync(feed, 'old');
    fs.writeFileSync(path.join(dir, 'new.png'), 'new');
    expect(swapFeed(`imagefile:${feed}`, path.join(dir, 'new.png'), 'image')).toBe(feed);
    expect(fs.readFileSync(feed, 'utf8')).toBe('new');
    expect(() => swapFeed('emulated', path.join(dir, 'new.png'), 'image')).toThrow(/boot it with camera=image/);
    expect(() => swapFeed(`imagefile:${feed}`, path.join(dir, 'x.mp4'), 'video')).toThrow(/shows an image/);
    expect(() => swapFeed(`imagefile:${feed}`, path.join(dir, 'x.jpg'), 'image')).toThrow(/give a \.png file/);
  });

  it('takes the camera on boot from the command line', () => {
    expect(toCall(parseArgs(['boot', 'Pixel', '--camera', 'image:card.png']))).toMatchObject({method: 'boot', params: {avd: 'Pixel', camera: 'image:card.png'}});
  });
});
