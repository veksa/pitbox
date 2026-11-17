// Sound as numbers: WAV files in and out, generated signals (a tone, silence, noise), noise mixed in at a given
// signal-to-noise ratio, and what a recording holds (level, how long it sounds, where). No dependency: what the
// microphone feeds and what audio capture checks both work on these.

/** Samples interleaved by channel, each -1…1. */
export type Pcm = {rate: number; channels: number; data: Float32Array};

export const seconds = (p: Pcm) => p.data.length / p.channels / p.rate;

const dbToGain = (db: number) => 10 ** (db / 20);
export const gainToDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

// ---- WAV -------------------------------------------------------------------------------------------------------

/** Reads a WAV: PCM 8, 16, 24 or 32 bits, or float 32 or 64, any rate and channel count (extensible headers too). */
export const decodeWav = (b: Buffer): Pcm => {
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt: {format: number; channels: number; rate: number; bits: number} | undefined;
  let body: Buffer | undefined;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const chunk = b.subarray(at + 8, Math.min(b.length, at + 8 + size));
    if (id === 'fmt ' && chunk.length >= 16) {
      let format = chunk.readUInt16LE(0);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (format === 0xfffe && chunk.length >= 26) format = chunk.readUInt16LE(24);
      fmt = {format, channels: chunk.readUInt16LE(2), rate: chunk.readUInt32LE(4), bits: chunk.readUInt16LE(14)};
    }
    if (id === 'data') body = chunk;
    // A streamed WAV may say 0 or 0xFFFFFFFF for its data size: the data runs to the end of the file.
    if (id === 'data' && (size === 0 || size === 0xffffffff)) body = b.subarray(at + 8);
    at += 8 + size + (size % 2);
  }
  if (!fmt || !body) throw new Error('the WAV has no fmt or data chunk');
  const {format, channels, rate, bits} = fmt;
  if (!channels || !rate) throw new Error('the WAV has no channels or no rate');
  const bytes = bits / 8;
  const n = Math.floor(body.length / bytes);
  const data = new Float32Array(n);
  if (format === 3 && bits === 32) for (let i = 0; i < n; i++) data[i] = body.readFloatLE(i * 4);
  else if (format === 3 && bits === 64) for (let i = 0; i < n; i++) data[i] = body.readDoubleLE(i * 8);
  else if (format === 1 && bits === 8) for (let i = 0; i < n; i++) data[i] = (body[i]! - 128) / 128;
  else if (format === 1 && bits === 16) for (let i = 0; i < n; i++) data[i] = body.readInt16LE(i * 2) / 32768;
  else if (format === 1 && bits === 24) for (let i = 0; i < n; i++) data[i] = body.readIntLE(i * 3, 3) / 8388608;
  else if (format === 1 && bits === 32) for (let i = 0; i < n; i++) data[i] = body.readInt32LE(i * 4) / 2147483648;
  else throw new Error(`a WAV of format ${format} with ${bits}-bit samples is not supported (PCM 8/16/24/32 or float 32/64)`);
  return {rate, channels, data: data.subarray(0, n - (n % channels))};
};

/** Signed 16-bit little-endian samples, clipped. */
export const toS16 = (p: Pcm): Buffer => {
  const out = Buffer.alloc(p.data.length * 2);
  for (let i = 0; i < p.data.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(p.data[i]! * 32768))), i * 2);
  return out;
};

export const fromS16 = (b: Buffer, rate: number, channels: number): Pcm => {
  const n = Math.floor(b.length / 2);
  const data = new Float32Array(n - (n % channels));
  for (let i = 0; i < data.length; i++) data[i] = b.readInt16LE(i * 2) / 32768;
  return {rate, channels, data};
};

/** A 16-bit PCM WAV. */
export const encodeWav = (p: Pcm): Buffer => {
  const pcm = toS16(p);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(p.channels, 22);
  head.writeUInt32LE(p.rate, 24);
  head.writeUInt32LE(p.rate * p.channels * 2, 28);
  head.writeUInt16LE(p.channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
};

// ---- shape ---------------------------------------------------------------------------------------------------

/** The same sound with `channels` channels: mono is the mean, more channels repeat the mono mix. */
export const remix = (p: Pcm, channels: number): Pcm => {
  if (p.channels === channels) return p;
  const frames = p.data.length / p.channels;
  const out = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < p.channels; c++) sum += p.data[f * p.channels + c]!;
    const mono = sum / p.channels;
    for (let c = 0; c < channels; c++) out[f * channels + c] = mono;
  }
  return {rate: p.rate, channels, data: out};
};

/** The same sound at another rate (linear interpolation: enough for speech and test signals, not for music mastering). */
export const resample = (p: Pcm, rate: number): Pcm => {
  if (p.rate === rate) return p;
  const frames = p.data.length / p.channels;
  const outFrames = Math.max(0, Math.round((frames * rate) / p.rate));
  const out = new Float32Array(outFrames * p.channels);
  const step = p.rate / rate;
  for (let f = 0; f < outFrames; f++) {
    const x = f * step;
    const i = Math.floor(x);
    const t = x - i;
    for (let c = 0; c < p.channels; c++) {
      const a = p.data[Math.min(frames - 1, i) * p.channels + c] ?? 0;
      const b = p.data[Math.min(frames - 1, i + 1) * p.channels + c] ?? a;
      out[f * p.channels + c] = a + (b - a) * t;
    }
  }
  return {rate, channels: p.channels, data: out};
};

export const convert = (p: Pcm, rate: number, channels: number): Pcm => resample(remix(p, channels), rate);

export const concat = (parts: Pcm[]): Pcm => {
  const first = parts[0];
  if (!first) return {rate: 16000, channels: 1, data: new Float32Array(0)};
  const all = parts.map(x => convert(x, first.rate, first.channels));
  const data = new Float32Array(all.reduce((n, x) => n + x.data.length, 0));
  let at = 0;
  for (const x of all) {
    data.set(x.data, at);
    at += x.data.length;
  }
  return {rate: first.rate, channels: first.channels, data};
};

/** Louder or quieter by `db`. */
export const gain = (p: Pcm, db: number): Pcm => {
  const g = dbToGain(db);
  return {...p, data: p.data.map(x => x * g)};
};

/** The first `secs` seconds, or the sound repeated until it lasts that long. */
export const fit = (p: Pcm, secs: number): Pcm => {
  const want = Math.round(secs * p.rate) * p.channels;
  if (!p.data.length) return {...p, data: new Float32Array(want)};
  const data = new Float32Array(want);
  for (let i = 0; i < want; i++) data[i] = p.data[i % p.data.length]!;
  return {...p, data};
};

// ---- signals -------------------------------------------------------------------------------------------------

export type NoiseColor = 'white' | 'pink' | 'brown';

/** A seeded generator, so a test signal is the same on every run. */
const prng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const frames = (secs: number, rate: number) => Math.max(0, Math.round(secs * rate));

/** A sine at `freq` Hz, `level` dBFS for its peak (default -12), with 10 ms fades so it starts and ends without a click. */
export const tone = (o: {freq: number; secs: number; rate?: number; level?: number}): Pcm => {
  const rate = o.rate ?? 16000;
  const n = frames(o.secs, rate);
  const amp = dbToGain(o.level ?? -12);
  const fade = Math.min(Math.round(rate * 0.01), Math.floor(n / 2));
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = fade ? Math.min(1, i / fade, (n - 1 - i) / fade) : 1;
    data[i] = amp * env * Math.sin((2 * Math.PI * o.freq * i) / rate);
  }
  return {rate, channels: 1, data};
};

export const silence = (o: {secs: number; rate?: number}): Pcm => ({rate: o.rate ?? 16000, channels: 1, data: new Float32Array(frames(o.secs, o.rate ?? 16000))});

/** Noise with its RMS at `level` dBFS (default -30): white, pink (-3 dB per octave, like a room) or brown (a rumble). */
export const noise = (o: {secs: number; color?: NoiseColor; rate?: number; level?: number; seed?: number}): Pcm => {
  const rate = o.rate ?? 16000;
  const n = frames(o.secs, rate);
  const rnd = prng(o.seed ?? 1);
  const data = new Float32Array(n);
  const color = o.color ?? 'white';
  // Paul Kellet's economy pink filter; brown is integrated white with a leak.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    if (color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      data[i] = b0 + b1 + b2 + w * 0.1848;
    } else if (color === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      data[i] = last;
    } else data[i] = w;
  }
  const r = rms({rate, channels: 1, data});
  const g = r > 0 ? dbToGain(o.level ?? -30) / r : 0;
  for (let i = 0; i < n; i++) data[i]! *= g;
  return {rate, channels: 1, data};
};

/**
 * `signal` with `noiseOf` mixed in so that the signal stands `snr` dB above the noise (RMS against RMS, over the
 * signal's sounding part, so leading silence does not lower the target). The noise loops to the signal's length;
 * the mix is lowered as a whole when it would clip.
 */
export const mixAtSnr = (signal: Pcm, noiseOf: Pcm, snr: number): Pcm => {
  const n = fit(convert(noiseOf, signal.rate, signal.channels), seconds(signal));
  const sigRms = activeRms(signal);
  const noiseRms = rms(n);
  if (!(sigRms > 0) || !(noiseRms > 0)) return signal;
  const g = sigRms / dbToGain(snr) / noiseRms;
  const data = new Float32Array(signal.data.length);
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    data[i] = signal.data[i]! + n.data[i]! * g;
    peak = Math.max(peak, Math.abs(data[i]!));
  }
  if (peak > 0.999) for (let i = 0; i < data.length; i++) data[i]! *= 0.999 / peak;
  return {...signal, data};
};

// ---- analysis ------------------------------------------------------------------------------------------------

export const rms = (p: Pcm): number => {
  if (!p.data.length) return 0;
  let s = 0;
  for (const x of p.data) s += x * x;
  return Math.sqrt(s / p.data.length);
};

export const peak = (p: Pcm): number => {
  let m = 0;
  for (const x of p.data) m = Math.max(m, Math.abs(x));
  return m;
};

/** RMS over the windows that sound (above -60 dBFS): a signal's level without the pauses around it. */
const activeRms = (p: Pcm): number => {
  const w = Math.max(1, Math.round(p.rate * 0.02)) * p.channels;
  let sum = 0;
  let count = 0;
  for (let at = 0; at < p.data.length; at += w) {
    let s = 0;
    const end = Math.min(p.data.length, at + w);
    for (let i = at; i < end; i++) s += p.data[i]! * p.data[i]!;
    if (Math.sqrt(s / (end - at)) > dbToGain(-60)) {
      sum += s;
      count += end - at;
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
};

export type Segment = {from: number; to: number};

export type AudioReport = {
  secs: number;
  rate: number;
  channels: number;
  /** RMS over the whole recording, dBFS. */
  rmsDb: number;
  peakDb: number;
  /** RMS over the windows that sound, dBFS: how loud it is while it sounds (-inf in silence). */
  loudDb: number;
  /** How long it sounds: windows louder than `threshold`. */
  soundSecs: number;
  /** When the first sound starts, seconds from the start; undefined in silence. */
  firstSound?: number;
  segments: Segment[];
  threshold: number;
};

/**
 * What a recording holds: its level, and where it sounds — 20 ms windows louder than `threshold` dBFS (default -50),
 * joined across gaps shorter than `gapMs` (default 300) and kept when longer than `minMs` (default 60).
 */
export const analyze = (p: Pcm, o: {threshold?: number; windowMs?: number; gapMs?: number; minMs?: number} = {}): AudioReport => {
  const threshold = o.threshold ?? -50;
  const win = Math.max(1, Math.round((p.rate * (o.windowMs ?? 20)) / 1000));
  const total = p.data.length / p.channels;
  const loud: boolean[] = [];
  let loudSum = 0;
  let loudCount = 0;
  for (let f = 0; f < total; f += win) {
    let s = 0;
    const end = Math.min(total, f + win);
    for (let i = f * p.channels; i < end * p.channels; i++) s += p.data[i]! * p.data[i]!;
    const on = gainToDb(Math.sqrt(s / ((end - f) * p.channels))) > threshold;
    loud.push(on);
    if (on) {
      loudSum += s;
      loudCount += (end - f) * p.channels;
    }
  }
  const winSecs = win / p.rate;
  const raw: Segment[] = [];
  loud.forEach((l, i) => {
    if (!l) return;
    const last = raw[raw.length - 1];
    if (last && Math.abs(last.to - i * winSecs) < 1e-9) last.to = (i + 1) * winSecs;
    else raw.push({from: i * winSecs, to: (i + 1) * winSecs});
  });
  const joined: Segment[] = [];
  for (const s of raw) {
    const last = joined[joined.length - 1];
    if (last && s.from - last.to < (o.gapMs ?? 300) / 1000) last.to = s.to;
    else joined.push({...s});
  }
  const end = total / p.rate;
  const segments = joined.filter(s => s.to - s.from >= (o.minMs ?? 60) / 1000).map(s => ({from: round(s.from), to: round(Math.min(end, s.to))}));
  return {
    secs: round(end),
    rate: p.rate,
    channels: p.channels,
    rmsDb: roundDb(gainToDb(rms(p))),
    peakDb: roundDb(gainToDb(peak(p))),
    loudDb: roundDb(gainToDb(loudCount ? Math.sqrt(loudSum / loudCount) : 0)),
    soundSecs: round(segments.reduce((n, s) => n + s.to - s.from, 0)),
    firstSound: segments[0]?.from,
    segments,
    threshold,
  };
};

const round = (x: number) => Math.round(x * 100) / 100;
const roundDb = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : -Infinity);

/** The strongest frequency of a mono mix, Hz (a Goertzel scan over 50…`max` Hz in 10 Hz steps: enough to tell a test tone). */
export const dominantFreq = (p: Pcm, max = 4000): number | undefined => {
  const mono = remix(p, 1);
  // A second at most, from the loudest part being the middle of the sound is good enough for a steady tone.
  const n = Math.min(mono.data.length, mono.rate);
  if (n < 64) return undefined;
  const start = Math.max(0, Math.floor((mono.data.length - n) / 2));
  const x = mono.data.subarray(start, start + n);
  let best: {f: number; p: number} | undefined;
  for (let f = 50; f <= Math.min(max, mono.rate / 2 - 10); f += 10) {
    const w = (2 * Math.PI * f) / mono.rate;
    const c = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const s = x[i]! + c * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    const pow = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (!best || pow > best.p) best = {f, p: pow};
  }
  return best && best.p > 1e-6 ? best.f : undefined;
};

/** One line about a recording, as answers print it. */
export const describe = (r: AudioReport): string => {
  if (!r.segments.length) return `silent ${r.secs}s (peak ${fmtDb(r.peakDb)}, nothing above ${r.threshold} dBFS)`;
  const parts = r.segments.slice(0, 4).map(s => `${s.from}–${s.to}s`);
  if (r.segments.length > 4) parts.push(`+${r.segments.length - 4} more`);
  return `sound ${r.soundSecs}s of ${r.secs}s, first at ${r.firstSound}s · level ${fmtDb(r.loudDb)} peak ${fmtDb(r.peakDb)} · ${parts.join(' ')}`;
};

export const fmtDb = (db: number) => (Number.isFinite(db) ? `${db} dBFS` : '-inf dBFS');

// ---- the words a person writes ---------------------------------------------------------------------------------

/** `2s`, `1.5s`, `500ms`, `2` (seconds) → seconds. */
export const parseSecs = (s: string): number => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(s.trim());
  if (!m) throw new Error(`not a duration: ${s} (2s, 500ms, 1.5)`);
  const n = Number(m[1]);
  return m[2] === 'ms' ? n / 1000 : m[2] === 'm' ? n * 60 : n;
};

/** `-12dB`, `-12`, `-12dBFS` → dB. */
export const parseDb = (s: string): number => {
  const m = /^([-+]?\d+(?:\.\d+)?)\s*(db|dbfs)?$/i.exec(s.trim());
  if (!m) throw new Error(`not a level: ${s} (-12dB)`);
  return Number(m[1]);
};

/** `440`, `440hz`, `1k`, `1khz` → Hz. */
export const parseHz = (s: string): number => {
  const m = /^(\d+(?:\.\d+)?)(k)?(hz)?$/i.exec(s.trim());
  if (!m) throw new Error(`not a frequency: ${s} (440, 1k)`);
  return Number(m[1]) * (m[2] ? 1000 : 1);
};
