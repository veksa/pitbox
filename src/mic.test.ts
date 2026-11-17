import {describe, expect, it} from 'vitest';
import {audioPacket, chunks, endpointOf, parseWav, segments} from './drivers/android/mic.ts';
import {parseFlow, validateFlow} from './flows/flow.ts';
import {parseArgs, toCall} from './cli.ts';

/** A PCM WAV: the header for `rate`, `channels`, `bits`, then `samples` frames of zeros. */
const wav = (rate: number, channels: number, bits: number, frames: number, format = 1) => {
  const data = Buffer.alloc(frames * channels * (bits / 8));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(format, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE((rate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};

describe('mic', () => {
  it('reads a PCM WAV and refuses what the emulator cannot take', () => {
    expect(parseWav(wav(16_000, 1, 16, 1600))).toMatchObject({rate: 16_000, channels: 1, bits: 16});
    expect(parseWav(wav(16_000, 1, 16, 1600)).pcm.length).toBe(3200);
    expect(() => parseWav(Buffer.from('not a wav at all'))).toThrow(/not a WAV/);
    expect(() => parseWav(wav(96_000, 1, 16, 10))).toThrow(/96000 Hz is not what the emulator takes/);
    expect(() => parseWav(wav(16_000, 1, 32, 10, 3))).toThrow(/32-bit/);
  });

  it('cuts the samples into 100 ms packets of whole frames', () => {
    const w = parseWav(wav(44_100, 2, 16, 44_100 + 10));
    const parts = chunks(w);
    expect(parts.length).toBe(11);
    expect(parts[0]!.length).toBe(4410 * 4);
    expect(parts[10]!.length).toBe(10 * 4);
  });

  it('encodes an AudioPacket with its format, real-time mode, capture time and samples', () => {
    const p = audioPacket({rate: 16_000, channels: 1, bits: 16}, Buffer.from([1, 2]), 1_700_000_000_000_000);
    // AudioFormat {samplingRate 16000, format s16 (1), mode real time (1)}: mono is the default 0, left out.
    expect(p.subarray(0, 9).toString('hex')).toBe('0a0708807d18012001');
    // The capture time, a 64-bit varint, then the samples.
    expect(p[9]).toBe(0x10);
    let v = 0n;
    for (let i = 10, shift = 0n; ; i++, shift += 7n) {
      v |= BigInt(p[i]! & 0x7f) << shift;
      if (!(p[i]! & 0x80)) break;
    }
    expect(v).toBe(1_700_000_000_000_000n);
    expect(p.subarray(p.length - 4).toString('hex')).toBe('1a020102');
  });

  it('plays a long file as calls of 2 s: one long call stops reaching the guest after a few seconds', () => {
    const runs = segments(Array.from({length: 45}, (_, i) => i));
    expect(runs.map(r => r.length)).toEqual([20, 20, 5]);
    expect(runs.flat()).toEqual(Array.from({length: 45}, (_, i) => i));
    expect(segments([])).toEqual([]);
  });

  it('feeds only emulators', () => {
    expect(() => endpointOf('R5CT1234')).toThrow(/R5CT1234 is not an emulator/);
  });

  it('is a flow step and a command', () => {
    expect(validateFlow(parseFlow('mic speech.wav\nmic'))).toEqual(['line 2: mic needs 1 argument']);
    expect(toCall(parseArgs(['mic', 'speech.wav', '--device', 'emulator-5554']))).toEqual({method: 'mic', params: {device: 'emulator-5554', value: 'speech.wav'}});
    expect(toCall(parseArgs(['boot', 'Pixel', '--audio']))).toMatchObject({method: 'boot', params: {avd: 'Pixel', audio: true}});
  });
});
