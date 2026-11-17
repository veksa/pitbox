// What an Android emulator plays, captured on the host: the emulator's gRPC `streamAudio` sends the device's
// output mix in packets of 20–30 ms while something sounds, and nothing while it is quiet. The packets are laid on
// a timeline by their timestamps, the quiet stretches filled with silence, so the file lasts as long as the capture
// ran and a sound lands where it played.

import http2 from 'node:http2';
import {AndroidError} from './driver.ts';
import {endpointOf} from './mic.ts';
import type {EmulatorEndpoint} from './emulatorGrpc.ts';
import type {Pcm} from '../../media/pcm.ts';

const SERVICE = 'android.emulation.control.EmulatorController';

// ---- protobuf --------------------------------------------------------------------------------------------------

/** A varint as a plain number: timestamps in microseconds pass 2^32, so no bit operators past the first bytes. */
const readVarint = (b: Buffer, at: number): [number, number] => {
  let v = 0;
  let mul = 1;
  for (;;) {
    const byte = b[at++];
    if (byte === undefined) throw new Error('truncated varint');
    v += (byte & 0x7f) * mul;
    if (!(byte & 0x80)) return [v, at];
    mul *= 128;
  }
};

export type AudioFormat = {rate: number; channels: 1 | 2; bits: 8 | 16};
export type AudioPacket = {format?: AudioFormat; timestamp: number; audio: Buffer};

const decodeFormat = (b: Buffer): AudioFormat => {
  const f: AudioFormat = {rate: 44100, channels: 1, bits: 8};
  for (let at = 0; at < b.length; ) {
    const [key, next] = readVarint(b, at);
    at = next;
    if ((key & 7) !== 0) break;
    const [v, after] = readVarint(b, at);
    at = after;
    const field = key >>> 3;
    if (field === 1) f.rate = v || 44100;
    if (field === 2) f.channels = v === 1 ? 2 : 1;
    if (field === 3) f.bits = v === 1 ? 16 : 8;
  }
  return f;
};

/** An AudioPacket: 1 format (message), 2 timestamp (µs since the epoch), 3 audio (bytes). */
export const decodeAudioPacket = (b: Buffer): AudioPacket => {
  const p: AudioPacket = {timestamp: 0, audio: Buffer.alloc(0)};
  for (let at = 0; at < b.length; ) {
    const [key, next] = readVarint(b, at);
    at = next;
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      const [v, after] = readVarint(b, at);
      at = after;
      if (field === 2) p.timestamp = v;
    } else if (wire === 2) {
      const [len, after] = readVarint(b, at);
      const body = b.subarray(after, after + len);
      at = after + len;
      if (field === 1) p.format = decodeFormat(body);
      if (field === 3) p.audio = body;
    } else if (wire === 5) at += 4;
    else if (wire === 1) at += 8;
    else break;
  }
  return p;
};

/** The AudioFormat a capture asks for: 16-bit at `rate`, mono or stereo. */
export const encodeFormat = (rate: number, channels: 1 | 2): Buffer => {
  const varint = (n: number) => {
    const out: number[] = [];
    let v = n;
    while (v > 0x7f) {
      out.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return out;
  };
  return Buffer.from([0x08, ...varint(rate), ...(channels === 2 ? [0x10, 1] : []), 0x18, 1]);
};

/** Splits gRPC frames out of a byte stream; what is left over waits for the next chunk. */
export const takeFrames = (buf: Buffer): {messages: Buffer[]; rest: Buffer} => {
  const messages: Buffer[] = [];
  let at = 0;
  while (buf.length - at >= 5) {
    const len = buf.readUInt32BE(at + 1);
    if (buf.length - at - 5 < len) break;
    messages.push(buf.subarray(at + 5, at + 5 + len));
    at += 5 + len;
  }
  return {messages, rest: buf.subarray(at)};
};

// ---- the timeline ----------------------------------------------------------------------------------------------

/**
 * Packets laid out from `startUs` to `endUs` (µs since the epoch) as 16-bit samples: each where its timestamp says,
 * unless that would overlap the one before (clocks jitter by a few ms) — then right after it. Gaps are silence.
 */
export const timeline = (packets: AudioPacket[], fmt: AudioFormat, startUs: number, endUs: number): Pcm => {
  const frameBytes = fmt.channels * (fmt.bits / 8);
  const toFrames = (us: number) => Math.max(0, Math.round(((us - startUs) / 1e6) * fmt.rate));
  const total = Math.max(toFrames(endUs), 0);
  let cursor = 0;
  const placed: {at: number; audio: Buffer}[] = [];
  for (const p of packets) {
    const frames = Math.floor(p.audio.length / frameBytes);
    if (!frames) continue;
    // A packet's timestamp is when it was captured, at its end or its start depending on the build: within 40 ms of
    // the cursor it continues the run before it.
    const want = toFrames(p.timestamp);
    const at = Math.abs(want - cursor) <= fmt.rate * 0.04 || want < cursor ? cursor : want;
    placed.push({at, audio: p.audio.subarray(0, frames * frameBytes)});
    cursor = at + frames;
  }
  const length = Math.max(total, cursor);
  const data = new Float32Array(length * fmt.channels);
  for (const {at, audio} of placed) {
    const n = audio.length / (fmt.bits / 8);
    for (let i = 0; i < n; i++) data[at * fmt.channels + i] = fmt.bits === 16 ? audio.readInt16LE(i * 2) / 32768 : (audio[i]! - 128) / 128;
  }
  return {rate: fmt.rate, channels: fmt.channels, data};
};

// ---- a capture -------------------------------------------------------------------------------------------------

export type AudioCapture = {
  serial: string;
  startedAt: number;
  /** Ends the capture: what was played, from its start to now. */
  stop: () => Promise<{pcm: Pcm; packets: number}>;
};

/** Starts taking what emulator `serial` plays (16-bit, `rate` Hz, stereo by default, as the device mixes it). */
export const captureAudio = async (serial: string, o: {rate?: number; channels?: 1 | 2; endpoint?: EmulatorEndpoint} = {}): Promise<AudioCapture> => {
  const ep = o.endpoint ?? endpointOf(serial);
  const fmt: AudioFormat = {rate: o.rate ?? 44100, channels: o.channels ?? 2, bits: 16};
  const startUs = Date.now() * 1000;
  const client = http2.connect(`http://127.0.0.1:${ep.port}`);
  const packets: AudioPacket[] = [];
  let rest: Buffer = Buffer.alloc(0);
  let error: string | undefined;
  client.on('error', e => (error ??= e.message));
  const req = client.request({':method': 'POST', ':path': `/${SERVICE}/streamAudio`, 'content-type': 'application/grpc', te: 'trailers', ...(ep.token ? {authorization: `Bearer ${ep.token}`} : {})});
  const body = encodeFormat(fmt.rate, fmt.channels);
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length, 1);
  req.end(Buffer.concat([head, body]));
  req.on('data', (d: Buffer) => {
    const r = takeFrames(rest.length ? Buffer.concat([rest, d]) : d);
    rest = r.rest;
    for (const m of r.messages) {
      const p = decodeAudioPacket(m);
      // A packet without a usable timestamp is placed when it arrived.
      packets.push(p.timestamp > 1e15 ? p : {...p, timestamp: Date.now() * 1000});
    }
  });
  req.on('trailers', h => {
    const status = String(h['grpc-status'] ?? '0');
    if (status !== '0') error ??= h['grpc-message'] ? decodeURIComponent(String(h['grpc-message'])) : `status ${status}`;
  });
  req.on('error', e => (error ??= e.message));
  // The emulator sends its headers with the first sound, not before; a refusal (a bad token, no audio) comes back
  // at once, so a short wait tells the two apart.
  await new Promise<void>(resolve => {
    const done = () => resolve();
    req.once('error', done);
    req.once('close', done);
    req.once('trailers', done);
    setTimeout(done, 300);
  });
  if (error) {
    client.close();
    throw new AndroidError(`audio capture on ${serial}: ${error}`, 'the emulator must run with audio: boot it with audio=true');
  }
  return {
    serial,
    startedAt: startUs / 1000,
    stop: async () => {
      const endUs = Date.now() * 1000;
      req.close();
      client.close();
      return {pcm: timeline(packets, packets.find(p => p.format)?.format ?? fmt, startUs, endUs), packets: packets.length};
    },
  };
};
