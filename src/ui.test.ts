import {describe, expect, it} from 'vitest';
import {fillRoute, parseFlow, tokenize, validateFlow} from './flows/flow.ts';
import {runFlow, type FlowHost} from './flows/run.ts';
import type {DeviceUi} from './ui/device.ts';
import {buildSnapshot, diffSnapshots, resolveTarget, selectorFor, type UiNode, type UiWindow} from './ui/snapshot.ts';

const windows: UiWindow[] = [
  {type: 'system', title: '', pkg: 'com.android.systemui'},
  {type: 'app', title: '', pkg: 'com.example.app'},
];

const nodes: UiNode[] = [
  {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 60], id: 'status_bar'},
  {p: -1, w: 1, c: 'FrameLayout', b: [0, 0, 1080, 2400]},
  {p: 1, w: 1, c: 'TextView', b: [40, 100, 600, 160], t: 'Popular items'},
  {p: 1, w: 1, c: 'ViewGroup', b: [40, 2000, 1040, 2120], id: 'get-started', f: 'cf'},
  {p: 3, w: 1, c: 'TextView', b: [400, 2030, 700, 2090], t: 'Get started'},
  {p: 1, w: 1, c: 'EditText', b: [40, 300, 1040, 380], h: 'Email', f: 'cfe'},
  {p: 1, w: 1, c: 'ImageView', b: [900, 100, 1000, 160], d: 'Search', f: 'c'},
];

describe('snapshot', () => {
  const snap = buildSnapshot(windows, nodes, {height: 2400});

  it('folds a button with its label, hides system bars, keeps hints and ids', () => {
    expect(snap.lines).toEqual(['@e1 text "Popular items"', '@e2 button "Get started" #get-started', '@e3 field hint "Email"', '@e4 button "Search"']);
  });

  it('drops child texts a control description already carries, keeps children with ids', () => {
    const rn: UiNode[] = [
      {p: -1, w: 1, c: 'ViewGroup', b: [0, 0, 1080, 400], d: 'The Blue Box, 11 parts', id: 'hero', f: 'c'},
      {p: 0, w: 1, c: 'TextView', b: [0, 300, 500, 340], t: 'The Blue Box', id: 'hero-title'},
      {p: 0, w: 1, c: 'TextView', b: [0, 340, 500, 380], t: '11 parts'},
    ];
    expect(buildSnapshot(windows, rn).lines).toEqual(['@e1 button "The Blue Box, 11 parts" #hero', '@e2 text "The Blue Box" #hero-title']);
  });

  it('resolves refs, ids, text, labels, words and points', () => {
    expect(resolveTarget(snap, '@e2')).toMatchObject({x: 540, y: 2060});
    expect(resolveTarget(snap, 'id=get-started')).toMatchObject({x: 540, y: 2060});
    expect(resolveTarget(snap, 'text="Get started"').node?.t).toBe('Get started');
    expect(resolveTarget(snap, 'label=search').node?.d).toBe('Search');
    expect(resolveTarget(snap, 'popular').node?.t).toBe('Popular items');
    expect(resolveTarget(snap, '10,20')).toEqual({x: 10, y: 20});
    expect(() => resolveTarget(snap, '@e99')).toThrow(/fresh one/);
  });

  it('matches text with no-break spaces the way lines show it', () => {
    const nb = buildSnapshot(windows, [{p: -1, w: 1, c: 'Button', b: [0, 0, 100, 40], t: 'About\u00a0this  device', f: 'c'}]);
    expect(nb.lines).toEqual(['@e1 button "About this device"']);
    expect(resolveTarget(nb, 'About this device').node?.c).toBe('Button');
    expect(resolveTarget(nb, 'text="about this device"').node?.c).toBe('Button');
    expect(() => resolveTarget(snap, 'text=Nope')).toThrow(/nothing matches/);
  });

  it('records stable selectors: id, then unique text, then label', () => {
    expect(selectorFor(snap, 3)).toBe('id=get-started');
    expect(selectorFor(snap, 2)).toBe('text="Popular items"');
    expect(selectorFor(snap, 6)).toBe('label="Search"');
  });

  it('diffs: added lines with refs, removed lines without, whole screen when most changed', () => {
    const after = buildSnapshot(windows, [...nodes, {p: 1, w: 1, c: 'TextView', b: [40, 500, 600, 560], t: 'Saved'}]);
    const d = diffSnapshots(snap, after);
    expect(d).toEqual({changed: true, full: false, lines: ['+ @e5 text "Saved"']});
    expect(diffSnapshots(snap, snap).changed).toBe(false);
    const other = buildSnapshot(windows, [{p: -1, w: 1, c: 'TextView', b: [0, 0, 10, 10], t: 'Another screen'}]);
    expect(diffSnapshots(snap, other).full).toBe(true);
  });
});

describe('flows', () => {
  it('tokenizes quoted values and keeps quotes on selectors', () => {
    expect(tokenize('fill text="E mail" "a b@example.test"')).toEqual(['fill', 'text="E mail"', '"a b@example.test"']);
    expect(tokenize("press 'Get started'")).toEqual(['press', "'Get started'"]);
    expect(() => tokenize('press "open')).toThrow(/unclosed/);
  });

  it('fills routes and refuses missing parameters', () => {
    expect(fillRoute('item', 'myapp://item/{id}?t={t}', {id: '42', t: 'a b'})).toBe('myapp://item/42?t=a%20b');
    expect(() => fillRoute('item', 'myapp://item/{id}', {})).toThrow(/needs id/);
  });

  it('substitutes parameters and validates before running', () => {
    const steps = parseFlow('# sign in\nfill id=email ${user}\nscroll down until text=Done\nfly away', {user: 'u@example.test'});
    expect(steps[0]).toMatchObject({line: 2, cmd: 'fill', args: ['id=email', 'u@example.test']});
    expect(validateFlow(steps)).toEqual([expect.stringMatching(/^line 4: unknown step "fly"/)]);
    expect(() => parseFlow('press ${missing}')).toThrow(/missing flow parameter/);
  });

  const fakeHost = (screens: string[][]) => {
    let screen = 0;
    const calls: string[] = [];
    const snapshotOf = () => buildSnapshot(windows, screens[screen]!.map((t, i) => ({p: -1, w: 1, c: 'TextView', b: [0, i * 100, 500, i * 100 + 80], t, f: 'c'})));
    const ui = {
      snapshot: async () => snapshotOf(),
      press: async (sel: string) => {
        resolveTarget(snapshotOf(), sel);
        calls.push(`press ${sel}`);
        screen = Math.min(screen + 1, screens.length - 1);
      },
      fill: async (sel: string, text: string) => void calls.push(`fill ${sel} ${text}`),
      wait: async (sel: string, o: {gone?: boolean}) => {
        const found = snapshotOf().lines.some(l => l.includes(sel.replace(/^text=/, '').replace(/"/g, '')));
        if (found === !!o.gone) throw new Error(`timed out waiting for ${sel}`);
        return {ms: 0, snapshot: snapshotOf()};
      },
      focus: async () => ({}),
      crashesSince: async () => [],
    } as unknown as DeviceUi;
    const host: FlowHost = {
      ui: async () => ui,
      open: async (t, r) => void calls.push(`open ${t ?? ''}${r ? '!' : ''}`),
      goto: async (route, p) => void calls.push(`goto ${route} ${JSON.stringify(p)}`),
      signIn: async () => ({ok: true, steps: 1, ms: 0, notes: []}),
      tool: async (name, p) => ({code: 0, output: name === 'sql' ? `rows: ${p.query?.length}` : ''}),
      loadFlow: () => 'press text=Next',
      state: async () => undefined,
      setDevice: async (d: string) => void calls.push(`device ${d}`),
      visual: async () => ({status: 'match'}),
      screenshot: async n => `/shots/${n}.jpg`,
    };
    return {host, calls};
  };

  it('runs steps in order and passes', async () => {
    const {host, calls} = fakeHost([['Welcome', 'Next'], ['Home']]);
    const r = await runFlow(host, 'open!\npress text=Next\nexpect text=Home\ntool sql query="abc" contains "rows: 3"\ngoto item id=7\ndevice tv-1');
    expect(r).toMatchObject({ok: true, steps: 6});
    expect(calls).toEqual(['open !', 'press text=Next', 'goto item {"id":"7"}', 'device tv-1']);
  });

  it('times a cold start up to the first check after it, and mentions JS errors of a passing flow', async () => {
    const {host} = fakeHost([['Home']]);
    host.open = async () => ({activityMs: 640, jsMs: 2900});
    host.jsErrors = async () => [{summary: 'boom (fatal)', lines: ['onPress  src/a.ts:3:4']}];
    const r = await runFlow(host, 'open!\nexpect gone text=Splash\nwait text=Home');
    expect(r.ok).toBe(true);
    expect(r.notes[0]).toMatch(/^cold start: activity 640 ms · JS running at 2\.9s · wait text=Home at /);
    expect(r.notes.slice(1)).toEqual(['! JS error: boom (fatal)', '    onPress  src/a.ts:3:4']);
  });

  it('stops at the first failure with the line, the error and the screen', async () => {
    const {host} = fakeHost([['Welcome']]);
    const r = await runFlow(host, 'open\npress text=Missing\npress text=Welcome');
    expect(r.ok).toBe(false);
    expect(r.failed).toMatchObject({line: 2, step: 'press text=Missing', screenshot: '/shots/failed-line-2.jpg'});
    expect(r.failed?.error).toMatch(/nothing matches/);
    expect(r.failed?.screen?.[0]).toContain('Welcome');
  });
});

describe('visual diff', () => {
  it('matches the same grid and boxes the changed area in screen pixels', async () => {
    const {compareFingerprints} = await import('./ui/visual.ts');
    const grid = Array.from({length: 10 * 20}, () => 100);
    const base = {cols: 10, rows: 20, width: 1000, height: 2000, grid};
    expect(compareFingerprints(base, {...base, grid: [...grid]}).same).toBe(true);
    const changed = [...grid];
    for (const i of [33, 34, 43, 44]) changed[i] = 230;
    const d = compareFingerprints(base, {...base, grid: changed});
    expect(d.same).toBe(false);
    expect(d.regions).toEqual([[300, 300, 500, 500]]);
  });
});
