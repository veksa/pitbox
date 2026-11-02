// Visual comparison on brightness grids: is this the same screen as the baseline, and if not, where did it
// change? Grids come from the device, so no image is decoded or sent for the comparison itself.

export type Fingerprint = {cols: number; rows: number; width: number; height: number; grid: number[]};
export type Region = [number, number, number, number];
export type VisualDiff = {score: number; changedShare: number; regions: Region[]; same: boolean};

/** A cell counts as changed past this brightness difference (0–255); compression and antialiasing stay below. */
const CELL = 24;

export const compareFingerprints = (base: Fingerprint, cur: Fingerprint): VisualDiff => {
  if (base.cols !== cur.cols || base.rows !== cur.rows) {
    return {score: 255, changedShare: 1, regions: [[0, 0, cur.width, cur.height]], same: false};
  }
  const {cols, rows} = cur;
  const changed = new Uint8Array(cols * rows);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < cur.grid.length; i++) {
    const d = Math.abs((cur.grid[i] ?? 0) - (base.grid[i] ?? 0));
    sum += d;
    if (d > CELL) {
      changed[i] = 1;
      count++;
    }
  }
  // Connected changed cells → bounding boxes in screen pixels.
  const seen = new Uint8Array(cols * rows);
  const regions: Region[] = [];
  const cw = cur.width / cols;
  const ch = cur.height / rows;
  for (let i = 0; i < changed.length; i++) {
    if (!changed[i] || seen[i]) continue;
    let [minX, minY, maxX, maxY] = [cols, rows, -1, -1];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % cols;
      const y = Math.floor(k / cols);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (changed[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    regions.push([Math.round(minX * cw), Math.round(minY * ch), Math.round((maxX + 1) * cw), Math.round((maxY + 1) * ch)]);
  }
  regions.sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]));
  const changedShare = count / changed.length;
  const score = Math.round((sum / cur.grid.length) * 10) / 10;
  return {score, changedShare: Math.round(changedShare * 1000) / 1000, regions: regions.slice(0, 8), same: changedShare < 0.005};
};
