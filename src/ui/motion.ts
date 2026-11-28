// Is a region moving? Judged from small greyscale frames of it (the runners shrink each screenshot to a grid of
// `size`×`size` brightness values on the device and send the grids, never an image).
//
// The mean difference over the whole frame is the wrong measure: a video that is mostly still — a title card, a
// talking head, a test clip with a running timecode — changes in a small area, and averaging that area with
// everything that did not change reads a playing video as stuck. So the frame is cut into tiles and the motion
// is the largest tile's mean difference: a change confined to one corner counts in full, while a pixel or two of
// scaling noise spread over a tile does not.

/** Side of a tile, in grid cells: a 32×32 grid is cut into 8×8 tiles. */
export const motionTile = 4;

/** A tile whose mean difference (0–255) is above this is moving. A still frame differs by 0, codec noise by about 1. */
export const tileMotionThreshold = 3;

/** The whole frame's mean difference above which it is moving too — a slow fade changes every tile a little. */
export const frameMotionThreshold = 1.5;

export type FrameMotion = {
  /** Mean absolute difference over the whole frame, 0–255. */
  mean: number;
  /** The largest mean absolute difference of one tile, 0–255. */
  peak: number;
};

/** The difference between two grids of `width`×`height` brightness values (row by row). */
export function frameMotion(a: readonly number[], b: readonly number[], width: number, height = width, tile = motionTile): FrameMotion {
  if (a.length !== b.length || a.length !== width * height) throw new Error(`frames of ${a.length} and ${b.length} values are not ${width}×${height}`);
  let total = 0;
  let peak = 0;
  for (let ty = 0; ty < height; ty += tile) {
    for (let tx = 0; tx < width; tx += tile) {
      let sum = 0;
      let cells = 0;
      for (let y = ty; y < Math.min(height, ty + tile); y++) {
        for (let x = tx; x < Math.min(width, tx + tile); x++) {
          const k = y * width + x;
          sum += Math.abs(a[k]! - b[k]!);
          cells++;
        }
      }
      total += sum;
      peak = Math.max(peak, sum / cells);
    }
  }
  return {mean: total / Math.max(1, a.length), peak};
}

/** Motion over a run of frames: the largest of each neighbouring pair's. */
export function framesMotion(frames: readonly (readonly number[])[], width: number, height = width): FrameMotion {
  let mean = 0;
  let peak = 0;
  for (let i = 1; i < frames.length; i++) {
    const m = frameMotion(frames[i - 1]!, frames[i]!, width, height);
    mean = Math.max(mean, m.mean);
    peak = Math.max(peak, m.peak);
  }
  return {mean, peak};
}

export function isMoving(m: FrameMotion): boolean {
  return m.peak > tileMotionThreshold || m.mean > frameMotionThreshold;
}
