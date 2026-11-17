// Speech into an Android emulator's microphone: a WAV file streamed through the emulator's gRPC `injectAudio`, at
// the pace it plays, so an app that records hears it as if spoken. The emulator must run with audio (`boot --audio`):
// one started with -no-audio has no microphone to feed (some versions crash on the call).

import {AndroidError} from './driver.ts';
import {call, findEndpoint, type EmulatorEndpoint} from './emulatorGrpc.ts';

export type Wav = {rate: number; channels: 1 | 2; bits: 8 | 16; pcm: Buffer};

/** Reads a PCM WAV: 8 or 16 bits, mono or stereo, at most 48 kHz (what the emulator's microphone takes). */
export const parseWav = (b: Buffer): Wav => {
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new AndroidError('mic: not a WAV file', 'a PCM .wav, 16-bit mono at 16 kHz for example');
  let fmt: {format: number; channels: number; rate: number; bits: number} | undefined;
  let pcm: Buffer | undefined;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = b.subarray(at + 8, Math.min(b.length, at + 8 + size));
    if (id === 'fmt ' && body.length >= 16) fmt = {format: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14)};
    if (id === 'data') pcm = body;
    at += 8 + size + (size % 2);
  }
  if (!fmt || !pcm) throw new AndroidError('mic: the WAV has no fmt or data chunk');
  // 1 PCM, 0xFFFE extensible (PCM inside, for these bit depths).
  if ((fmt.format !== 1 && fmt.format !== 0xfffe) || (fmt.bits !== 8 && fmt.bits !== 16) || (fmt.channels !== 1 && fmt.channels !== 2) || fmt.rate < 1 || fmt.rate > 48_000)
    throw new AndroidError(`mic: ${fmt.bits}-bit, ${fmt.channels}-channel, ${fmt.rate} Hz is not what the emulator takes`, 'PCM, 8 or 16 bits, mono or stereo, up to 48 kHz: ffmpeg -i in.m4a -ac 1 -ar 16000 -sample_fmt s16 out.wav');
  return {rate: fmt.rate, channels: fmt.channels as 1 | 2, bits: fmt.bits as 8 | 16, pcm};
};

const varint = (n: number) => {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Buffer.from(out);
};
const field = (n: number, wire: number) => varint((n << 3) | wire);
const num = (n: number, v: number) => (v ? Buffer.concat([field(n, 0), varint(v)]) : Buffer.alloc(0));
const bytes = (n: number, v: Buffer) => Buffer.concat([field(n, 2), varint(v.length), v]);

/**
 * An AudioPacket: AudioFormat {samplingRate, channels (0 mono, 1 stereo), format (0 u8, 1 s16), mode 1 real time}, the
 * capture time in microseconds and the samples.
 */
export const audioPacket = (w: Pick<Wav, 'rate' | 'channels' | 'bits'>, audio: Buffer, timestampUs: number): Buffer =>
  Buffer.concat([bytes(1, Buffer.concat([num(1, w.rate), num(2, w.channels - 1), num(3, w.bits === 16 ? 1 : 0), num(4, 1)])), num(2, timestampUs), bytes(3, audio)]);

/** The samples in packets of `ms` each, every one a whole number of frames. */
export const chunks = (w: Wav, ms = 100): Buffer[] => {
  const frame = w.channels * (w.bits / 8);
  const size = Math.max(frame, Math.round((w.rate * ms) / 1000) * frame);
  const out: Buffer[] = [];
  for (let at = 0; at < w.pcm.length; at += size) out.push(w.pcm.subarray(at, at + size));
  return out;
};

/** The emulator's control endpoint for an `emulator-<port>` serial. */
export const endpointOf = (serial: string): EmulatorEndpoint => {
  const port = Number(/^emulator-(\d+)$/.exec(serial)?.[1]);
  if (!port) throw new AndroidError(`mic: ${serial} is not an emulator`, 'a phone takes no injected audio: play the file near its microphone');
  const ep = findEndpoint(port);
  if (!ep) throw new AndroidError(`mic: no gRPC endpoint for ${serial}`, 'recent emulators open one by default; boot it again with pitbox');
  return ep;
};

/**
 * The apps recording from the microphone now, by package, from the RecordActivityMonitor part of `dumpsys audio`
 * (`riid 87; active? true` and its `session:… -- pack:<package>` line).
 */
export const activeRecorders = (dumpsys: string): string[] => {
  const start = dumpsys.indexOf('RecordActivityMonitor');
  if (start < 0) return [];
  const end = dumpsys.indexOf('Events log', start);
  const lines = dumpsys.slice(start, end < 0 ? undefined : end).split(/\r?\n/);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (!/active\? true/.test(l)) return;
    out.push(/pack:([\w.]+)/.exec(lines[i + 1] ?? '')?.[1] ?? '?');
  });
  return out;
};

/**
 * The packets in runs of `per` (2 s of 100 ms packets). `injectWav` plays the whole file as one run: emulator 37.4
 * passes the first injectAudio call on and then fails every capture read (`pcm_readi ... I/O error`) once a second
 * call starts, and 37.2 hears nothing either way.
 */
export const segments = <T>(parts: T[], per = 20): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < parts.length; at += per) out.push(parts.slice(at, at + per));
  return out;
};

/**
 * Plays a WAV into the microphone of emulator `serial`, paced in real time (100 ms packets) in one injectAudio call,
 * and returns when it has played or `signal` stopped it. What the app does not record while it plays is lost, as with a person speaking.
 *
 * Emulator 37.2 ends its own process when audio is injected while no app records (a null audio forwarder): callers
 * wait for a recording first (`activeRecorders`), and `listening` is asked before every further call. A recording
 * that stops while a call plays on is safe.
 */
export const injectWav = async (
  serial: string,
  wav: Buffer,
  opts: {signal?: AbortSignal; /** Asked before each call: false ends the sound there (no app records any more). */ listening?: () => Promise<boolean>} = {},
): Promise<{seconds: number; ms: number; grpc: number; stopped?: boolean; unheard?: boolean}> => {
  const w = parseWav(wav);
  const ep = endpointOf(serial);
  const parts = chunks(w);
  const seconds = w.pcm.length / (w.rate * w.channels * (w.bits / 8));
  const t0 = Date.now();
  let sent = 0;
  async function* paced(from: number, run: Buffer[]) {
    for (let i = 0; i < run.length; i++) {
      const k = from + i;
      const wait = t0 + k * 100 - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      if (opts.signal?.aborted) return;
      yield audioPacket(w, run[i]!, Date.now() * 1000);
      sent = k + 1;
    }
  }
  let from = 0;
  let unheard = false;
  for (const run of segments(parts, Math.max(1, parts.length))) {
    if (opts.signal?.aborted) break;
    // A new call while nothing records would end the emulator (see above).
    if (from > 0 && opts.listening && !(await opts.listening())) {
      unheard = true;
      break;
    }
    await call(ep, 'injectAudio', paced(from, run), run.length * 100 + 15_000);
    from += run.length;
  }
  const stopped = sent < parts.length;
  return {seconds: Math.round((stopped ? (sent * 100) / 1000 : seconds) * 10) / 10, ms: Date.now() - t0, grpc: ep.port, ...(stopped ? {stopped} : {}), ...(unheard ? {unheard} : {})};
};
