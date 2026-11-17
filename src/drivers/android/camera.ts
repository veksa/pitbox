// An Android emulator's back camera: what it shows is chosen when the emulator starts (`-camera-back`). An image or a
// video is shown from a file pitbox owns, so `camera image|video <file>` can put another one in its place while the
// emulator runs; the virtual scene's posters change through the console.

import fs from 'node:fs';
import path from 'node:path';

const MODES = ['emulated', 'virtualscene', 'none'];
const IMAGE = /\.(png|jpe?g)$/i;
const VIDEO = /\.(mp4|webm|mkv|mov|avi|3gp)$/i;

/** The folder of the files emulators show to their cameras. */
export const feedDir = (stateDir: string) => path.join(stateDir, 'camera');

/**
 * The `-camera-back` value for a boot's `camera` option. `image:<file>` and `video:<file>` are copied to a feed file
 * of pitbox's own (one per AVD), which is what the emulator shows.
 */
export const cameraArg = (value: string, o: {root: string; stateDir: string; avd: string}): string => {
  const v = value.trim();
  if (MODES.includes(v) || /^webcam\d+$/.test(v)) return v;
  const m = /^(image|video|imagefile|videofile):(.+)$/.exec(v);
  if (!m) throw new Error(`camera ${v}: emulated, virtualscene, none, webcam0, image:<file> or video:<file>`);
  const kind = m[1]!.startsWith('image') ? 'image' : 'video';
  const src = path.resolve(o.root, m[2]!);
  if (!fs.existsSync(src)) throw new Error(`camera: no file ${src}`);
  if (kind === 'image' && !IMAGE.test(src)) throw new Error(`camera image: ${path.basename(src)} is not a PNG or JPEG`);
  if (kind === 'video' && !VIDEO.test(src)) throw new Error(`camera video: ${path.basename(src)} is not a video (mp4, webm, mkv, mov)`);
  const dir = feedDir(o.stateDir);
  fs.mkdirSync(dir, {recursive: true});
  const feed = path.join(dir, `${o.avd.replace(/[^\w.-]/g, '_')}-feed${path.extname(src).toLowerCase()}`);
  fs.copyFileSync(src, feed);
  return `${kind}file:${feed}`;
};

/** Whether an emulator started with camera `running` already shows what `wanted` asks for (a feed file counts as one). */
export const sameCamera = (running: string | undefined, wanted: string): boolean => {
  if (!running) return false;
  const kind = (v: string) => /^(image|video)(file)?:/.exec(v)?.[1];
  return running === wanted || (!!kind(running) && kind(running) === kind(wanted));
};

/**
 * Puts `file` where the emulator's feed file is, so the camera shows it the next time an app opens the camera.
 * Only for an emulator started with an image or a video of pitbox's (`boot camera=image:<file>`).
 */
export const swapFeed = (running: string | undefined, file: string, kind: 'image' | 'video'): string => {
  const m = running ? /^(image|video)file:(.+)$/.exec(running) : undefined;
  if (!m) throw new Error(`camera ${kind}: this emulator's camera is ${running ?? 'the one its AVD names'}, not a file\nhint: boot it with camera=${kind}:<file> (or android.camera in the config); then camera ${kind} swaps the file while it runs`);
  if (m[1] !== kind) throw new Error(`camera ${kind}: this emulator shows ${m[1] === 'image' ? 'an image' : 'a video'} (it started with camera=${m[1]}:…)\nhint: give it back and boot it again with camera=${kind}:<file>`);
  if (kind === 'image' && !IMAGE.test(file)) throw new Error(`camera image: ${path.basename(file)} is not a PNG or JPEG`);
  if (kind === 'video' && !VIDEO.test(file)) throw new Error(`camera video: ${path.basename(file)} is not a video`);
  const feed = m[2]!;
  if (path.extname(feed).toLowerCase() !== path.extname(file).toLowerCase()) throw new Error(`camera ${kind}: the emulator reads ${path.basename(feed)}; give a ${path.extname(feed)} file (or boot again with this one)`);
  fs.copyFileSync(file, `${feed}.part`);
  fs.renameSync(`${feed}.part`, feed);
  return feed;
};
