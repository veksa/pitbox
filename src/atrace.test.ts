// The platform trace (atrace text) summed up for one app, and a budget on its main thread.

import {describe, expect, it} from 'vitest';
import {sliceName, summarizeAtrace} from './drivers/android/atrace.ts';
import {checkBudgets, parseBudget} from './flows/budget.ts';

const mark = (comm: string, tid: number, pid: number, t: number, what: string) => ` ${comm}-${tid}   (  ${pid}) [001] .....  ${t.toFixed(6)}: tracing_mark_write: ${what}`;

// The app is pid 100: its main thread (tid 100, named after the package), and RenderThread (tid 101).
const trace = [
  '# tracer: nop',
  mark('example.app', 100, 100, 1.0, 'B|100|Choreographer#doFrame 42'),
  mark('example.app', 100, 100, 1.001, 'B|100|traversal'),
  mark('example.app', 100, 100, 1.002, 'B|100|measure'),
  mark('example.app', 100, 100, 1.004, 'E|100'),
  mark('example.app', 100, 100, 1.005, 'B|100|draw'),
  mark('example.app', 100, 100, 1.03, 'E|100'),
  mark('example.app', 100, 100, 1.031, 'E|100'),
  mark('example.app', 100, 100, 1.032, 'E|100'),
  mark('RenderThread', 101, 100, 1.04, 'B|100|DrawFrames 1740884'),
  mark('RenderThread', 101, 100, 1.06, 'E|100'),
  mark('RenderThread', 101, 100, 1.1, 'B|100|DrawFrames 1740885'),
  mark('RenderThread', 101, 100, 1.118, 'E|100'),
  mark('RenderThread', 101, 100, 1.2, 'B|100|DrawFrames 1740886'),
  mark('RenderThread', 101, 100, 1.205, 'E|100'),
  // Another process: not the app's.
  mark('surfaceflinger', 300, 300, 1.0, 'B|300|composite'),
  mark('surfaceflinger', 300, 300, 1.5, 'E|300'),
].join('\n');

describe('platform trace', () => {
  it('drops frame numbers and coordinates from slice names', () => {
    expect(sliceName('DrawFrames 1740884')).toBe('DrawFrames');
    expect(sliceName('Drawing  0.00  0.00 1080.00 2400.00')).toBe('Drawing');
    expect(sliceName('dequeueBuffer - VRI[MainActivity]#0')).toBe('dequeueBuffer - VRI[MainActivity]#0');
  });

  it('sums each thread of the app, and groups long slices with what took the time inside', () => {
    const s = summarizeAtrace(trace, 100);
    expect(s.ms).toBe(500);
    expect(s.threads).toEqual([
      {thread: 'main', ms: 32, slices: 1, longest: 32},
      {thread: 'RenderThread', ms: 43, slices: 3, longest: 20},
    ].sort((a, b) => b.ms - a.ms));
    expect(s.long).toEqual([
      {thread: 'main', name: 'Choreographer#doFrame', path: ['traversal', 'draw'], count: 1, ms: 32, totalMs: 32, at: 0},
      {thread: 'RenderThread', name: 'DrawFrames', path: [], count: 2, ms: 20, totalMs: 38, at: 40},
    ]);
  });

  it('checks a budget on the longest main-thread slice, and asks for a trace without one', () => {
    const data = {trace: summarizeAtrace(trace, 100)};
    expect(checkBudgets(data, [parseBudget('slice<16')])).toEqual({ok: false, lines: ['slice 32ms ✗ < 16ms']});
    expect(checkBudgets({}, [parseBudget('slice<16')])).toEqual({ok: false, lines: ['slice: not measured here (needs `perf trace` on Android)']});
  });
});
