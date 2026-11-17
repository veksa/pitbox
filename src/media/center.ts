// Media on a device, one place for both platforms: sound into the microphone (`mic`), what the device plays and
// shows captured to files and checked (`capture`), the camera's picture (`camera`), photos and videos in the
// gallery (`library`), phone calls that interrupt audio (`call`), volumes (`audio`), and the permission names the
// settings take. What a platform cannot do is refused with the reason, never faked.

import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {AndroidDriver} from '../drivers/android/driver.ts';
import type {AppleDevices} from '../remote/appleRemote.ts';
import {captureAudio, type AudioCapture} from '../drivers/android/audioOut.ts';
import {activeRecorders, injectWav} from '../drivers/android/mic.ts';
import {swapFeed} from '../drivers/android/camera.ts';
import {runShell} from '../util/proc.ts';
import {audioOf, extractFrames, ffmpegPath, probeDuration, reencode, NO_FFMPEG} from './ffmpeg.ts';
import {analyze, convert, decodeWav, describe, dominantFreq, encodeWav, parseDb, parseHz, parseSecs, seconds, type AudioReport, type Pcm} from './pcm.ts';
import {describeSound, parseMic, renderSound, type MicCommand} from './sound.ts';
import {DEFAULT_LOOPBACK, InputSwitch, inSimulator, noLoopback, outputIndex, playTo, switchAudio, type HostInput, type Recorder, type Restored} from './loopback.ts';
import {RemoteApple} from '../remote/appleRemote.ts';

export type MediaTarget = {platform: 'android'; id: string; a: AndroidDriver} | {platform: 'apple'; id: string; s: AppleDevices};

export type MediaDeps = {
  target: (device?: string) => Promise<MediaTarget>;
  root: () => string;
  stateDir: () => string;
  /** A command that prints what a WAV says (`{file}` is its path): the transcript hook. */
  transcribe?: () => string | undefined;
  /** The Mac's loopback audio device that feeds an iOS simulator's microphone (default BlackHole 2ch). */
  loopback?: () => string | undefined;
  /** Seams for tests: the Mac's inputs, who records on the Mac, and where the sound goes. */
  hostInput?: () => HostInput;
  /** Where the input to put back is written while it is switched (default ~/.pitbox/mic-input.json). */
  inputFile?: () => string;
  macRecorders?: () => Promise<(Recorder & {command: string})[]>;
  playTo?: typeof playTo;
  outputIndex?: typeof outputIndex;
};

/** Why each platform cannot do something, said the same way everywhere. */
export const CANNOT = {
  appleMic: 'an iOS simulator on another Mac records from that Mac\'s input device: mic switches only this Mac\'s input to its loopback\nhint: run pitbox on the Mac the simulator runs on',
  appleAudioOut: 'an iOS simulator plays through the Mac\'s output device and simctl captures no sound\nhint: route the Mac\'s output into a loopback device (BlackHole or similar) and record that, or assert on the app\'s own player state',
  appleCamera: 'an iOS simulator has no camera: AVCaptureDevice finds none and simctl has no camera service\nhint: give the app pictures through the photo library (library add <file>), or behind a test seam in the app',
  appleCall: 'an iOS simulator has no phone: nothing places or ends a call\nhint: drive the interruption from the app side (AVAudioSession interruption notifications in a test)',
  appleVolume: 'an iOS simulator follows the Mac\'s volume; simctl sets none',
  device: 'only an emulator has this: a phone takes it from the world around it',
} as const;

type Mic = {label: string; secs: number; started: number; abort: AbortController; done: Promise<unknown>; heardBy?: string[]};
type Capture = {
  kind: 'screen' | 'audio';
  started: number;
  file: string;
  stop: () => Promise<void>;
  /** The audio part, for an audio capture. */
  audio?: AudioCapture;
  pcm?: Pcm;
  notes: string[];
  post?: {fps?: number; size?: string};
};
type Last = {file: string; report?: AudioReport; pcm?: Pcm; secs?: number};

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const isEmulator = (serial: string) => /^emulator-\d+$/.test(serial);

/** The permissions a short name stands for on Android (sdk: the device's API level). */
export const androidPermissions = (name: string, sdk = 34): string[] => {
  const n = name.toLowerCase();
  if (n.includes('.')) return [name];
  const map: Record<string, string[]> = {
    mic: ['android.permission.RECORD_AUDIO'],
    microphone: ['android.permission.RECORD_AUDIO'],
    camera: ['android.permission.CAMERA'],
    photos: sdk >= 33 ? ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VIDEO'] : ['android.permission.READ_EXTERNAL_STORAGE'],
    media: sdk >= 33 ? ['android.permission.READ_MEDIA_AUDIO'] : ['android.permission.READ_EXTERNAL_STORAGE'],
    notifications: ['android.permission.POST_NOTIFICATIONS'],
    location: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
    contacts: ['android.permission.READ_CONTACTS'],
    phone: ['android.permission.READ_PHONE_STATE'],
  };
  return map[n] ?? [`android.permission.${name.toUpperCase()}`];
};

/** The simctl privacy service a short name stands for; a camera is refused (the simulator has none). */
export const appleService = (name: string): string => {
  const n = name.toLowerCase();
  if (n === 'camera') throw new Error(CANNOT.appleCamera);
  return ({mic: 'microphone', photos: 'photos', library: 'photos', 'photos-add': 'photos-add', media: 'media-library', location: 'location', contacts: 'contacts', calendar: 'calendar'} as Record<string, string>)[n] ?? n;
};

/** `key=value` words and bare flags of a command's value. */
export const words = (value: string): {plain: string[]; opts: Record<string, string>} => {
  const plain: string[] = [];
  const opts: Record<string, string> = {};
  for (const t of value.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const eq = t.indexOf('=');
    if (eq > 0) opts[t.slice(0, eq)] = t.slice(eq + 1).replace(/^"|"$/g, '');
    else plain.push(t.replace(/^"|"$/g, ''));
  }
  return {plain, opts};
};

export type AudioExpect = {sound?: boolean; min?: number; max?: number; level?: number; freq?: number; said?: string};

/** `sound min=1s level=-30 freq=880`, `silence`, `said "hello"` → what a check asks of a recording. */
export const parseAudioExpect = (value: string): AudioExpect => {
  const {plain, opts} = words(value);
  const e: AudioExpect = {};
  for (const p of plain) {
    if (p === 'sound') e.sound = true;
    else if (p === 'silence' || p === 'silent') e.sound = false;
    else if (p === 'said') continue;
    else if (plain[0] === 'said') e.said = [e.said, p].filter(Boolean).join(' ');
    else throw new Error(`audio check: did not understand "${p}" (sound, silence, said "<words>", min= max= level= freq=)`);
  }
  if (opts.min) e.min = parseSecs(opts.min);
  if (opts.max) e.max = parseSecs(opts.max);
  if (opts.level) e.level = parseDb(opts.level.replace(/^>=?/, ''));
  if (opts.freq) e.freq = parseHz(opts.freq);
  if (opts.said) e.said = opts.said;
  if (e.sound === undefined && e.said === undefined) e.sound = true;
  return e;
};

/** What failed in a recording against `e`; empty when it passes. */
export const audioMisses = (r: AudioReport, e: AudioExpect, freq?: number): string[] => {
  const miss: string[] = [];
  if (e.sound === true && !r.segments.length) miss.push('no sound');
  if (e.sound === false && r.segments.length) miss.push(`sound ${r.soundSecs}s, first at ${r.firstSound}s`);
  if (e.min !== undefined && r.soundSecs < e.min) miss.push(`sound ${r.soundSecs}s < ${e.min}s`);
  if (e.max !== undefined && r.soundSecs > e.max) miss.push(`sound ${r.soundSecs}s > ${e.max}s`);
  if (e.level !== undefined && !(r.loudDb >= e.level)) miss.push(`level ${r.loudDb} dBFS < ${e.level} dBFS`);
  if (e.freq !== undefined && (!freq || Math.abs(freq - e.freq) > Math.max(15, e.freq * 0.03))) miss.push(`strongest ${freq ?? 'none'} Hz, not ${e.freq} Hz`);
  return miss;
};

export class MediaCenter {
  readonly #d: MediaDeps;
  readonly #mics = new Map<string, Mic>();
  readonly #micErrors = new Map<string, string>();
  readonly #captures = new Map<string, Capture>();
  readonly #last = new Map<string, Last>();
  readonly #lastCall = new Map<string, string>();
  #input?: InputSwitch;
  /** The simulator whose sound plays through the Mac's input now: one at a time, as the Mac has one input. */
  #hostMic?: string;

  constructor(deps: MediaDeps) {
    this.#d = deps;
  }

  #dir() {
    const d = path.join(this.#d.stateDir(), 'captures');
    fs.mkdirSync(d, {recursive: true});
    return d;
  }

  async #android(device: string | undefined, what: keyof typeof CANNOT): Promise<{serial: string; a: AndroidDriver}> {
    const t = await this.#d.target(device);
    if (t.platform === 'apple') throw new Error(CANNOT[what]);
    return {serial: t.id, a: t.a};
  }

  // ---- mic ------------------------------------------------------------------------------------------------------

  async mic(device: string | undefined, value: string): Promise<Record<string, unknown>> {
    const cmd = parseMic(value);
    const t = await this.#d.target(device);
    if (t.platform === 'apple') return this.#appleMic(t.id, t.s, cmd);
    const serial = t.id;
    const playing = this.#mics.get(serial);
    if (cmd.op === 'wait') return {serial, ...(await this.#micWait(serial, playing))};
    if (cmd.op === 'status') {
      const err = this.#micErrors.get(serial);
      if (!playing) return {serial, mic: 'idle', ...(err ? {last: err} : {})};
      return {serial, mic: `playing ${playing.label}`, at: `${((Date.now() - playing.started) / 1000).toFixed(1)}s of ${playing.secs.toFixed(1)}s`, ...(playing.heardBy ? {heardBy: playing.heardBy.join(', ')} : {})};
    }
    if (cmd.op === 'stop') {
      if (!playing) return {serial, mic: 'idle'};
      playing.abort.abort();
      await playing.done.catch(() => undefined);
      return {serial, mic: `stopped ${playing.label}`, after: `${((Date.now() - playing.started) / 1000).toFixed(1)}s`};
    }
    if (!isEmulator(serial)) throw new Error(`mic: ${serial} is not an emulator\nhint: ${CANNOT.device}`);
    const e = t.a.running().find(x => x.serial === serial);
    if (e?.audio === false) throw new Error(`mic: ${serial} runs without audio (-no-audio): it has no microphone to feed\nhint: give it back (device action=release) and boot again with audio=true`);
    if (playing) {
      playing.abort.abort();
      await playing.done.catch(() => undefined);
    }
    const pcm = await renderSound(cmd.spec, {rate: 48000, root: this.#d.root()});
    const wav = encodeWav(pcm);
    const label = describeSound(cmd.spec);
    const abort = new AbortController();
    const waitMs = (cmd.wait ?? (cmd.bg ? 60 : 10)) * 1000;
    const mic: Mic = {label, secs: seconds(pcm), started: Date.now(), abort, done: Promise.resolve()};
    const play = async () => {
      const t0 = Date.now();
      // Emulator 37.2 ends itself when audio is injected while nothing records: wait for an app to listen.
      const heardBy = await this.#recorders(t.a, serial, waitMs, abort.signal);
      if (abort.signal.aborted) return {stopped: true, waitedMs: Date.now() - t0};
      if (!heardBy.length) throw new Error(`mic: no app recorded within ${waitMs / 1000}s, so nothing was played\nhint: start the app's recording first (or give mic wait=<secs>, or bg to play when it starts)`);
      mic.heardBy = heardBy;
      mic.started = Date.now();
      const r = await injectWav(serial, wav, {signal: abort.signal, listening: async () => activeRecorders(await t.a.shell(serial, 'dumpsys audio', 10_000).catch(() => '')).length > 0});
      if (r.unheard) return {...r, waitedMs: mic.started - t0, heardBy: heardBy.join(', '), note: `the app stopped recording after ${r.seconds}s: the rest was not played`};
      return {...r, waitedMs: mic.started - t0, heardBy: heardBy.join(', ')};
    };
    this.#micErrors.delete(serial);
    if (!cmd.bg) {
      this.#mics.set(serial, mic);
      mic.done = play();
      try {
        return {serial, sound: label, ...((await mic.done) as object)};
      } finally {
        if (this.#mics.get(serial) === mic) this.#mics.delete(serial);
      }
    }
    mic.done = play()
      .catch(err => this.#micErrors.set(serial, (err as Error).message.split('\n')[0]!))
      .finally(() => {
        if (this.#mics.get(serial) === mic) this.#mics.delete(serial);
      });
    this.#mics.set(serial, mic);
    return {serial, sound: label, secs: Math.round(mic.secs * 10) / 10, background: `plays as soon as an app records (waits up to ${waitMs / 1000}s); mic stop ends it, mic status tells where it is`};
  }

  /** The apps recording on `serial`, waited for up to `ms`. */
  async #recorders(a: AndroidDriver, serial: string, ms: number, signal: AbortSignal): Promise<string[]> {
    const end = Date.now() + ms;
    for (;;) {
      const now = activeRecorders(await a.shell(serial, 'dumpsys audio', 10_000).catch(() => ''));
      if (now.length || signal.aborted || Date.now() >= end) return now;
      await wait(250);
    }
  }

  // ---- mic on iOS: the Mac's input switched to a loopback for the length of the sound -------------------------------

  #inputSwitch(): InputSwitch {
    this.#input ??= new InputSwitch(this.#d.hostInput?.() ?? switchAudio(), this.#d.inputFile ? {file: this.#d.inputFile()} : {});
    return this.#input;
  }

  /** Waits until the sound playing on `id` (in the background) has played; fails when it failed. */
  async #micWait(id: string, playing: Mic | undefined): Promise<Record<string, unknown>> {
    const fail = () => {
      const err = this.#micErrors.get(id);
      if (err) throw new Error(err);
    };
    if (!playing) {
      fail();
      return {mic: 'idle'};
    }
    const r = await playing.done.catch((e: Error) => {
      throw e;
    });
    fail();
    return {mic: `played ${playing.label}`, ...(r && typeof r === 'object' && !(r instanceof Map) ? (r as object) : {})};
  }

  /** An input a pitbox that died mid-sound left on the loopback, put back (at daemon start). */
  async recoverInput(): Promise<Restored | undefined> {
    if (process.platform !== 'darwin' && !this.#d.hostInput) return undefined;
    const sw = this.#inputSwitch();
    if (!sw.state() || this.#hostMic) return undefined;
    return sw.recover();
  }

  /** The input put back now, without awaiting: from the daemon's exit handler, after everything else. */
  restoreInputSync() {
    this.#input?.endSync();
  }

  async #appleMic(udid: string, s: AppleDevices, cmd: MicCommand): Promise<Record<string, unknown>> {
    const playing = this.#mics.get(udid);
    if (cmd.op === 'wait') return {udid, ...(await this.#micWait(udid, playing))};
    if (cmd.op === 'status') {
      const err = this.#micErrors.get(udid);
      if (!playing) return {udid, mic: 'idle', ...(err ? {last: err} : {})};
      return {udid, mic: `playing ${playing.label}`, at: `${((Date.now() - playing.started) / 1000).toFixed(1)}s of ${playing.secs.toFixed(1)}s`, ...(playing.heardBy ? {heardBy: playing.heardBy.join(', ')} : {})};
    }
    if (cmd.op === 'stop') {
      if (!playing) return {udid, mic: 'idle'};
      playing.abort.abort();
      const r = (await playing.done.catch(() => undefined)) as {input?: string} | undefined;
      return {udid, mic: `stopped ${playing.label}`, after: `${((Date.now() - playing.started) / 1000).toFixed(1)}s`, ...(r?.input ? {input: r.input} : {})};
    }
    if (s instanceof RemoteApple) throw new Error(CANNOT.appleMic);
    // The Mac has one input: a sound for any simulator replaces the one playing (its input is put back first).
    const before = this.#hostMic ? this.#mics.get(this.#hostMic) : undefined;
    if (before) {
      before.abort.abort();
      await before.done.catch(() => undefined);
    }
    const loopback = this.#d.loopback?.() ?? DEFAULT_LOOPBACK;
    const host = this.#d.hostInput?.() ?? switchAudio();
    const inputs = await host.inputs();
    const loop = inputs.find(d => d.name === loopback);
    if (!loop) throw new Error(noLoopback(loopback, inputs.map(d => d.name)));
    const index = await (this.#d.outputIndex ?? outputIndex)(loop.uid, loopback);
    const pcm = await renderSound(cmd.spec, {rate: 48000, root: this.#d.root()});
    const wav = encodeWav(pcm);
    const label = describeSound(cmd.spec);
    const recorders = async () => {
      try {
        return await (this.#d.macRecorders ?? (async () => (await import('../drivers/apple/audioTool.ts')).macRecorders()))();
      } catch {
        return undefined;
      }
    };
    // Another app recording from the Mac's input (a call, a dictation) would hear the sound instead of its microphone.
    const current = await host.current();
    if (!cmd.force && current && current.name !== loopback) {
      const others = ((await recorders()) ?? []).filter(r => r.devices.includes(current.uid) && !inSimulator(r.command, udid));
      if (others.length)
        throw new Error(
          `mic: ${others.map(r => r.bundle ?? (path.basename(r.command) || String(r.pid))).join(', ')} record${others.length > 1 ? '' : 's'} from the Mac's input (${current.name}) now: switching it to ${loopback} would feed them the sound instead of their microphone\nhint: wait until that recording ends (a call?), or add force to switch anyway`,
        );
    }
    const abort = new AbortController();
    const waitMs = (cmd.wait ?? (cmd.bg ? 60 : 10)) * 1000;
    const mic: Mic = {label, secs: seconds(pcm), started: Date.now(), abort, done: Promise.resolve()};
    const sw = this.#inputSwitch();
    const play = async () => {
      const t0 = Date.now();
      const {previous, switched} = await sw.begin(loopback);
      const out: Record<string, unknown> = {};
      try {
        // The app records from the loopback once the input is switched: wait for it, as a person waits to speak.
        const heardBy = await this.#macListeners(udid, loop.uid, waitMs, abort.signal, recorders);
        if (abort.signal.aborted) return Object.assign(out, {stopped: true, waitedMs: Date.now() - t0});
        // A simulator's app keeps the input it started recording from: one that started before the switch hears the
        // Mac's own microphone, never the loopback.
        const early = heardBy && !heardBy.length ? ((await recorders()) ?? []).filter(r => inSimulator(r.command, udid) && r.devices.length && !r.devices.includes(loop.uid)) : [];
        if (early.length)
          throw new Error(
            `mic: ${early.map(r => r.bundle ?? path.basename(r.command)).join(', ')} on ${udid} records from ${early[0]!.devices.join(', ')}, not ${loopback}: a simulator's app keeps the input it started recording from, so nothing was played\nhint: start the sound before the recording: mic <sound> bg, then start the app's recording (mic wait waits for it to finish)`,
          );
        if (heardBy && !heardBy.length)
          throw new Error(
            `mic: no app on ${udid} recorded from ${loopback} within ${waitMs / 1000}s, so nothing was played\nhint: start the app's recording first (or give mic wait=<secs>, or bg to play when it starts); the Mac must allow the microphone to Simulator (System Settings › Privacy & Security › Microphone)`,
          );
        if (heardBy) mic.heardBy = heardBy;
        mic.started = Date.now();
        const r = await (this.#d.playTo ?? playTo)(wav, index, {signal: abort.signal, timeoutMs: mic.secs * 1000 + 15_000});
        return Object.assign(out, {
          seconds: Math.round(((Date.now() - mic.started) / 1000) * 10) / 10,
          waitedMs: mic.started - t0,
          ...(heardBy ? {heardBy: heardBy.join(', ')} : {note: 'could not tell whether the app records (the Mac audio helper did not run): played at once'}),
          ...(r.stopped ? {stopped: true} : {}),
          ...(r.timedOut ? {timedOut: true} : {}),
        });
      } finally {
        const restored: Restored | undefined = switched ? await sw.end().catch(e => ({input: 'unknown', note: (e as Error).message.split('\n')[0]})) : {input: previous};
        if (restored) Object.assign(out, {input: restored.input, ...(restored.note ? {inputNote: restored.note} : {})});
      }
    };
    this.#micErrors.delete(udid);
    this.#hostMic = udid;
    const forget = () => {
      if (this.#mics.get(udid) === mic) this.#mics.delete(udid);
      if (this.#hostMic === udid && !this.#mics.has(udid)) this.#hostMic = undefined;
    };
    this.#mics.set(udid, mic);
    if (!cmd.bg) {
      mic.done = play();
      try {
        return {udid, sound: label, ...((await mic.done) as object)};
      } finally {
        forget();
      }
    }
    mic.done = play()
      .catch(err => {
        this.#micErrors.set(udid, (err as Error).message.split('\n')[0]!);
        return undefined;
      })
      .finally(forget);
    return {udid, sound: label, secs: Math.round(mic.secs * 10) / 10, input: `${loopback} while it plays`, background: `plays as soon as an app records (waits up to ${waitMs / 1000}s); mic stop ends it, mic status tells where it is`};
  }

  /**
   * The apps of simulator `udid` recording from the device `uid`, waited for up to `ms`; undefined when that cannot be
   * told (the helper did not run), and the sound then plays at once.
   */
  async #macListeners(udid: string, uid: string, ms: number, signal: AbortSignal, recorders: () => Promise<(Recorder & {command: string})[] | undefined>): Promise<string[] | undefined> {
    const end = Date.now() + ms;
    for (;;) {
      const all = await recorders();
      if (!all) return undefined;
      const now = all.filter(r => r.devices.includes(uid) && inSimulator(r.command, udid)).map(r => r.bundle ?? path.basename(r.command));
      if (now.length || signal.aborted || Date.now() >= end) return now;
      await wait(250);
    }
  }

  // ---- capture --------------------------------------------------------------------------------------------------

  async capture(device: string | undefined, action: string, o: Record<string, string | number | boolean | undefined> = {}): Promise<Record<string, unknown>> {
    switch (action) {
      case 'start':
        return this.#start(device, o);
      case 'stop':
        return this.#stop(device, o);
      case 'frames':
        return this.#frames(device, o);
      case 'check':
        return this.check(device, typeof o.value === 'string' ? o.value : 'sound', typeof o.file === 'string' ? o.file : undefined);
      case 'status': {
        const t = await this.#d.target(device);
        const c = this.#captures.get(t.id);
        const last = this.#last.get(t.id);
        return {device: t.id, capture: c ? `${c.kind} for ${((Date.now() - c.started) / 1000).toFixed(1)}s` : 'none', ...(last ? {last: last.file} : {})};
      }
      default:
        throw new Error('capture start|stop|frames|check|status');
    }
  }

  async #start(device: string | undefined, o: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t = await this.#d.target(device);
    if (this.#captures.has(t.id)) throw new Error(`a capture already runs on ${t.id}\nhint: capture stop first`);
    const what = o.what === 'audio' ? 'audio' : 'screen';
    const fps = o.fps !== undefined ? Number(o.fps) : undefined;
    const size = typeof o.size === 'string' ? o.size : undefined;
    if (fps !== undefined && !(fps >= 1 && fps <= 60)) throw new Error('capture: fps is 1…60');
    if (size && !/^\d+(x\d+)?$/.test(size)) throw new Error('capture: size is WxH or a width (720x1280, 720)');
    const name = typeof o.name === 'string' ? o.name.replace(/[^\w.-]/g, '_') : `${stamp()}-${(t.id.length > 16 ? t.id.slice(0, 8) : t.id).replace(/[^\w-]/g, '_')}`;
    const notes: string[] = [];
    if (what === 'audio') {
      if (t.platform === 'apple') throw new Error(CANNOT.appleAudioOut);
      if (!isEmulator(t.id)) throw new Error(`audio capture: ${t.id} is not an emulator\nhint: ${CANNOT.device}`);
      if (t.a.running().find(x => x.serial === t.id)?.audio === false) throw new Error(`audio capture: ${t.id} runs without audio\nhint: boot it again with audio=true`);
      const audio = await captureAudio(t.id);
      const c: Capture = {kind: 'audio', started: Date.now(), file: path.join(this.#dir(), `${name}.wav`), audio, notes, stop: async () => {}};
      this.#captures.set(t.id, c);
      return {device: t.id, capture: 'audio', file: c.file};
    }
    if (t.platform === 'apple') {
      const s = t.s as AppleDevices & {xcrun?: string};
      if (!s.xcrun) throw new Error('screen capture of a remote Mac\'s simulator is not supported: run it on that Mac');
      const file = path.join(this.#dir(), `${name}.mov`);
      const child = spawn(s.xcrun, ['simctl', 'io', t.id, 'recordVideo', '--codec=h264', '--force', file], {stdio: ['ignore', 'ignore', 'pipe']});
      await started(child, /Recording started/, 15_000, 'simctl recordVideo');
      notes.push('no audio: simctl records the screen only');
      if (o.touches) notes.push('no touches: the simulator draws none into its recording');
      const c: Capture = {kind: 'screen', started: Date.now(), file, notes, post: fps || size ? {fps, size} : undefined, stop: () => endChild(child, 'SIGINT', 30_000)};
      this.#captures.set(t.id, c);
      return {device: t.id, capture: 'screen', file, notes};
    }
    const {a, id: serial} = t;
    let restoreTouches: string | undefined;
    if (o.touches) {
      restoreTouches = (await a.shell(serial, 'settings get system show_touches').catch(() => '0')).trim() || '0';
      await a.shell(serial, 'settings put system show_touches 1');
    }
    const untouch = async () => {
      if (restoreTouches !== undefined) await a.shell(serial, `settings put system show_touches ${restoreTouches === '1' ? 1 : 0}`).catch(() => undefined);
    };
    if (isEmulator(serial) && o.via !== 'device') {
      // The emulator records on the host, with what the device plays when it runs with audio: a WebM of up to 4 hours.
      const tmp = path.join(os.tmpdir(), `pitbox-rec-${randomUUID().slice(0, 8)}.webm`);
      const limit = Math.min(14400, Math.max(1, Number(o.limit ?? 3600)));
      const args = ['emu', 'screenrecord', 'start', ...(fps ? ['--fps', String(fps)] : []), ...(size ? ['--size', size.includes('x') ? size : `${size}x${size}`] : []), '--time-limit', String(limit), tmp];
      if (size && !size.includes('x')) throw new Error('capture: on an emulator give size as WxH');
      const r = await a.adb(args, serial, {timeoutMs: 15_000});
      if (!/OK/.test(r.stdout) || /KO/.test(r.stdout)) {
        await untouch();
        throw new Error(`capture: the emulator did not start recording: ${(r.stdout + r.stderr).trim().split('\n').slice(-2).join(' ')}`);
      }
      const hasAudio = a.running().find(x => x.serial === serial)?.audio !== false;
      if (!hasAudio) notes.push('no audio: the emulator runs with -no-audio (boot it with audio=true)');
      const file = path.join(this.#dir(), `${name}.webm`);
      const c: Capture = {
        kind: 'screen',
        started: Date.now(),
        file,
        notes,
        stop: async () => {
          await a.adb(['emu', 'screenrecord', 'stop'], serial, {timeoutMs: 15_000}).catch(() => undefined);
          await settled(tmp, 20_000);
          await untouch();
          if (fs.existsSync(tmp)) moveFile(tmp, file);
        },
      };
      this.#captures.set(t.id, c);
      return {device: serial, capture: 'screen', file, ...(notes.length ? {notes} : {})};
    }
    // A phone (or via=device): the device's own screenrecord, an MP4 without sound, at most 3 minutes.
    const remote = `/sdcard/pitbox-rec-${randomUUID().slice(0, 8)}.mp4`;
    const child = spawn(a.adbPath, ['-s', serial, 'shell', 'screenrecord', ...(size && size.includes('x') ? ['--size', size] : []), '--time-limit', '180', remote], {stdio: 'ignore'});
    await wait(800);
    notes.push('no audio: a device records its screen only', 'at most 3 minutes (screenrecord\'s limit)');
    const file = path.join(this.#dir(), `${name}.mp4`);
    const c: Capture = {
      kind: 'screen',
      started: Date.now(),
      file,
      notes,
      post: fps ? {fps} : undefined,
      stop: async () => {
        // SIGINT lets screenrecord finish its MP4; the file is whole once the process is gone.
        await a.shell(serial, 'pkill -INT screenrecord').catch(() => undefined);
        for (let i = 0; i < 40 && (await a.shell(serial, 'pidof screenrecord').catch(() => '')).trim(); i++) await wait(250);
        await endChild(child, 'SIGTERM', 5_000);
        await a.adb(['pull', remote, file], serial, {timeoutMs: 120_000});
        await a.shell(serial, `rm -f ${remote}`).catch(() => undefined);
        await untouch();
      },
    };
    this.#captures.set(t.id, c);
    return {device: serial, capture: 'screen', file, notes};
  }

  async #stop(device: string | undefined, o: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t = await this.#d.target(device);
    const c = this.#captures.get(t.id);
    if (!c) throw new Error(`no capture runs on ${t.id}\nhint: capture start [screen|audio]`);
    this.#captures.delete(t.id);
    const wall = (Date.now() - c.started) / 1000;
    let file = c.file;
    let pcm: Pcm | undefined;
    if (c.audio) {
      const r = await c.audio.stop();
      pcm = r.pcm;
      fs.writeFileSync(file, encodeWav(pcm));
    } else {
      await c.stop();
      if (!fs.existsSync(file)) throw new Error(`capture: the recording did not reach ${file}`);
      if (c.post && ffmpegPath()) {
        const out = file.replace(/\.\w+$/, '.mp4') === file ? file.replace(/\.mp4$/, '-sized.mp4') : file.replace(/\.\w+$/, '.mp4');
        await reencode(file, out, c.post);
        fs.rmSync(file);
        file = out;
      } else if (c.post) c.notes.push(`fps/size not applied: ${NO_FFMPEG}`);
      pcm = ffmpegPath() ? await audioOf(file).catch(() => undefined) : undefined;
      if (!ffmpegPath()) c.notes.push(`no audio check: ${NO_FFMPEG}`);
    }
    const probed = c.kind === 'screen' && ffmpegPath() ? await probeDuration(file).catch(() => undefined) : undefined;
    // The simulator writes a frame only when the screen changes: a still end leaves the file shorter than the capture.
    if (probed !== undefined && probed < wall - 1) c.notes.push(`the file lasts ${probed.toFixed(1)}s: the screen stood still after that (frames are written only on change)`);
    const secs = c.kind === 'audio' ? seconds(pcm!) : (probed !== undefined && probed < wall - 1 ? probed : wall);
    const report = pcm ? analyze(pcm) : undefined;
    this.#last.set(t.id, {file, pcm, report, secs});
    const out: Record<string, unknown> = {device: t.id, file, secs: Math.round(secs * 10) / 10, bytes: fs.statSync(file).size};
    if (report) out.audio = describe(report);
    else if (c.kind === 'screen' && pcm === undefined && ffmpegPath()) out.audio = 'no audio track';
    if (c.notes.length) out.notes = c.notes;
    if (o.transcribe) out.said = await this.#transcribe(t.id);
    return out;
  }

  async #frames(device: string | undefined, o: Record<string, unknown>): Promise<Record<string, unknown>> {
    const file = await this.#lastFile(device, typeof o.file === 'string' ? o.file : undefined);
    if (/\.wav$/i.test(file)) throw new Error('capture frames: the last capture is audio only');
    const dir = file.replace(/\.\w+$/, '-frames');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/^frame-\d+\.jpg$/.test(f)) fs.rmSync(path.join(dir, f));
    const frames = await extractFrames(file, dir, {every: o.every !== undefined ? parseSecs(String(o.every)) : undefined, count: o.count !== undefined ? Number(o.count) : undefined, width: o.width !== undefined ? Number(o.width) : undefined});
    return {file, dir, frames: frames.length, names: frames.map(f => path.basename(f))};
  }

  async #lastFile(device: string | undefined, file?: string): Promise<string> {
    if (file) {
      const f = path.resolve(this.#d.root(), file);
      if (!fs.existsSync(f)) throw new Error(`no file ${f}`);
      return f;
    }
    const t = await this.#d.target(device);
    const last = this.#last.get(t.id);
    if (!last) throw new Error(`no capture on ${t.id} yet\nhint: capture start, then capture stop`);
    return last.file;
  }

  /** Checks the sound of the last capture (or `file`): `sound min=1s level=-30 freq=880`, `silence`, `said "words"`. */
  async check(device: string | undefined, value: string, file?: string): Promise<Record<string, unknown>> {
    const e = parseAudioExpect(value);
    let last: Last;
    if (file) {
      const f = path.resolve(this.#d.root(), file);
      const pcm = /\.wav$/i.test(f) ? decodeWav(fs.readFileSync(f)) : await audioOf(f);
      last = {file: f, pcm, report: pcm ? analyze(pcm) : undefined};
    } else {
      const t = await this.#d.target(device);
      const l = this.#last.get(t.id);
      if (!l) throw new Error(`no capture on ${t.id} yet\nhint: capture start screen|audio, then capture stop`);
      last = l;
    }
    if (!last.report || !last.pcm) throw new Error(`${path.basename(last.file)} has no audio track${ffmpegPath() ? '' : ` (or: ${NO_FFMPEG})`}`);
    const freq = e.freq !== undefined ? dominantFreq(last.pcm) : undefined;
    const miss = audioMisses(last.report, e, freq);
    let said: string | undefined;
    if (e.said !== undefined) {
      said = await this.#transcribeLast(last);
      if (!said.toLowerCase().includes(e.said.toLowerCase())) miss.push(`said ${JSON.stringify(said.slice(0, 200))}, not ${JSON.stringify(e.said)}`);
    }
    if (miss.length) throw new Error(`audio: ${miss.join('; ')}\n${describe(last.report)} (${last.file})`);
    return {ok: true, audio: describe(last.report), ...(freq ? {freq} : {}), ...(said !== undefined ? {said} : {})};
  }

  async #transcribe(id: string): Promise<string> {
    const last = this.#last.get(id);
    if (!last) throw new Error('nothing captured to transcribe');
    return this.#transcribeLast(last);
  }

  async #transcribeLast(last: Last): Promise<string> {
    const cmd = this.#d.transcribe?.();
    if (!cmd) throw new Error('no transcript hook: set media.transcribe in the config to a command that prints what {file} (a 16 kHz mono WAV) says');
    if (!last.pcm) throw new Error('the capture has no audio to transcribe');
    const wav = path.join(this.#dir(), `${path.basename(last.file).replace(/\.\w+$/, '')}-16k.wav`);
    fs.writeFileSync(wav, encodeWav(convert(last.pcm, 16000, 1)));
    const r = await runShell(cmd.replaceAll('{file}', JSON.stringify(wav)), {cwd: this.#d.root(), timeoutMs: 300_000});
    if (r.code !== 0) throw new Error(`transcript hook exited ${r.code}: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
    return r.stdout.trim();
  }

  // ---- camera, library, calls, volume -------------------------------------------------------------------------

  async camera(device: string | undefined, value: string): Promise<Record<string, unknown>> {
    const {serial, a} = await this.#android(device, 'appleCamera');
    const {plain} = words(value);
    const [op, ...rest] = plain;
    const running = a.running().find(x => x.serial === serial);
    if (!isEmulator(serial)) throw new Error(`camera: ${serial} is not an emulator\nhint: ${CANNOT.device}`);
    if (!op || op === 'status') return {serial, camera: running?.camera ?? 'as its AVD says (hw.camera.back)'};
    if (op === 'image' || op === 'video') {
      if (!rest[0]) throw new Error(`camera ${op} <file>`);
      const file = path.resolve(this.#d.root(), rest[0]);
      if (!fs.existsSync(file)) throw new Error(`camera: no file ${file}`);
      swapFeed(running?.camera, file, op);
      return {serial, camera: `${op} ${path.basename(file)}`, note: 'shown the next time an app opens the camera'};
    }
    if (op === 'scene') {
      const [wall, img] = rest;
      if (wall !== 'wall' && wall !== 'table') throw new Error('camera scene wall|table <image>|default');
      if (running?.camera && running.camera !== 'virtualscene') throw new Error(`camera scene: this emulator's camera is ${running.camera}, not the virtual scene\nhint: boot it with camera=virtualscene`);
      const file = img && img !== 'default' ? path.resolve(this.#d.root(), img) : undefined;
      if (file && !fs.existsSync(file)) throw new Error(`camera: no file ${file}`);
      const r = await a.adb(['emu', 'virtualscene-image', wall, ...(file ? [file] : [])], serial, {timeoutMs: 10_000});
      if (/KO/.test(r.stdout)) throw new Error(`camera scene: ${r.stdout.trim()}`);
      return {serial, camera: `scene ${wall} ${file ? path.basename(file) : 'default'}`};
    }
    throw new Error('camera status | image <file> | video <file> | scene wall|table <image>|default');
  }

  async library(device: string | undefined, value: string): Promise<Record<string, unknown>> {
    const {plain} = words(value);
    const [op, ...files] = plain;
    const t = await this.#d.target(device);
    if (op !== 'add') throw new Error('library add <file…> (photos and videos into the gallery)');
    if (!files.length) throw new Error('library add <file…>');
    const abs = files.map(f => path.resolve(this.#d.root(), f));
    for (const f of abs) if (!fs.existsSync(f)) throw new Error(`library: no file ${f}`);
    if (t.platform === 'apple') {
      const s = t.s as AppleDevices & {simctl?: (args: string[], o?: {timeoutMs?: number}) => Promise<{code: number | null; stderr: string; stdout: string}>};
      if (!s.simctl) throw new Error('library add on a remote Mac\'s simulator is not supported');
      const r = await s.simctl(['addmedia', t.id, ...abs], {timeoutMs: 120_000});
      if (r.code !== 0) throw new Error(`simctl addmedia failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
      return {udid: t.id, added: abs.map(f => path.basename(f))};
    }
    const {a, id: serial} = t;
    const added: string[] = [];
    for (const f of abs) {
      const dir = /\.(mp4|webm|mkv|mov|3gp|avi)$/i.test(f) ? 'Movies' : /\.(mp3|m4a|aac|ogg|wav|flac|opus)$/i.test(f) ? 'Music' : 'Pictures';
      const remote = `/sdcard/${dir}/pitbox/${path.basename(f).replace(/[^\w.-]/g, '_')}`;
      await a.shell(serial, `mkdir -p /sdcard/${dir}/pitbox`);
      const r = await a.adb(['push', f, remote], serial, {timeoutMs: 300_000});
      if (r.code !== 0) throw new Error(`library: push failed: ${(r.stderr || r.stdout).trim()}`);
      // The media scanner puts it in MediaStore, where galleries and pickers look.
      await a.shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remote}`);
      added.push(remote);
    }
    return {serial, added};
  }

  async call(device: string | undefined, value: string): Promise<Record<string, unknown>> {
    const {serial, a} = await this.#android(device, 'appleCall');
    if (!isEmulator(serial)) throw new Error(`call: ${serial} is not an emulator\nhint: ${CANNOT.device}`);
    const {plain} = words(value);
    const [op = 'list', number] = plain;
    const num = (number ?? this.#lastCall.get(serial) ?? '5551234').replace(/[^\d+]/g, '');
    const gsm = async (...args: string[]) => {
      const r = await a.adb(['emu', 'gsm', ...args], serial, {timeoutMs: 10_000});
      const text = (r.stdout + r.stderr).trim();
      if (/KO/.test(text) || r.code !== 0) throw new Error(`call ${op}: ${text.replace(/\r?\nOK$/, '')}`);
      return text.replace(/\r/g, '').split('\n').filter(l => l && l !== 'OK');
    };
    switch (op) {
      case 'incoming':
        await gsm('call', num);
        this.#lastCall.set(serial, num);
        return {serial, call: `incoming from ${num}`, note: 'ringing: answer or decline on the device, or call end'};
      case 'end':
        await gsm('cancel', num);
        return {serial, call: `ended ${num}`};
      case 'busy':
        await gsm('busy', num);
        return {serial, call: `${num} busy`};
      case 'hold':
        await gsm('hold', num);
        return {serial, call: `${num} held`};
      case 'accept':
        await gsm('accept', num);
        return {serial, call: `${num} answered`};
      case 'list':
        return {serial, calls: (await gsm('list')).join(' · ') || 'none'};
      default:
        throw new Error('call incoming [number] | end | busy | hold | accept (an outgoing call) | list');
    }
  }

  async audio(device: string | undefined, value: string): Promise<Record<string, unknown>> {
    const {serial, a} = await this.#android(device, 'appleVolume');
    const {plain} = words(value);
    const [op, x, y] = plain;
    const streams: Record<string, number> = {call: 0, system: 1, ring: 2, music: 3, media: 3, alarm: 4, notification: 5};
    const stream = (name?: string) => {
      const n = streams[name ?? 'music'];
      if (n === undefined) throw new Error(`audio: streams are ${Object.keys(streams).join(', ')}`);
      return n;
    };
    if (op === 'ringer') {
      const mode = (x ?? '').toUpperCase();
      if (!['NORMAL', 'SILENT', 'VIBRATE'].includes(mode)) throw new Error('audio ringer normal|silent|vibrate');
      await a.shell(serial, `cmd audio set-ringer-mode ${mode}`);
      return {serial, ringer: mode.toLowerCase()};
    }
    if (op === 'volume') {
      // audio volume [stream] <n|max|mute|unmute>
      const [name, level] = y === undefined ? ['music', x] : [x, y];
      const n = stream(name);
      if (level === 'mute' || level === 'unmute') await a.shell(serial, `cmd audio adj-${level} ${n}`);
      else {
        const max = Number((await a.shell(serial, `cmd audio get-max-volume ${n}`)).match(/(\d+)\s*$/)?.[1] ?? 15);
        const v = level === 'max' ? max : Number(level);
        if (!Number.isFinite(v) || v < 0 || v > max) throw new Error(`audio volume ${name}: 0…${max}, max, mute or unmute`);
        await a.shell(serial, `cmd audio set-volume ${n} ${v}`);
      }
    }
    if (op !== 'volume' && op !== 'status' && op !== undefined) throw new Error('audio volume [stream] <n|max|mute|unmute> | ringer normal|silent|vibrate | status');
    const out: Record<string, string> = {};
    for (const [name, n] of Object.entries(streams)) {
      if (name === 'media') continue;
      const v = (await a.shell(serial, `cmd audio get-stream-volume ${n}`)).match(/(\d+)\s*$/)?.[1];
      out[name] = v ?? '?';
    }
    return {serial, volumes: Object.entries(out).map(([k, v]) => `${k} ${v}`).join(' · ')};
  }

  /** Ends what runs in the background: microphone sounds and captures (their touches setting restored). */
  async stopAll() {
    for (const m of this.#mics.values()) m.abort.abort();
    // A sound on an iOS simulator puts the Mac's input back as it ends: wait for that (a few seconds at most).
    const host = this.#hostMic ? this.#mics.get(this.#hostMic) : undefined;
    if (host) await Promise.race([host.done.catch(() => undefined), wait(5000)]);
    this.#input?.endSync();
    for (const [id, c] of this.#captures) {
      this.#captures.delete(id);
      await (c.audio ? c.audio.stop() : c.stop()).catch(() => undefined);
    }
  }
}

/** Waits for a child's stderr to say it started, or fails with what it said. */
const started = (child: ChildProcess, ready: RegExp, ms: number, what: string) =>
  new Promise<void>((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGINT');
      reject(new Error(`${what} did not start in ${ms / 1000}s: ${err.trim().split('\n').slice(-2).join(' ')}`));
    }, ms);
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
      if (ready.test(err)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`${what} ended (${code}): ${err.trim().split('\n').slice(-2).join(' ')}`));
    });
  });

const endChild = (child: ChildProcess, signal: NodeJS.Signals, ms: number) =>
  new Promise<void>(resolve => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill(signal);
  });

/** Waits until a file stops growing (the emulator finishes writing its recording after stop). */
const settled = async (file: string, ms: number) => {
  const end = Date.now() + ms;
  let last = -1;
  let same = 0;
  while (Date.now() < end) {
    const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
    if (size > 0 && size === last) {
      if (++same >= 3) return;
    } else same = 0;
    last = size;
    await wait(300);
  }
};

const moveFile = (from: string, to: string) => {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.rmSync(from);
  }
};
