import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {deviceIndex, InputSwitch, inSimulator, listArgs, parseDevices, parseRecorders, playArgs, type AudioDevice, type HostInput} from './media/loopback.ts';
import {MediaCenter, type MediaTarget} from './media/center.ts';
import {parseMic} from './media/sound.ts';
import {micPlaysHere} from './cli.ts';

const LOOP = {name: 'BlackHole 2ch', uid: 'BlackHole2ch_UID'};
const HEADSET = {name: 'USB Headset', uid: 'headset-in'};
const BUILTIN = {name: 'MacBook Microphone', uid: 'BuiltInMicrophoneDevice'};

/** A Mac's inputs in memory: what is current, what was set, in order. */
const fakeHost = (start: AudioDevice = HEADSET, devices: AudioDevice[] = [HEADSET, BUILTIN, LOOP]) => {
  const h = {
    now: start.name,
    sets: [] as string[],
    failSet: false,
    host: undefined as unknown as HostInput,
  };
  h.host = {
    current: async () => devices.find(d => d.name === h.now),
    set: async name => {
      h.sets.push(name);
      if (!h.failSet) h.now = name;
    },
    inputs: async () => devices,
    currentSync: () => h.now,
    setSync: name => {
      h.sets.push(name);
      h.now = name;
    },
  };
  return h;
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-loopback-'));
});
afterEach(() => {
  fs.rmSync(dir, {recursive: true, force: true});
});

describe('loopback devices and arguments', () => {
  it('reads SwitchAudioSource json lines', () => {
    const out = '{"name": "USB Headset", "type": "input", "id": "109", "uid": "headset-in"}\n{"name": "BlackHole 2ch", "type": "input", "id": "85", "uid": "BlackHole2ch_UID"}\n';
    expect(parseDevices(out)).toEqual([HEADSET, LOOP]);
    expect(parseDevices('garbage\n{not json')).toEqual([]);
  });

  it("finds a device's index in ffmpeg's AudioToolbox listing by its uid, also when its name is null", () => {
    const listing = [
      '[AudioToolbox @ 0x751cc283c0] CoreAudio devices:',
      '[AudioToolbox @ 0x751cc283c0] [0]          USB Headset, headset-in',
      '[AudioToolbox @ 0x751cc283c0] [1]          USB Headset, headset-out',
      '[AudioToolbox @ 0x751cc283c0] [2]                  BlackHole 2ch, BlackHole2ch_UID',
      '[AudioToolbox @ 0x751cc283c0] [3]                         (null), BuiltInMicrophoneDevice',
    ].join('\n');
    expect(deviceIndex(listing, 'BlackHole2ch_UID')).toBe(2);
    expect(deviceIndex(listing, 'BuiltInMicrophoneDevice')).toBe(3);
    expect(deviceIndex(listing, 'nope')).toBeUndefined();
  });

  it('plays to the chosen device only, and lists devices from silence', () => {
    const a = playArgs(2);
    expect(a.slice(a.indexOf('-f', 6))).toEqual(['-f', 'audiotoolbox', '-audio_device_index', '2', '-']);
    expect(a).toContain('pipe:0');
    // The listing opens the default output: its source must be silence that lasts no time.
    const l = listArgs();
    expect(l[l.indexOf('-i') + 1]).toMatch(/^anullsrc/);
    expect(l).toContain('-list_devices');
    expect(l).not.toContain('-audio_device_index');
  });

  it('reads who records, and tells a simulator app by its path', () => {
    const r = parseRecorders('1089\tcom.example.browser\tBuiltInMicrophoneDevice,headset-in\n4242\t-\tBlackHole2ch_UID\nnoise\n');
    expect(r).toEqual([
      {pid: 1089, bundle: 'com.example.browser', devices: ['BuiltInMicrophoneDevice', 'headset-in']},
      {pid: 4242, devices: ['BlackHole2ch_UID']},
    ]);
    const udid = '0A1B2C3D-0000-4000-8000-000000000001';
    expect(inSimulator(`/Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/X/MyApp.app/MyApp`, udid)).toBe(true);
    expect(inSimulator('/Applications/Browser.app/Contents/MacOS/Browser', udid)).toBe(false);
  });

  it('takes force on a mic value, and Ctrl-C stops only a sound played in the foreground', () => {
    expect(parseMic('hello.wav force')).toMatchObject({op: 'play', force: true});
    expect(parseMic('hello.wav')).not.toHaveProperty('force');
    expect(micPlaysHere('hello.wav noise=pink')).toBe(true);
    expect(micPlaysHere('hello.wav bg')).toBe(false);
    expect(micPlaysHere('stop')).toBe(false);
    expect(micPlaysHere('status')).toBe(false);
  });
});

describe('InputSwitch', () => {
  it('switches to the loopback, writes down the previous input, and puts it back', async () => {
    const h = fakeHost();
    const sw = new InputSwitch(h.host, {file: path.join(dir, 's.json'), pid: 100, alive: () => true});
    expect(await sw.begin(LOOP.name)).toEqual({previous: HEADSET.name, switched: true});
    expect(h.now).toBe(LOOP.name);
    expect(sw.state()).toMatchObject({previous: HEADSET.name, loopback: LOOP.name, pid: 100});
    expect(await sw.end()).toEqual({input: HEADSET.name});
    expect(h.now).toBe(HEADSET.name);
    expect(sw.state()).toBeUndefined();
  });

  it('leaves an input someone else chose while the sound played', async () => {
    const h = fakeHost();
    const sw = new InputSwitch(h.host, {file: path.join(dir, 's.json'), pid: 100});
    await sw.begin(LOOP.name);
    h.now = BUILTIN.name;
    const r = await sw.end();
    expect(r?.input).toBe(BUILTIN.name);
    expect(r?.note).toMatch(/left as it is/);
    expect(h.sets).toEqual([LOOP.name]);
    expect(sw.state()).toBeUndefined();
  });

  it('does not switch, nor put back, an input that already is the loopback', async () => {
    const h = fakeHost(LOOP);
    const sw = new InputSwitch(h.host, {file: path.join(dir, 's.json'), pid: 100});
    expect(await sw.begin(LOOP.name)).toEqual({previous: LOOP.name, switched: false});
    expect(h.sets).toEqual([]);
    expect(await sw.end()).toBeUndefined();
  });

  it('refuses a missing loopback with how to install one, and switches nothing', async () => {
    const h = fakeHost(HEADSET, [HEADSET, BUILTIN]);
    const sw = new InputSwitch(h.host, {file: path.join(dir, 's.json'), pid: 100});
    await expect(sw.begin(LOOP.name)).rejects.toThrow(/no input device "BlackHole 2ch".*\n.*brew install blackhole-2ch.*media: \{loopback/s);
    expect(h.sets).toEqual([]);
    expect(sw.state()).toBeUndefined();
  });

  it('puts the input back when the switch did not take', async () => {
    const h = fakeHost();
    h.failSet = true;
    const sw = new InputSwitch(h.host, {file: path.join(dir, 's.json'), pid: 100});
    await expect(sw.begin(LOOP.name)).rejects.toThrow(/stayed USB Headset/);
    expect(h.now).toBe(HEADSET.name);
    expect(sw.state()).toBeUndefined();
  });

  it('puts back an input that a dead process left switched, and leaves a live one alone', async () => {
    const file = path.join(dir, 's.json');
    const h = fakeHost(LOOP);
    fs.writeFileSync(file, JSON.stringify({previous: HEADSET.name, loopback: LOOP.name, pid: 7, at: ''}));
    const live = new InputSwitch(h.host, {file, pid: 100, alive: () => true});
    expect(await live.recover()).toBeUndefined();
    await expect(live.begin(LOOP.name)).rejects.toThrow(/another pitbox \(pid 7\)/);
    expect(h.now).toBe(LOOP.name);
    const after = new InputSwitch(h.host, {file, pid: 100, alive: () => false});
    expect(await after.recover()).toEqual({input: HEADSET.name});
    expect(h.now).toBe(HEADSET.name);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('puts the input back synchronously on exit', async () => {
    const h = fakeHost();
    const sw = new InputSwitch(h.host, {file: path.join(dir, 's.json'), pid: 100});
    await sw.begin(LOOP.name);
    sw.endSync();
    expect(h.now).toBe(HEADSET.name);
    expect(sw.state()).toBeUndefined();
  });
});

describe('mic on an iOS simulator', () => {
  const udid = '0A1B2C3D-0000-4000-8000-000000000001';
  const appPath = `/Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/X/MyApp.app/MyApp`;
  const setup = (o: {recording?: () => boolean; others?: boolean; early?: boolean; play?: (signal: AbortSignal) => Promise<{stopped?: boolean}>} = {}) => {
    const h = fakeHost();
    const played: number[] = [];
    const inputsDuringPlay: string[] = [];
    const center = new MediaCenter({
      target: async () => ({platform: 'apple', id: udid, s: {}} as unknown as MediaTarget),
      root: () => dir,
      stateDir: () => dir,
      hostInput: () => h.host,
      inputFile: () => path.join(dir, 'mic-input.json'),
      outputIndex: async () => 2,
      macRecorders: async () => [
        ...(o.others ? [{pid: 1, bundle: 'com.example.calls', devices: [HEADSET.uid], command: '/Applications/Calls.app/Contents/MacOS/Calls'}] : []),
        ...((o.recording?.() ?? true) ? [{pid: 2, bundle: 'com.example.app', devices: [h.now === LOOP.name && !o.early ? LOOP.uid : HEADSET.uid], command: appPath}] : []),
      ],
      playTo: async (_wav, index, {signal}) => {
        played.push(index);
        inputsDuringPlay.push(h.now);
        return o.play ? o.play(signal) : {};
      },
    });
    return {h, center, played, inputsDuringPlay};
  };

  it('plays to the loopback once the app records from it, with the input switched only meanwhile', async () => {
    const {h, center, played, inputsDuringPlay} = setup();
    const r = await center.mic(udid, 'tone 440 200ms');
    expect(played).toEqual([2]);
    expect(inputsDuringPlay).toEqual([LOOP.name]);
    expect(r).toMatchObject({udid, heardBy: 'com.example.app', input: HEADSET.name});
    expect(h.now).toBe(HEADSET.name);
  });

  it('refuses while another app records from the input, unless forced', async () => {
    const {h, center, played} = setup({others: true});
    await expect(center.mic(udid, 'tone 440 200ms')).rejects.toThrow(/com\.example\.calls records from the Mac's input \(USB Headset\).*\n.*force/s);
    expect(h.sets).toEqual([]);
    await center.mic(udid, 'tone 440 200ms force');
    expect(played).toEqual([2]);
    expect(h.now).toBe(HEADSET.name);
  });

  it('puts the input back when no app records in time, and plays nothing', async () => {
    const {h, center, played} = setup({recording: () => false});
    await expect(center.mic(udid, 'tone 440 200ms wait=0.3s')).rejects.toThrow(/no app on .* recorded from BlackHole 2ch within 0.3s/);
    expect(played).toEqual([]);
    expect(h.sets).toEqual([LOOP.name, HEADSET.name]);
    expect(h.now).toBe(HEADSET.name);
  });

  it('puts the input back on mic stop, and on a daemon stop, of a sound in the background', async () => {
    const hold = (signal: AbortSignal) => new Promise<{stopped?: boolean}>(resolve => signal.addEventListener('abort', () => resolve({stopped: true})));
    const a = setup({play: hold});
    expect(await a.center.mic(udid, 'tone 440 5s bg')).toMatchObject({background: expect.stringMatching(/mic stop/)});
    await new Promise(r => setTimeout(r, 50));
    expect(a.h.now).toBe(LOOP.name);
    expect(await a.center.mic(udid, 'stop')).toMatchObject({mic: expect.stringMatching(/^stopped/), input: HEADSET.name});
    expect(a.h.now).toBe(HEADSET.name);

    const b = setup({play: hold});
    await b.center.mic(udid, 'tone 440 5s bg');
    await new Promise(r => setTimeout(r, 50));
    expect(b.h.now).toBe(LOOP.name);
    await b.center.stopAll();
    expect(b.h.now).toBe(HEADSET.name);
  });

  it('says so when the app started recording before the switch, and plays nothing', async () => {
    const {h, center, played} = setup({early: true});
    await expect(center.mic(udid, 'tone 440 200ms wait=0.3s force')).rejects.toThrow(/com\.example\.app on .* records from headset-in, not BlackHole 2ch: a simulator's app keeps the input.*\n.*mic <sound> bg/s);
    expect(played).toEqual([]);
    expect(h.now).toBe(HEADSET.name);
  });

  it('waits for a sound in the background to have played, and fails when it failed', async () => {
    const a = setup({play: () => new Promise(r => setTimeout(() => r({}), 100))});
    expect(await a.center.mic(udid, 'wait')).toMatchObject({mic: 'idle'});
    await a.center.mic(udid, 'tone 440 200ms bg');
    expect(await a.center.mic(udid, 'wait')).toMatchObject({mic: expect.stringMatching(/^played tone/), heardBy: 'com.example.app', input: HEADSET.name});
    const b = setup({recording: () => false});
    await b.center.mic(udid, 'tone 440 200ms bg wait=0.3s');
    await expect(b.center.mic(udid, 'wait')).rejects.toThrow(/no app on .* recorded/);
    expect(b.h.now).toBe(HEADSET.name);
    expect(parseMic('wait')).toEqual({op: 'wait'});
  });

  it('puts the input back when playing fails', async () => {
    const {h, center} = setup({play: async () => Promise.reject(new Error('mic: ffmpeg could not play to the loopback: boom'))});
    await expect(center.mic(udid, 'tone 440 200ms')).rejects.toThrow(/boom/);
    expect(h.now).toBe(HEADSET.name);
    expect(fs.existsSync(path.join(dir, 'mic-input.json'))).toBe(false);
  });
});

describe('media on a physical iPhone', () => {
  const udid = '00008150-000A1B2C3D4E5F60';
  const center = new MediaCenter({
    target: async () => ({platform: 'apple', id: udid, s: {xcrun: 'xcrun', simctl: async () => ({code: 1, stdout: '', stderr: 'Invalid device'})}} as unknown as MediaTarget),
    root: () => os.tmpdir(),
    stateDir: () => os.tmpdir(),
  } as unknown as ConstructorParameters<typeof MediaCenter>[0]);

  it('says what the device cannot do instead of a simulator tool\'s error', async () => {
    await expect(center.capture(udid, 'start', {what: 'screen'})).rejects.toThrow(/records no video of an iPhone's or iPad's screen.*\nhint: QuickTime/s);
    await expect(center.capture(udid, 'start', {what: 'audio'})).rejects.toThrow(/stays on the device/);
    const pic = path.join(os.tmpdir(), 'pitbox-device-pic.png');
    fs.writeFileSync(pic, '');
    try {
      await expect(center.library(udid, `add ${pic}`)).rejects.toThrow(/no way into an iPhone's or iPad's photo library/);
    } finally {
      fs.rmSync(pic);
    }
    await expect(center.audio(udid, 'volume music 5')).rejects.toThrow(/set with its buttons/);
    await expect(center.mic(udid, 'tone 440 200ms')).rejects.toThrow(/records its own microphone/);
    await expect(center.camera(udid, 'image a.png')).rejects.toThrow(/sees the room/);
    await expect(center.call(udid, 'incoming')).rejects.toThrow(/no call to an iPhone/);
  });
});
