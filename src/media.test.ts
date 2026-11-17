import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {decodeAudioPacket, encodeFormat, takeFrames, timeline} from './drivers/android/audioOut.ts';
import {activeRecorders} from './drivers/android/mic.ts';
import {decodeArgs, framesArgs, muxArgs, reencodeArgs} from './media/ffmpeg.ts';
import {analyze, concat, convert, decodeWav, describe as describeAudio, dominantFreq, encodeWav, fit, gainToDb, mixAtSnr, noise, parseDb, parseHz, parseSecs, rms, seconds, silence, tone} from './media/pcm.ts';
import {describeSound, parseMic, renderSound} from './media/sound.ts';
import {androidPermissions, appleService, audioMisses, parseAudioExpect, words} from './media/center.ts';
import {parseFlow, validateFlow} from './flows/flow.ts';
import {parseArgs, toCall} from './cli.ts';

const varint = (n: number) => {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
};

describe('pcm', () => {
  it('writes a 16-bit WAV and reads it back, and reads 8, 24, 32-bit and float WAVs', () => {
    const t = tone({freq: 1000, secs: 0.5, rate: 16000, level: -6});
    const back = decodeWav(encodeWav(t));
    expect(back).toMatchObject({rate: 16000, channels: 1});
    expect(back.data.length).toBe(8000);
    expect(Math.abs(back.data[100]! - t.data[100]!)).toBeLessThan(1 / 16000);
    const raw = (format: number, bits: number, body: Buffer) => {
      const h = Buffer.alloc(44);
      h.write('RIFF', 0, 'ascii');
      h.writeUInt32LE(36 + body.length, 4);
      h.write('WAVEfmt ', 8, 'ascii');
      h.writeUInt32LE(16, 16);
      h.writeUInt16LE(format, 20);
      h.writeUInt16LE(1, 22);
      h.writeUInt32LE(8000, 24);
      h.writeUInt16LE(bits, 34);
      h.write('data', 36, 'ascii');
      h.writeUInt32LE(body.length, 40);
      return Buffer.concat([h, body]);
    };
    expect(decodeWav(raw(1, 8, Buffer.from([255, 0]))).data[1]).toBe(-1);
    const f = Buffer.alloc(4);
    f.writeFloatLE(0.5);
    expect(decodeWav(raw(3, 32, f)).data[0]).toBe(0.5);
    const i24 = Buffer.alloc(3);
    i24.writeIntLE(-4194304, 0, 3);
    expect(decodeWav(raw(1, 24, i24)).data[0]).toBe(-0.5);
    expect(() => decodeWav(Buffer.from('nope'))).toThrow(/not a WAV/);
    expect(() => decodeWav(raw(2, 4, Buffer.alloc(4)))).toThrow(/not supported/);
  });

  it('makes tones, silence and noise at the levels asked', () => {
    const t = tone({freq: 440, secs: 1, rate: 16000, level: -6});
    expect(seconds(t)).toBe(1);
    expect(dominantFreq(t)).toBe(440);
    expect(t.data[0]).toBe(0);
    expect(rms(silence({secs: 1}))).toBe(0);
    for (const color of ['white', 'pink', 'brown'] as const) expect(gainToDb(rms(noise({secs: 1, color, level: -30})))).toBeCloseTo(-30, 1);
    expect(noise({secs: 0.1, seed: 3}).data).toEqual(noise({secs: 0.1, seed: 3}).data);
  });

  it('mixes noise under a signal at the signal-to-noise ratio asked, over the part that sounds', () => {
    const sig = concat([silence({secs: 1}), tone({freq: 500, secs: 1, level: -10})]);
    const bed = noise({secs: 0.5, color: 'pink', level: -40});
    const mixed = mixAtSnr(sig, bed, 10);
    expect(seconds(mixed)).toBe(2);
    // The noise alone, as it is in the mix: the pause before the tone holds only noise.
    const noiseRms = rms({...mixed, data: mixed.data.subarray(0, 16000)});
    const sigRms = rms({...sig, data: sig.data.subarray(16000)});
    expect(20 * Math.log10(sigRms / noiseRms)).toBeCloseTo(10, 0);
  });

  it('converts rates and channels, fits lengths', () => {
    const t = tone({freq: 300, secs: 1, rate: 48000});
    const c = convert(t, 16000, 2);
    expect(c).toMatchObject({rate: 16000, channels: 2});
    expect(c.data.length).toBe(32000);
    expect(dominantFreq(c)).toBe(300);
    expect(seconds(fit(t, 2.5))).toBe(2.5);
  });

  it('says where a recording sounds, how long and how loud', () => {
    const p = concat([silence({secs: 0.5}), tone({freq: 880, secs: 1, level: -12}), silence({secs: 0.4}), tone({freq: 880, secs: 0.5, level: -12}), silence({secs: 0.5})]);
    const r = analyze(p);
    expect(r.segments).toEqual([
      {from: 0.5, to: 1.5},
      {from: 1.9, to: 2.4},
    ]);
    expect(r.soundSecs).toBe(1.5);
    expect(r.firstSound).toBe(0.5);
    expect(r.loudDb).toBeCloseTo(-15, 0);
    expect(describeAudio(r)).toMatch(/^sound 1.5s of 2.9s, first at 0.5s · level -15/);
    expect(describeAudio(analyze(silence({secs: 1})))).toMatch(/^silent 1s/);
    // Pauses shorter than the gap are one sound.
    expect(analyze(p, {gapMs: 500}).segments).toHaveLength(1);
  });

  it('reads the words people write for durations, levels and frequencies', () => {
    expect(parseSecs('500ms')).toBe(0.5);
    expect(parseSecs('2')).toBe(2);
    expect(parseSecs('1m')).toBe(60);
    expect(parseDb('-12dB')).toBe(-12);
    expect(parseHz('1k')).toBe(1000);
    expect(() => parseSecs('soon')).toThrow(/not a duration/);
  });
});

describe('mic sounds', () => {
  it('parses files, signals, parts joined with + and options', () => {
    expect(parseMic('stop')).toEqual({op: 'stop'});
    expect(parseMic('speech.wav')).toEqual({op: 'play', spec: {parts: [{kind: 'file', file: 'speech.wav', secs: undefined}]}, bg: false, wait: undefined});
    const m = parseMic('silence 500ms + tone 1k 2s -6dB + noise pink 1s noise=brown snr=5 gain=-3dB repeat=2 gap=1s wait=20s bg');
    expect(m).toEqual({
      op: 'play',
      bg: true,
      wait: 20,
      spec: {
        parts: [
          {kind: 'silence', secs: 0.5},
          {kind: 'tone', freq: 1000, secs: 2, level: -6},
          {kind: 'noise', color: 'pink', secs: 1, level: undefined},
        ],
        noise: 'brown',
        snr: 5,
        gain: -3,
        repeat: 2,
        gap: 1,
      },
    });
    expect(parseMic('speech.wav snr=10')).toMatchObject({spec: {noise: 'white', snr: 10}});
    expect(parseMic('a.wav noise=cafe.mp3')).toMatchObject({spec: {noise: {file: 'cafe.mp3'}}});
    expect(() => parseMic('tone loud')).toThrow(/did not understand "loud"/);
    expect(() => parseMic('a.wav volume=3')).toThrow(/unknown option volume/);
    expect(describeSound((parseMic('a/speech.wav noise=pink snr=10 repeat=2') as {spec: never}).spec)).toBe('speech.wav, pink noise at snr 10 dB, ×2');
  });

  it('renders what it parsed: lengths add up, repeats with gaps, files read from the root', async () => {
    const p = await renderSound((parseMic('silence 1s + tone 440 0.5s repeat=3 gap=250ms') as {spec: never}).spec, {rate: 16000});
    expect(seconds(p)).toBeCloseTo(1.5 * 3 + 0.25 * 2, 3);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-mic-'));
    fs.writeFileSync(path.join(dir, 'b.wav'), encodeWav(tone({freq: 600, secs: 1, rate: 8000})));
    const f = await renderSound((parseMic('b.wav 0.5s noise=pink snr=20') as {spec: never}).spec, {rate: 16000, root: dir});
    expect(f.rate).toBe(16000);
    expect(seconds(f)).toBe(0.5);
    expect(dominantFreq(f)).toBe(600);
  });

  it('knows when an app records, from dumpsys audio', () => {
    const quiet = 'RecordActivityMonitor dump time: 12:17:41 PM\n\n\nEvents log: recording activity received by AudioService\n11-17 rec start riid:71 pack:dev.example\n';
    expect(activeRecorders(quiet)).toEqual([]);
    const busy = 'RecordActivityMonitor dump time: 12:17:42 PM\nriid 87; active? true\n  session:97 -- source client=MIC -- uid:10215 -- patch:22 -- pack:com.example.app -- format\n\nEvents log:\n';
    expect(activeRecorders(busy)).toEqual(['com.example.app']);
    expect(activeRecorders('no such section')).toEqual([]);
  });
});

describe('audio capture', () => {
  it('reads AudioPackets with 64-bit timestamps and splits gRPC frames across chunks', () => {
    const ts = 1_794_909_862_222_123;
    const fmt = Buffer.concat([Buffer.from([0x08]), varint(44100), Buffer.from([0x10, 1, 0x18, 1])]);
    const audio = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    const msg = Buffer.concat([Buffer.from([0x0a, fmt.length]), fmt, Buffer.from([0x10]), varint(ts), Buffer.from([0x1a, audio.length]), audio]);
    expect(decodeAudioPacket(msg)).toEqual({format: {rate: 44100, channels: 2, bits: 16}, timestamp: ts, audio});
    const head = Buffer.alloc(5);
    head.writeUInt32BE(msg.length, 1);
    const stream = Buffer.concat([head, msg, head, msg]);
    const a = takeFrames(stream.subarray(0, head.length + msg.length + 3));
    expect(a.messages).toHaveLength(1);
    const b = takeFrames(Buffer.concat([a.rest, stream.subarray(head.length + msg.length + 3)]));
    expect(b.messages).toHaveLength(1);
    expect(b.rest.length).toBe(0);
    expect(encodeFormat(44100, 2).toString('hex')).toBe(`08${varint(44100).toString('hex')}10011801`);
  });

  it('lays packets on a timeline: quiet stretches are silence, jitter does not shift the sound', () => {
    const fmt = {rate: 1000, channels: 1 as const, bits: 16 as const};
    const pkt = (atMs: number, n: number) => ({timestamp: (1e12 + atMs) * 1000, audio: Buffer.alloc(n * 2, 0x40)});
    // 100 ms of sound at 200 ms (in two packets, the second 5 ms early), quiet until 1 s.
    const p = timeline([pkt(200, 50), pkt(245, 50)], fmt, 1e15, (1e12 + 1000) * 1000);
    expect(p.data.length).toBe(1000);
    expect(p.data[199]).toBe(0);
    expect(p.data[200]).toBeGreaterThan(0);
    expect(p.data[299]).toBeGreaterThan(0);
    expect(p.data[300]).toBe(0);
  });
});

describe('ffmpeg arguments', () => {
  it('decodes to raw PCM, takes frames, joins and resizes', () => {
    expect(decodeArgs('in.m4a', 48000, 1)).toEqual(['-i', 'in.m4a', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-acodec', 'pcm_s16le', '-']);
    expect(framesArgs('v.webm', '/o', {every: 2})).toEqual(['-i', 'v.webm', '-vf', "fps=0.5,scale='min(540,iw)':-2", '-q:v', '4', path.join('/o', 'frame-%03d.jpg')]);
    expect(framesArgs('v.webm', '/o', {count: 4, duration: 8, width: 300})).toContain("fps=0.5,scale='min(300,iw)':-2");
    expect(framesArgs('v.webm', '/o', {count: 4, duration: 8})).toContain('-frames:v');
    expect(muxArgs('v.mov', 'a.wav', 'o.mp4', 0.25)).toEqual(['-y', '-i', 'v.mov', '-itsoffset', '0.250', '-i', 'a.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', 'o.mp4']);
    expect(reencodeArgs('i.mov', 'o.mp4', {fps: 15, size: '540'})).toEqual(['-y', '-i', 'i.mov', '-vf', 'fps=15,scale=540:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'copy', 'o.mp4']);
  });
});

describe('media commands', () => {
  it('maps short permission names per platform; the simulator has no camera to grant', () => {
    expect(androidPermissions('mic')).toEqual(['android.permission.RECORD_AUDIO']);
    expect(androidPermissions('photos', 34)).toEqual(['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VIDEO']);
    expect(androidPermissions('photos', 30)).toEqual(['android.permission.READ_EXTERNAL_STORAGE']);
    expect(androidPermissions('android.permission.CAMERA')).toEqual(['android.permission.CAMERA']);
    expect(androidPermissions('record_audio')).toEqual(['android.permission.RECORD_AUDIO']);
    expect(appleService('mic')).toBe('microphone');
    expect(() => appleService('camera')).toThrow(/no camera/);
  });

  it('reads audio checks and says what missed', () => {
    expect(parseAudioExpect('sound min=1s level=-30 freq=880')).toEqual({sound: true, min: 1, level: -30, freq: 880});
    expect(parseAudioExpect('silence')).toEqual({sound: false});
    expect(parseAudioExpect('said "hello there"')).toEqual({said: 'hello there'});
    expect(() => parseAudioExpect('loud')).toThrow(/did not understand/);
    const r = analyze(concat([silence({secs: 0.5}), tone({freq: 880, secs: 1, level: -20})]));
    expect(audioMisses(r, {sound: true, min: 0.5, freq: 880}, 880)).toEqual([]);
    expect(audioMisses(r, {sound: true, min: 2, level: -10, freq: 440}, 880)).toEqual(['sound 1s < 2s', `level ${r.loudDb} dBFS < -10 dBFS`, 'strongest 880 Hz, not 440 Hz']);
    expect(audioMisses(r, {sound: false})).toEqual(['sound 1s, first at 0.5s']);
    expect(words('scene wall "my card.png" x=1')).toEqual({plain: ['scene', 'wall', 'my card.png'], opts: {x: '1'}});
  });

  it('are commands and flow steps', () => {
    expect(toCall(parseArgs(['capture', 'start', 'audio']))).toEqual({method: 'capture', params: {device: undefined, action: 'start', what: 'audio', touches: undefined}});
    expect(toCall(parseArgs(['capture', 'start', 'fps=30', 'size=720x1280', 'touches']))).toMatchObject({params: {action: 'start', what: 'screen', fps: '30', size: '720x1280', touches: true}});
    expect(toCall(parseArgs(['capture', 'check', 'silence']))).toMatchObject({params: {action: 'check', value: 'silence', file: undefined}});
    expect(toCall(parseArgs(['capture', 'frames', 'every=2s']))).toMatchObject({params: {action: 'frames', every: '2s'}});
    expect(toCall(parseArgs(['call', 'incoming', '5551234']))).toEqual({method: 'call', params: {device: undefined, value: 'incoming 5551234'}});
    expect(toCall(parseArgs(['mic', 'tone', '440', '2s', 'bg']))).toEqual({method: 'mic', params: {device: undefined, value: 'tone 440 2s bg'}});
    expect(validateFlow(parseFlow('capture start screen fps=30\ncamera image a.png\nlibrary add a.jpg\ncall incoming\naudio volume music max\ncapture stop\nexpect sound min=1s\nexpect silence'))).toEqual([]);
    expect(validateFlow(parseFlow('capture\ncamera'))).toEqual(['line 1: capture start [screen|audio] [fps=…] [size=…] [touches] | capture stop | capture frames [every=…] | capture check <sound|silence|said …>', 'line 2: camera needs 1 argument']);
  });
});
