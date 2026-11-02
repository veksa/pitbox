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
