// The iOS simulator's microphone, fed through a loopback audio device on the Mac. A simulator records from the Mac's
// default input device and simctl takes no sound, so `mic` on iOS switches the Mac's input to a loopback driver
// (BlackHole 2ch by default, `media.loopback`), plays the sound to that driver's output only (the Mac's own output
// is never touched) and puts the previous input back when the sound ends — on success, error, `mic stop`, a timeout
// and a daemon exit. The previous input is written down in pitbox's home first, so a daemon that died mid-sound is
// cleaned up by the next one; an input someone else picked while the sound played is left alone.
//
// The input is switched with SwitchAudioSource (brew install switchaudio-osx); the sound plays through ffmpeg's
// AudioToolbox output with the loopback chosen by index. Whether an app records is read from Core Audio's process
// list by a small Swift helper (runners/apple/Audio).

import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pitboxHome} from '../lease/lease.ts';
import {run, which} from '../util/proc.ts';
import {ffmpegPath, NO_FFMPEG} from './ffmpeg.ts';

export const DEFAULT_LOOPBACK = 'BlackHole 2ch';

export const NO_SWITCHAUDIO = 'mic on iOS switches the Mac\'s input with SwitchAudioSource, which is not installed\nhint: brew install switchaudio-osx (or set PITBOX_SWITCHAUDIO to its path)';

export const noLoopback = (name: string, inputs: string[]) =>
  `mic on iOS: the Mac has no input device "${name}" (it has: ${inputs.join(', ') || 'none'})\nhint: install a loopback driver (brew install blackhole-2ch, then restart coreaudiod or log in again), or name yours in the config: media: {loopback: '<device name>'}`;

export const switchAudioPath = (): string | undefined => {
  const own = process.env.PITBOX_SWITCHAUDIO;
  if (own && fs.existsSync(own)) return own;
  return which('SwitchAudioSource') ?? ['/opt/homebrew/bin/SwitchAudioSource', '/usr/local/bin/SwitchAudioSource'].find(p => fs.existsSync(p));
};

export type AudioDevice = {name: string; uid: string};

/** SwitchAudioSource's `-f json` lines: one JSON object per device. */
export const parseDevices = (out: string): AudioDevice[] =>
  out
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('{'))
    .flatMap(l => {
      try {
        const d = JSON.parse(l) as {name?: string; uid?: string};
        return d.name ? [{name: d.name, uid: d.uid ?? ''}] : [];
      } catch {
        return [];
      }
    });

/** The Mac's audio inputs, read and switched; a seam for tests. */
export type HostInput = {
  current(): Promise<AudioDevice | undefined>;
  set(name: string): Promise<void>;
  inputs(): Promise<AudioDevice[]>;
  /** The same, without awaiting: for a process that is exiting. */
  currentSync(): string | undefined;
  setSync(name: string): void;
};

export const switchAudio = (bin = switchAudioPath()): HostInput => {
  const need = () => {
    if (!bin) throw new Error(NO_SWITCHAUDIO);
    return bin;
  };
  const call = async (args: string[]) => {
    const r = await run(need(), args, {timeoutMs: 10_000});
    if (r.code !== 0) throw new Error(`SwitchAudioSource ${args.join(' ')}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    return r.stdout;
  };
  return {
    current: async () => parseDevices(await call(['-c', '-t', 'input', '-f', 'json']))[0],
    set: async name => void (await call(['-t', 'input', '-s', name])),
    inputs: async () => parseDevices(await call(['-a', '-t', 'input', '-f', 'json'])),
    currentSync: () => {
      if (!bin) return undefined;
      const r = spawnSync(bin, ['-c', '-t', 'input', '-f', 'json'], {encoding: 'utf8', timeout: 5000});
      return parseDevices(r.stdout ?? '')[0]?.name;
    },
    setSync: name => {
      if (bin) spawnSync(bin, ['-t', 'input', '-s', name], {timeout: 5000});
    },
  };
};

/** What is written down while the input is switched: enough for anyone to put it back. */
export type SwitchState = {previous: string; loopback: string; pid: number; at: string};

export type Restored = {input: string; note?: string};

const alivePid = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The Mac's input switched to the loopback for the length of one sound, and put back after. The previous input is
 * written to `file` before the switch, so a process that dies mid-sound leaves what the next one needs.
 */
export class InputSwitch {
  readonly #host: HostInput;
  readonly #file: string;
  readonly #alive: (pid: number) => boolean;
  readonly #pid: number;

  constructor(host: HostInput, o: {file?: string; alive?: (pid: number) => boolean; pid?: number} = {}) {
    this.#host = host;
    this.#file = o.file ?? path.join(pitboxHome(), 'mic-input.json');
    this.#alive = o.alive ?? alivePid;
    this.#pid = o.pid ?? process.pid;
  }

  get file() {
    return this.#file;
  }

  state(): SwitchState | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.#file, 'utf8')) as SwitchState;
    } catch {
      return undefined;
    }
  }

  #write(s: SwitchState) {
    fs.mkdirSync(path.dirname(this.#file), {recursive: true});
    fs.writeFileSync(this.#file, JSON.stringify(s));
  }

  #clear() {
    fs.rmSync(this.#file, {force: true});
  }

  /** The input a dead process left switched, put back. Answers undefined when there was nothing to do. */
  async recover(): Promise<Restored | undefined> {
    const s = this.state();
    if (!s || (s.pid !== this.#pid && this.#alive(s.pid))) return undefined;
    return this.#putBack(s);
  }

  /**
   * Switches the Mac's input to `loopback`. Answers what it was, and whether it was switched (an input that already is
   * the loopback stays, and nothing is put back after).
   */
  async begin(loopback: string): Promise<{previous: string; switched: boolean}> {
    await this.recover();
    const held = this.state();
    if (held && held.pid !== this.#pid) throw new Error(`mic: the Mac's input is switched to ${held.loopback} by another pitbox (pid ${held.pid}) while it plays a sound\nhint: wait for it, or mic stop there`);
    const inputs = await this.#host.inputs();
    if (!inputs.some(d => d.name === loopback)) throw new Error(noLoopback(loopback, inputs.map(d => d.name)));
    const previous = (await this.#host.current())?.name;
    if (!previous) throw new Error('mic: could not read the Mac\'s current input device');
    // Our own earlier switch (a sound that replaced another): the input to put back is the one written then.
    if (held) return {previous: held.previous, switched: true};
    if (previous === loopback) return {previous, switched: false};
    this.#write({previous, loopback, pid: this.#pid, at: new Date().toISOString()});
    try {
      await this.#host.set(loopback);
      const now = (await this.#host.current())?.name;
      if (now !== loopback) throw new Error(`mic: the Mac's input stayed ${now ?? 'unknown'} after switching it to ${loopback}`);
    } catch (e) {
      await this.#putBack({previous, loopback, pid: this.#pid, at: ''}).catch(() => undefined);
      throw e;
    }
    return {previous, switched: true};
  }

  /** Puts the previous input back, unless someone chose another one meanwhile. */
  async end(): Promise<Restored | undefined> {
    const s = this.state();
    if (!s || s.pid !== this.#pid) return undefined;
    return this.#putBack(s);
  }

  async #putBack(s: SwitchState): Promise<Restored> {
    const now = (await this.#host.current())?.name;
    if (now !== s.loopback) {
      this.#clear();
      return {input: now ?? 'unknown', note: `the input was changed to ${now ?? 'another device'} while the sound played: left as it is`};
    }
    await this.#host.set(s.previous);
    const after = (await this.#host.current())?.name;
    if (after !== s.previous) return {input: after ?? 'unknown', note: `could not put the input back to ${s.previous}: it is ${after ?? 'unknown'} (still written in ${this.#file})`};
    this.#clear();
    return {input: s.previous};
  }

  /** The same as end, without awaiting: from a process's exit handler. */
  endSync(): void {
    const s = this.state();
    if (!s || s.pid !== this.#pid) return;
    const now = this.#host.currentSync();
    if (now === s.loopback) this.#host.setSync(s.previous);
    else if (now === undefined) return;
    if (now !== s.loopback || this.#host.currentSync() === s.previous) this.#clear();
  }
}

// ---- playing to one device ---------------------------------------------------------------------------------------

/** The index ffmpeg's AudioToolbox output gives the device with `uid` (its listing: `[2]  BlackHole 2ch, <uid>`). */
export const deviceIndex = (listing: string, uid: string): number | undefined => {
  for (const line of listing.split('\n')) {
    const m = /\[(\d+)\]\s+(.*?),\s*(\S+)\s*$/.exec(line.replace(/^\[AudioToolbox @ [^\]]+\]\s*/, ''));
    if (m && m[3] === uid) return Number(m[1]);
  }
  return undefined;
};

/**
 * The arguments that list ffmpeg's AudioToolbox devices. The source is silence and lasts no time, so the listing
 * plays nothing on the default output it opens.
 */
export const listArgs = (): string[] => ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.01', '-f', 'audiotoolbox', '-list_devices', 'true', '-'];

/** The arguments that play a WAV from stdin to the AudioToolbox device at `index`, as 48 kHz stereo, in real time. */
export const playArgs = (index: number): string[] => ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'wav', '-i', 'pipe:0', '-ac', '2', '-ar', '48000', '-f', 'audiotoolbox', '-audio_device_index', String(index), '-'];

/** The index of `uid` among ffmpeg's AudioToolbox devices. */
export const outputIndex = async (uid: string, name: string): Promise<number> => {
  const ff = ffmpegPath();
  if (!ff) throw new Error(`mic on iOS plays through ffmpeg\nhint: ${NO_FFMPEG}`);
  const r = await run(ff, listArgs(), {timeoutMs: 20_000});
  const i = deviceIndex(r.stderr, uid);
  if (i === undefined) throw new Error(`mic on iOS: ffmpeg's AudioToolbox output lists no device ${name} (${uid})\nhint: an ffmpeg built with AudioToolbox (Homebrew's is) is needed`);
  return i;
};

/** Plays `wav` to the device at `index`; resolves when it has played, rejects on an error; abort stops it. */
export const playTo = (wav: Buffer, index: number, o: {signal: AbortSignal; timeoutMs: number}): Promise<{stopped?: boolean; timedOut?: boolean}> =>
  new Promise((resolve, reject) => {
    const ff = ffmpegPath();
    if (!ff) return reject(new Error(`mic on iOS plays through ffmpeg\nhint: ${NO_FFMPEG}`));
    const child: ChildProcess = spawn(ff, playArgs(index), {stdio: ['pipe', 'ignore', 'pipe']});
    let err = '';
    let why: 'stopped' | 'timedOut' | undefined;
    const kill = (w: 'stopped' | 'timedOut') => {
      why ??= w;
      child.kill('SIGKILL');
    };
    const onAbort = () => kill('stopped');
    o.signal.addEventListener('abort', onAbort, {once: true});
    if (o.signal.aborted) kill('stopped');
    const timer = setTimeout(() => kill('timedOut'), o.timeoutMs);
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(wav);
    child.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      if (why === 'stopped') resolve({stopped: true});
      else if (why === 'timedOut') resolve({timedOut: true});
      else if (code === 0) resolve({});
      else reject(new Error(`mic: ffmpeg could not play to the loopback: ${err.trim().split('\n').slice(-2).join(' ') || `exit ${code}`}`));
    });
  });

// ---- who records -------------------------------------------------------------------------------------------------

export type Recorder = {pid: number; bundle?: string; devices: string[]};

/** The helper's lines: `<pid>\t<bundle or ->\t<device uids, comma-separated>`. */
export const parseRecorders = (out: string): Recorder[] =>
  out
    .split('\n')
    .filter(l => /^\d+\t/.test(l))
    .map(l => {
      const [pid, bundle, devices] = l.split('\t');
      return {pid: Number(pid), ...(bundle && bundle !== '-' ? {bundle} : {}), devices: devices ? devices.split(',').filter(Boolean) : []};
    });

/** Whether a process runs inside the simulator `udid`: its executable lives under that device's folder. */
export const inSimulator = (command: string, udid: string) => command.includes(`/Devices/${udid}/`);
