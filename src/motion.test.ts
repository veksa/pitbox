import {describe, expect, it} from 'vitest';
import {DeviceUi} from './ui/device.ts';
import {frameMotion, isMoving} from './ui/motion.ts';

const size = 32;

/** A still picture: a soft gradient with a darker band, as a 32×32 grid of brightness. */
const still = (): number[] => Array.from({length: size * size}, (_, k) => 60 + ((k % size) * 3) + (Math.floor(k / size) > 20 ? -30 : 0));

/** The same picture with a timecode in the bottom-right corner: three cells of digits that changed between frames. */
const withTimecode = (frame: number[], digits: number[]): number[] => {
  const out = [...frame];
  digits.forEach((value, i) => {
    out[29 * size + 26 + i] = value;
  });
  return out;
};

describe('motion of a region', () => {
  it('two identical frames do not move', () => {
    const m = frameMotion(still(), still(), size);
    expect(m).toEqual({mean: 0, peak: 0});
    expect(isMoving(m)).toBe(false);
  });

  it('a running timecode in a corner moves, though the mean over the frame is under the old threshold', () => {
    const a = withTimecode(still(), [230, 40, 220]);
    const b = withTimecode(still(), [40, 230, 30]);
    const m = frameMotion(a, b, size);
    // What the whole-frame mean said about such a clip: well under the 1.5 it was judged by.
    expect(m.mean).toBeLessThan(1);
    expect(m.peak).toBeGreaterThan(20);
    expect(isMoving(m)).toBe(true);
  });

  it('a level of scaling noise over the whole frame does not move', () => {
    const a = still();
    const b = a.map((v, k) => v + (k % 3 === 0 ? 1 : 0));
    expect(isMoving(frameMotion(a, b, size))).toBe(false);
  });

  it('a slow fade of every tile moves', () => {
    const a = still();
    expect(isMoving(frameMotion(a, a.map(v => v + 2), size))).toBe(true);
  });

  it('refuses frames of different sizes', () => {
    expect(() => frameMotion(still(), still().slice(1), size)).toThrow(/not 32×32/);
  });
});

describe('inspect media', () => {
  const ui = (reply: object) => new DeviceUi('emulator-5554', {call: async () => reply} as never);

  it('reads a clip with a running timecode as playing from the grids the runner sends', async () => {
    const frames = [withTimecode(still(), [230, 40, 220]), withTimecode(still(), [40, 230, 30]), withTimecode(still(), [220, 30, 230])];
    const r = await ui({luma: [100, 100, 100], diff: [0.6, 0.6], cols: size, rows: size, grids: frames}).media();
    expect(r).toMatchObject({moving: true, playing: true, black: false});
  });

  it('reads the same frames over and over as not moving', async () => {
    const r = await ui({luma: [100, 100], diff: [0], cols: size, rows: size, grids: [still(), still()]}).media();
    expect(r).toMatchObject({moving: false, playing: false, motion: 0});
  });

  it('falls back to the mean of a runner that sends no grids', async () => {
    expect((await ui({luma: [100, 100], diff: [2]}).media()).moving).toBe(true);
    expect((await ui({luma: [100, 100], diff: [0.6]}).media()).moving).toBe(false);
  });
});
