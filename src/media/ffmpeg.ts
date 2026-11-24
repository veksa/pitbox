// ffmpeg, when the machine has it: any audio or video file into the PCM the microphone takes, frames out of a
// recording, and a screen recording joined with the audio captured beside it. pitbox does not ship ffmpeg; what
// needs it says so, and a PCM WAV needs nothing.

import fs from 'node:fs';
import path from 'node:path';
import {run, which} from '../util/proc.ts';
import {decodeWav, type Pcm} from './pcm.ts';

export const ffmpegPath = (): string | undefined => {
  const own = process.env.PITBOX_FFMPEG;
  if (own && fs.existsSync(own)) return own;
  return which('ffmpeg') ?? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(p => fs.existsSync(p));
};

export const NO_FFMPEG = 'install ffmpeg (brew install ffmpeg, apt install ffmpeg, winget install ffmpeg) or set PITBOX_FFMPEG; a 16-bit PCM WAV needs no ffmpeg';

const need = (what: string): string => {
  const f = ffmpegPath();
  if (!f) throw new Error(`${what} needs ffmpeg\nhint: ${NO_FFMPEG}`);
  return f;
};

const ffmpeg = async (args: string[], what: string, opts: {timeoutMs?: number; buffer?: boolean} = {}) => {
  const r = await run(need(what), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {timeoutMs: opts.timeoutMs ?? 120_000, ...(opts.buffer ? {encoding: 'buffer' as const} : {})});
  if (r.code !== 0) throw new Error(`${what}: ffmpeg failed: ${r.stderr.trim().split('\n').slice(-2).join(' ') || `exit ${r.code}`}`);
  return r;
};

/** The arguments that decode `file` to raw signed 16-bit PCM on stdout at `rate` Hz with `channels` channels. */
export const decodeArgs = (file: string, rate: number, channels: number): string[] => ['-i', file, '-vn', '-ac', String(channels), '-ar', String(rate), '-f', 's16le', '-acodec', 'pcm_s16le', '-'];

/** A file the decoder reads as is: a WAV pcm.ts understands. Anything else goes through ffmpeg. */
export const readAudio = async (file: string, want: {rate: number; channels: number}): Promise<Pcm> => {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    try {
      return decodeWav(buf);
    } catch {
      // an exotic WAV (ADPCM, µ-law): ffmpeg below
    }
  }
  const r = await ffmpeg(decodeArgs(file, want.rate, want.channels), `reading ${path.basename(file)}`, {buffer: true});
  const b = r.buffer ?? Buffer.alloc(0);
  const n = Math.floor(b.length / 2);
  const data = new Float32Array(n - (n % want.channels));
  for (let i = 0; i < data.length; i++) data[i] = b.readInt16LE(i * 2) / 32768;
  return {rate: want.rate, channels: want.channels, data};
};

/**
 * The arguments that take frames out of a video into `outDir` as JPEGs: one every `every` seconds, or `count` spread
 * over its length (needs `duration`), at most `width` pixels wide.
 */
export const framesArgs = (video: string, outDir: string, o: {every?: number; count?: number; duration?: number; width?: number}): string[] => {
  const rate = o.count && o.duration ? o.count / o.duration : 1 / (o.every ?? 1);
  const filters = [`fps=${Number(rate.toFixed(4))}`, `scale='min(${o.width ?? 540},iw)':-2`, 'format=yuvj420p'];
  return ['-i', video, '-vf', filters.join(','), ...(o.count ? ['-frames:v', String(o.count)] : []), '-q:v', '4', path.join(outDir, 'frame-%03d.jpg')];
};

export const extractFrames = async (video: string, outDir: string, o: {every?: number; count?: number; width?: number}): Promise<string[]> => {
  fs.mkdirSync(outDir, {recursive: true});
  const duration = o.count ? await probeDuration(video) : undefined;
  const list = () => fs.readdirSync(outDir).filter(f => /^frame-\d+\.jpg$/.test(f)).sort().map(f => path.join(outDir, f));
  // A recording of a screen that stood still can hold a single frame (the simulator writes frames only on change):
  // the rate filter then gives nothing, and the one frame there is comes out alone.
  const r = await ffmpeg(['-y', ...framesArgs(video, outDir, {...o, duration})], 'frames').catch((e: Error) => e);
  if (list().length) return list();
  await ffmpeg(['-y', '-i', video, '-vf', `scale='min(${o.width ?? 540},iw)':-2`, '-frames:v', '1', '-q:v', '4', path.join(outDir, 'frame-001.jpg')], 'frames');
  if (!list().length && r instanceof Error) throw r;
  return list();
};

/** Seconds of a media file, from ffmpeg's own reading of it (no ffprobe needed). */
export const probeDuration = async (file: string): Promise<number | undefined> => {
  const r = await run(need('reading a duration'), ['-hide_banner', '-nostdin', '-i', file], {timeoutMs: 30_000});
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
};

/** The arguments that join a silent video with an audio file (the audio starting `offset` seconds into the video). */
export const muxArgs = (video: string, audio: string, out: string, offset = 0): string[] => [
  '-y',
  '-i',
  video,
  ...(offset > 0 ? ['-itsoffset', offset.toFixed(3)] : []),
  '-i',
  audio,
  '-map',
  '0:v:0',
  '-map',
  '1:a:0',
  '-c:v',
  'copy',
  '-c:a',
  'aac',
  '-shortest',
  out,
];

export const mux = async (video: string, audio: string, out: string, offset = 0) => {
  await ffmpeg(muxArgs(video, audio, out, offset), 'joining video and audio');
  return out;
};

/**
 * The arguments that re-encode a recording: at most `fps` frames a second and `size` (WxH, or a width), as H.264 in
 * an MP4 a browser plays.
 */
export const reencodeArgs = (input: string, out: string, o: {fps?: number; size?: string}): string[] => {
  const filters: string[] = [];
  if (o.fps) filters.push(`fps=${o.fps}`);
  if (o.size) {
    const [w, h] = o.size.split('x');
    filters.push(h ? `scale=${w}:${h}` : `scale=${w}:-2`);
  }
  return ['-y', '-i', input, ...(filters.length ? ['-vf', filters.join(',')] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'copy', out];
};

/**
 * A concat list of stills, each shown until the next was taken (the last for as long as its own grab took), so a
 * video made of screenshots grabbed at an uneven pace keeps the screen's own timing.
 */
export const frameList = (frames: readonly {file: string; at: number}[], end: number): string => {
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.at ?? Math.max(end, f.at + 1);
    lines.push(`file '${f.file.replace(/'/g, "'\\''")}'`, `duration ${Math.max(0.001, (next - f.at) / 1000).toFixed(3)}`);
  });
  // The concat demuxer drops the last entry's duration unless the file comes once more.
  if (frames.length) lines.push(`file '${frames[frames.length - 1]!.file.replace(/'/g, "'\\''")}'`);
  return lines.join('\n') + '\n';
};

/** The arguments that make an H.264 MP4 at `fps` from a concat list of stills (sides made even, as yuv420p needs). */
export const stillsArgs = (list: string, out: string, o: {fps?: number; size?: string} = {}): string[] => {
  const [w, h] = (o.size ?? '').split('x');
  const scale = o.size ? (h ? `scale=${w}:${h}` : `scale=${w}:-2`) : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  return ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${o.fps ?? 10},${scale}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', out];
};

export const stillsToVideo = async (frames: readonly {file: string; at: number}[], end: number, out: string, o: {fps?: number; size?: string} = {}) => {
  const list = path.join(path.dirname(frames[0]!.file), 'frames.txt');
  fs.writeFileSync(list, frameList(frames, end));
  await ffmpeg(stillsArgs(list, out, o), 'making the video', {timeoutMs: 600_000});
  return out;
};

export const reencode = async (input: string, out: string, o: {fps?: number; size?: string}) => {
  await ffmpeg(reencodeArgs(input, out, o), 'resizing the recording', {timeoutMs: 600_000});
  return out;
};

/** The audio track of a recording as PCM (for checks on what a screen recording heard). */
export const audioOf = async (file: string, rate = 16000): Promise<Pcm | undefined> => {
  try {
    return await readAudio(file, {rate, channels: 1});
  } catch (e) {
    if (/does not contain any stream|Output file .*does not contain|matches no streams/i.test((e as Error).message)) return undefined;
    throw e;
  }
};
