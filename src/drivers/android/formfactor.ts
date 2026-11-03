// What only some kinds of devices have: a hinge (foldables), a rotating screen, desktop-style windows (tablets,
// desktops), keyboards with modifiers. Each goes through a platform service, so real devices work as well as
// emulators.

import {AndroidError} from './driver.ts';

type Shell = (serial: string, command: string, timeoutMs?: number) => Promise<string>;

const META: Record<string, number> = {ctrl: 0x3000, shift: 0x41, alt: 0x12, meta: 0x30000};

/**
 * A key name, keycode or combination (`ctrl+c`, `ctrl+shift+tab`, `alt+f4` style) as a keycode with modifier
 * flags. Letters and digits work without being in the table.
 */
export const keyOf = (k: string, keys: Record<string, number>): {code: number; meta: number} => {
  const parts = k.toLowerCase().split('+').filter(Boolean);
  const last = parts.pop() ?? '';
  let meta = 0;
  for (const m of parts) {
    const flag = META[m];
    if (flag === undefined) throw new AndroidError(`unknown modifier: ${m}`, `modifiers: ${Object.keys(META).join(', ')}`);
    meta |= flag;
  }
  const letter = /^[a-z]$/.test(last) ? 29 + last.charCodeAt(0) - 97 : undefined;
  const digit = /^[0-9]$/.test(last) ? 7 + Number(last) : undefined;
  const code = keys[last] ?? letter ?? digit ?? Number(last);
  if (!Number.isInteger(code) || last === '') {
    throw new AndroidError(`unknown key: ${k}`, `known: ${Object.keys(keys).join(', ')}, a letter or digit, or a keycode; with ${Object.keys(META).join('+')}+ in front`);
  }
  return {code, meta};
};

/** Fold postures by the names pitbox accepts, matched against the device's own state names. */
const POSTURES: Record<string, RegExp> = {closed: /^CLOSED$/, half: /HALF/, open: /^OPEN(ED)?$/, rear: /REAR/, tent: /TENT/, flipped: /FLIP/};

/** The device states a foldable declares, as `{id, name}`. */
export const parseDeviceStates = (out: string) => [...out.matchAll(/identifier=(\d+), name='([^']+)'/g)].map(m => ({id: m[1]!, name: m[2]!}));

/**
 * Folds or unfolds: `closed`, `half` (tabletop or book), `open`, `rear` (rear display), any state name the device
 * declares, or `reset` back to the hinge's own state.
 */
export const posture = async (shell: Shell, serial: string, name: string): Promise<{posture: string; states: string[]}> => {
  const states = parseDeviceStates(await shell(serial, 'cmd device_state print-states'));
  if (!states.length) throw new AndroidError('this device has no fold states', 'posture is for foldables');
  const names = states.map(st => st.name.toLowerCase());
  if (name === 'reset') await shell(serial, 'cmd device_state state reset');
  else {
    const want = POSTURES[name.toLowerCase()];
    const st = states.find(x => (want ? want.test(x.name) : x.name.toLowerCase() === name.toLowerCase()));
    if (!st) throw new AndroidError(`no posture "${name}" on this device`, `it has: ${names.join(', ')}; or reset`);
    await shell(serial, `cmd device_state state ${st.id}`);
  }
  // The displays switch a moment after the state does.
  await new Promise(r => setTimeout(r, 1500));
  // Folding puts up the keyguard on the outer screen by default (Android 15 and later: "swipe up to continue");
  // the app stays behind it. Dismissed, as the swipe would: a screen lock with a credential stays.
  await shell(serial, 'input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard').catch(() => '');
  await new Promise(r => setTimeout(r, 500));
  return {posture: name, states: names};
};

/** Locks the screen at 0, 90, 180 or 270 degrees, or `auto` to follow the sensor again. */
export const rotate = async (shell: Shell, serial: string, rotation: string): Promise<{rotation: string}> => {
  if (rotation === 'auto') await shell(serial, 'cmd window user-rotation free');
  else {
    const n = Number(rotation);
    if (![0, 90, 180, 270].includes(n)) throw new AndroidError('rotate 0, 90, 180, 270 or auto');
    await shell(serial, `cmd window user-rotation lock ${n / 90}`);
  }
  await new Promise(r => setTimeout(r, 1000));
  return {rotation};
};

/** The id of the app's task in `dumpsys activity activities` output. */
export const taskIdOf = (dump: string, pkg: string): string | undefined => {
  for (const line of dump.split('\n')) {
    const m = /Task\{[0-9a-f]+ #(\d+) .*A=\d+:(\S+?)[\s}]/.exec(line);
    if (m && m[2] === pkg) return m[1];
  }
  return undefined;
};

const parseBox = (bounds?: string) => {
  if (!bounds) return undefined;
  const box = bounds.split(/[\s,]+/).map(Number);
  if (box.length !== 4 || box.some(n => !Number.isFinite(n))) throw new AndroidError('window bounds are x,y,width,height');
  return box as [number, number, number, number];
};

/**
 * The app as a desktop-style window: `freeform` (optionally at x,y with a size w,h), `fullscreen` again, or
 * `resize` a freeform window. Switching mode relaunches the app; freeform windows are enabled in the device's
 * settings and stay enabled.
 */
export const windowMode = async (shell: Shell, serial: string, pkg: string, component: () => Promise<string>, mode: string, bounds?: string): Promise<{mode: string; bounds?: string}> => {
  const box = parseBox(bounds);
  if (mode === 'resize') {
    if (!box) throw new AndroidError('window resize x,y,width,height');
    const task = taskIdOf(await shell(serial, 'dumpsys activity activities'), pkg);
    if (!task) throw new AndroidError(`${pkg} has no task`, 'open the app first');
    const [x, y, w, h] = box;
    const out = await shell(serial, `am task resize ${task} ${x} ${y} ${x + w} ${y + h}`);
    if (/error|exception/i.test(out)) throw new AndroidError(`resize failed: ${out.trim()}`, 'only a freeform window can be resized: window freeform first');
    return {mode, bounds};
  }
  if (mode !== 'freeform' && mode !== 'fullscreen') throw new AndroidError('window freeform [x,y,w,h] | fullscreen | resize x,y,w,h');
  if (mode === 'freeform') await shell(serial, 'settings put global enable_freeform_support 1; settings put global force_resizable_activities 1');
  const target = await component();
  await shell(serial, `am force-stop ${pkg}`);
  await shell(serial, `am start -W --windowingMode ${mode === 'freeform' ? 5 : 1} -n ${target}`, 60_000);
  if (box) return {...(await windowMode(shell, serial, pkg, component, 'resize', bounds)), mode};
  return {mode};
};

// ---- watches ----------------------------------------------------------------------------------------------------

/** The result of a Wear OS debug broadcast: `result=1` is success, `data="…"` says what happened. */
export const parseBroadcast = (out: string): {ok: boolean; data?: string; code?: number} => {
  const code = Number(/result=(\d+)/.exec(out)?.[1]);
  const data = /data="([^"]*)"/.exec(out)?.[1];
  return {ok: code === 1, data, code: Number.isFinite(code) ? code : undefined};
};

const broadcast = async (shell: Shell, serial: string, action: 'DEBUG_SURFACE' | 'DEBUG_SYSUI', extras: string) => {
  const out = await shell(serial, `am broadcast -a com.google.android.wearable.app.${action} ${extras}`);
  const r = parseBroadcast(out);
  if (r.code === 0) throw new AndroidError('nothing on this device answered the Wear OS debug broadcast', 'a Wear OS emulator or a watch with developer options on');
  if (!r.ok) throw new AndroidError(`wear: ${r.data ?? out.trim().split('\n').pop()}`);
  return r.data ?? '';
};

/**
 * What only a watch has, through the system's own debug hooks:
 * - `tile add|remove <component>` puts a tile in the carousel or takes it out; `tile show <component|index>`
 *   brings it on screen (adding it first when given a component);
 * - `face <package|component>` makes a watch face current: a Watch Face Format package, or the component of an
 *   older face;
 * - `ambient on|off` enters or leaves the low-power ambient state (always-on display must be enabled);
 * - `home` goes to the watch face (the home key toggles between the face and the app list).
 */
export const wear = async (shell: Shell, serial: string, op: string, args: string[]): Promise<{op: string; detail?: string}> => {
  const [what, target] = args;
  switch (op) {
    case 'tile': {
      if (!target) throw new AndroidError('wear tile add|show|remove <component>');
      if (what === 'remove') return {op: 'tile remove', detail: await broadcast(shell, serial, 'DEBUG_SURFACE', `--es operation remove-tile --ecn component ${target}`)};
      let index = /^\d+$/.test(target) ? Number(target) : undefined;
      if (index === undefined) {
        const data = await broadcast(shell, serial, 'DEBUG_SURFACE', `--es operation add-tile --ecn component ${target}`);
        index = Number(/Index=\[(\d+)\]/.exec(data)?.[1] ?? 0);
      }
      if (what === 'add') return {op: 'tile add', detail: `index ${index}`};
      if (what !== 'show') throw new AndroidError('wear tile add|show|remove <component>');
      await broadcast(shell, serial, 'DEBUG_SYSUI', `--es operation show-tile --ei index ${index}`);
      return {op: 'tile show', detail: `index ${index}`};
    }
    case 'face': {
      const id = what;
      if (!id) throw new AndroidError('wear face <package|component>');
      const extra = id.includes('/') ? `--ecn component ${id}` : `--es watchFaceId ${id}`;
      return {op: 'face', detail: await broadcast(shell, serial, 'DEBUG_SURFACE', `--es operation set-watchface ${extra}`)};
    }
    case 'ambient': {
      if (what !== 'on' && what !== 'off') throw new AndroidError('wear ambient on|off');
      await shell(serial, `input keyevent ${what === 'on' ? 'KEYCODE_SLEEP' : 'KEYCODE_WAKEUP'}`);
      await new Promise(r => setTimeout(r, 1500));
      return {op: `ambient ${what}`};
    }
    case 'home':
      await shell(serial, 'am start -a android.intent.action.MAIN -c android.intent.category.HOME');
      await new Promise(r => setTimeout(r, 1000));
      return {op: 'home'};
    default:
      throw new AndroidError('wear tile add|show|remove <component> | face <package|component> | ambient on|off | home');
  }
};

// ---- XR headsets --------------------------------------------------------------------------------------------------

/**
 * The headset's view on an XR emulator, through the emulator's control channel: `look yaw[,pitch[,roll]]` turns
 * the head by degrees (turns add up), `move dx,dy,dz` moves it by metres, `recenter` puts the view back in front
 * of the user. Real headsets have no such channel.
 */
export const xrView = async (serial: string, op: string, value?: string): Promise<{op: string; value?: string}> => {
  const {findEndpoint, call, encode} = await import('./emulatorGrpc.ts');
  const port = Number(/^emulator-(\d+)$/.exec(serial)?.[1]);
  const ep = port ? findEndpoint(port) : undefined;
  if (!ep) throw new AndroidError(`${serial} has no emulator control channel`, 'look, move and recenter work on an XR emulator');
  const nums = (value ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  if (nums.some(n => !Number.isFinite(n))) throw new AndroidError(`xr ${op}: numbers, comma-separated`);
  const [a = 0, b = 0, c = 0] = nums;
  const rad = (d: number) => (d * Math.PI) / 180;
  let event: Buffer;
  if (op === 'recenter') event = encode.input(9, Buffer.alloc(0));
  // Yaw turns around the vertical axis (y), pitch around x, roll around z; positive yaw looks left.
  else if (op === 'look') event = encode.input(10, encode.vec3(rad(b), rad(a), rad(c)));
  else if (op === 'move') event = encode.input(11, encode.vec3(a, b, c));
  else throw new AndroidError('xr look yaw[,pitch[,roll]] | move dx,dy,dz | recenter | panel …');
  await call(ep, 'streamInputEvent', [event]);
  await new Promise(r => setTimeout(r, 600));
  return {op, value};
};

/** The shell's controls of an app's panel on XR, by the ids of its caption and caption menu. */
export const XR_PANEL: Record<string, {id: string; menu?: boolean}> = {
  minimize: {id: 'minimize_window'},
  close: {id: 'close_window'},
  menu: {id: 'caption_application_icon'},
  info: {id: 'app_info_button', menu: true},
  'spatial-audio': {id: 'disable_spatial_audio_button', menu: true},
  tidy: {id: 'tidy_up_button', menu: true},
  'close-app': {id: 'close_button', menu: true},
};

// ---- cars ---------------------------------------------------------------------------------------------------------

/** Vehicle properties (VHAL) the car commands set. */
const VHAL = {gear: '0x11400400', speed: '0x11600207', parkingBrake: '0x11200402'};
const GEAR = {park: 4, drive: 8};

/**
 * What only a car has, through its car service: `day|night|auto` switches the cabin's day-night mode; `drive
 * [m/s]` releases the parking brake, selects drive and sets a speed — apps that are not made for driving are
 * then blocked by the system, as in a moving car; `park` stops, selects park and sets the brake; `rotary cw|ccw
 * [n]` turns the rotary controller.
 */
export const car = async (shell: Shell, serial: string, op: string, args: string[]): Promise<{op: string; detail?: string}> => {
  const vhal = (prop: string, value: number | string) => shell(serial, `cmd car_service inject-vhal-event ${prop} ${value}`);
  const check = (out: string) => {
    if (/Unknown command|Can't find service|not found/i.test(out)) throw new AndroidError('no car service on this device', 'car commands work on an Android Automotive emulator or head unit');
    return out;
  };
  switch (op) {
    case 'day':
    case 'night':
      check(await shell(serial, `cmd car_service day-night-mode ${op}`));
      break;
    case 'auto':
      check(await shell(serial, 'cmd car_service day-night-mode sensor'));
      break;
    case 'drive': {
      const speed = Number(args[0] ?? 15);
      if (!Number.isFinite(speed) || speed <= 0) throw new AndroidError('car drive [speed in m/s, above 0]');
      check(await vhal(VHAL.parkingBrake, 0));
      await vhal(VHAL.gear, GEAR.drive);
      await vhal(VHAL.speed, speed);
      await new Promise(r => setTimeout(r, 1500));
      return {op, detail: `${speed} m/s`};
    }
    case 'park':
      check(await vhal(VHAL.speed, 0));
      await vhal(VHAL.gear, GEAR.park);
      await vhal(VHAL.parkingBrake, 1);
      await new Promise(r => setTimeout(r, 1500));
      break;
    case 'rotary': {
      const dir = args[0] === 'ccw' ? 'false' : 'true';
      const n = Math.max(1, Math.min(Number(args[1] ?? 1) || 1, 20));
      for (let i = 0; i < n; i++) check(await shell(serial, `cmd car_service inject-rotary -c ${dir}`));
      break;
    }
    default:
      throw new AndroidError('car day|night|auto | drive [m/s] | park | rotary cw|ccw [n]');
  }
  await new Promise(r => setTimeout(r, 800));
  return {op};
};

// ---- screens ------------------------------------------------------------------------------------------------------

/** The device's built-in screens (`dumpsys display`): their SurfaceFlinger ids and whether each is on. */
export const physicalDisplays = (dump: string): {id: string; on: boolean}[] =>
  [...dump.matchAll(/DisplayDeviceInfo\{[^\n]*?uniqueId="local:(\d+)"[^\n]*?state (\w+)/g)].map(m => ({id: m[1]!, on: m[2] === 'ON'}));

/** The PNG in screencap's output, without the warnings it can print before it. */
export const pngFrom = (out: Buffer): Buffer => {
  const at = out.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return at > 0 ? out.subarray(at) : out;
};
