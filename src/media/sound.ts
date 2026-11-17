// What `mic` plays, written as words: a file, a tone, noise or silence, parts joined with `+`, noise mixed into a
// file at a signal-to-noise ratio, a level, repeats. Parsed here, rendered to PCM for whichever microphone takes it.

import path from 'node:path';
import {readAudio} from './ffmpeg.ts';
import {concat, convert, fit, gain, mixAtSnr, noise, parseDb, parseHz, parseSecs, seconds, silence, tone, type NoiseColor, type Pcm} from './pcm.ts';

export type SoundPart =
  | {kind: 'file'; file: string; secs?: number}
  | {kind: 'tone'; freq: number; secs: number; level?: number}
  | {kind: 'noise'; color: NoiseColor; secs: number; level?: number}
  | {kind: 'silence'; secs: number};

export type SoundSpec = {
  parts: SoundPart[];
  /** Noise mixed under the whole sound: a colour or a file. */
  noise?: NoiseColor | {file: string};
  /** Signal over noise, dB (with `noise`; default 10). */
  snr?: number;
  /** Gain on the whole sound, dB. */
  gain?: number;
  /** Plays this many times, with `gap` seconds of silence between. */
  repeat?: number;
  gap?: number;
};

export type MicCommand =
  | {op: 'stop'}
  | {op: 'status'}
  | {op: 'wait'}
  | {
      op: 'play';
      spec: SoundSpec;
      /** Answer at once and play on; `mic stop` ends it. */ bg: boolean;
      /** Seconds to wait for the app to start recording. */ wait?: number;
      /** iOS: switch the Mac's input even while another app records from it. */ force?: boolean;
    };

const COLORS = ['white', 'pink', 'brown'];
const isSecs = (t: string) => /^\d+(\.\d+)?(ms|s|m)$/.test(t);
const isDb = (t: string) => /^[-+]\d+(\.\d+)?(db|dbfs)?$/i.test(t) || /^\d+(\.\d+)?(db|dbfs)$/i.test(t);
const isHz = (t: string) => /^\d+(\.\d+)?(k)?(hz)?$/i.test(t) && !isSecs(t);

/** `tone 440 2s -12dB`, `noise pink 2s`, `silence 500ms`, `speech.wav [3s]`. */
export const parsePart = (words: string[]): SoundPart => {
  const [head, ...rest] = words;
  if (!head) throw new Error('mic: nothing to play');
  const secsOf = (fallback?: number) => {
    const t = rest.find(isSecs);
    return t ? parseSecs(t) : fallback;
  };
  const levelOf = () => {
    const t = rest.find(isDb);
    return t ? parseDb(t) : undefined;
  };
  const unknown = (allowed: (t: string) => boolean) => {
    const bad = rest.find(t => !allowed(t));
    if (bad) throw new Error(`mic ${head}: did not understand "${bad}"`);
  };
  if (head === 'tone') {
    unknown(t => isSecs(t) || isDb(t) || isHz(t));
    const hz = rest.find(isHz);
    return {kind: 'tone', freq: hz ? parseHz(hz) : 440, secs: secsOf(1)!, level: levelOf()};
  }
  if (head === 'noise') {
    unknown(t => isSecs(t) || isDb(t) || COLORS.includes(t));
    return {kind: 'noise', color: (rest.find(t => COLORS.includes(t)) as NoiseColor | undefined) ?? 'white', secs: secsOf(1)!, level: levelOf()};
  }
  if (head === 'silence') {
    unknown(isSecs);
    return {kind: 'silence', secs: secsOf(1)!};
  }
  unknown(isSecs);
  return {kind: 'file', file: head, secs: secsOf()};
};

/**
 * A `mic` value: `stop`, `status`, `wait` (until the sound in the background has played), or a sound — parts joined with `+` and options anywhere as `key=value`:
 * `noise=pink|white|brown|<file>` with `snr=<dB>`, `gain=<dB>`, `repeat=<n>`, `gap=<secs>`, `bg` (answer at once),
 * `wait=<secs>` (for the app to start recording), `force` (iOS: switch the Mac's input although another app records
 * from it).
 */
export const parseMic = (value: string): MicCommand => {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && (tokens[0] === 'stop' || tokens[0] === 'status' || tokens[0] === 'wait')) return {op: tokens[0]};
  const spec: SoundSpec = {parts: []};
  let bg = false;
  let force = false;
  let wait: number | undefined;
  const plain: string[] = [];
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (t === 'bg' || t === '&') bg = true;
    else if (t === 'force') force = true;
    else if (eq > 0) {
      const k = t.slice(0, eq);
      const v = t.slice(eq + 1);
      if (k === 'noise') spec.noise = COLORS.includes(v) ? (v as NoiseColor) : {file: v};
      else if (k === 'snr') spec.snr = parseDb(v);
      else if (k === 'gain') spec.gain = parseDb(v);
      else if (k === 'repeat') spec.repeat = Math.max(1, Math.floor(Number(v)) || 1);
      else if (k === 'gap') spec.gap = parseSecs(v);
      else if (k === 'wait') wait = parseSecs(v);
      else if (k === 'bg') bg = v !== 'false';
      else throw new Error(`mic: unknown option ${k} (noise, snr, gain, repeat, gap, wait, bg, force)`);
    } else plain.push(t);
  }
  const groups: string[][] = [[]];
  for (const t of plain) {
    if (t === '+') groups.push([]);
    else groups[groups.length - 1]!.push(t);
  }
  spec.parts = groups.filter(g => g.length).map(parsePart);
  if (!spec.parts.length) throw new Error('mic: nothing to play (a file, tone, noise or silence)');
  if (spec.snr !== undefined && !spec.noise) spec.noise = 'white';
  return {op: 'play', spec, bg, wait, ...(force ? {force} : {})};
};

/** The sound as PCM at `rate` Hz mono: files read (through ffmpeg unless a WAV), parts joined, noise mixed in. */
export const renderSound = async (spec: SoundSpec, o: {rate?: number; root?: string} = {}): Promise<Pcm> => {
  const rate = o.rate ?? 48000;
  const resolve = (f: string) => path.resolve(o.root ?? process.cwd(), f);
  const parts: Pcm[] = [];
  for (const p of spec.parts) {
    if (p.kind === 'tone') parts.push(tone({freq: p.freq, secs: p.secs, rate, level: p.level}));
    else if (p.kind === 'noise') parts.push(noise({secs: p.secs, color: p.color, rate, level: p.level}));
    else if (p.kind === 'silence') parts.push(silence({secs: p.secs, rate}));
    else {
      const pcm = convert(await readAudio(resolve(p.file), {rate, channels: 1}), rate, 1);
      parts.push(p.secs !== undefined ? fit(pcm, p.secs) : pcm);
    }
  }
  let one = concat(parts);
  if (spec.noise) {
    const bed = typeof spec.noise === 'string' ? noise({secs: Math.max(0.1, seconds(one)), color: spec.noise, rate, seed: 7}) : convert(await readAudio(resolve(spec.noise.file), {rate, channels: 1}), rate, 1);
    one = mixAtSnr(one, bed, spec.snr ?? 10);
  }
  if (spec.gain) one = gain(one, spec.gain);
  const times = spec.repeat ?? 1;
  if (times > 1) {
    const gapPcm = silence({secs: spec.gap ?? 0.5, rate});
    one = concat(Array.from({length: times}, (_, i) => (i ? [gapPcm, one] : [one])).flat());
  }
  return one;
};

/** A few words about a sound, for answers: `speech.wav + noise pink, snr 10 dB, ×2`. */
export const describeSound = (spec: SoundSpec): string => {
  const part = (p: SoundPart) =>
    p.kind === 'file' ? path.basename(p.file) : p.kind === 'tone' ? `tone ${p.freq} Hz ${p.secs}s` : p.kind === 'noise' ? `${p.color} noise ${p.secs}s` : `silence ${p.secs}s`;
  const extra = [
    spec.noise ? `${typeof spec.noise === 'string' ? `${spec.noise} noise` : path.basename(spec.noise.file)} at snr ${spec.snr ?? 10} dB` : '',
    spec.gain ? `gain ${spec.gain} dB` : '',
    spec.repeat && spec.repeat > 1 ? `×${spec.repeat}` : '',
  ].filter(Boolean);
  return [spec.parts.map(part).join(' + '), ...extra].join(', ');
};
