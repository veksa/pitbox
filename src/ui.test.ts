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
      reshape: async (op, v) => void calls.push(`${op} ${v}`),
      perf: async reset => {
        calls.push(`perf${reset ? ' reset' : ''}`);
        return {data: {janky: 7.5, js: {busyMs: 120}, react: {commits: 2, renderMs: 9, counts: {Row: 41}, heap: {liveBefore: 4 * 1048576, liveAfter: 5.5 * 1048576, allocated: 20 * 1048576}}}, text: 'frames 100 · janky 7.5%'};
      },
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

  it('folds, rotates and re-windows the device as flow steps', async () => {
    const {host, calls} = fakeHost([['Home']]);
    const r = await runFlow(host, 'posture half\nrotate 90\nwindow freeform 0,0,800,600\nposture reset');
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['posture half', 'rotate 90', 'window freeform 0,0,800,600', 'posture reset']);
  });

  it('checks perf budgets over the window since a perf step', async () => {
    const {host, calls} = fakeHost([['Home']]);
    const ok = await runFlow(host, 'perf\npress text=Home\nexpect perf js<300 commits<=2 heap<2 allocated<=20');
    expect(ok.ok).toBe(true);
    expect(calls).toEqual(['perf reset', 'press text=Home', 'perf']);
    expect(ok.notes).toContain('perf: js 120ms ✓ < 300ms · commits 2 ✓ <= 2 · heap 1.5MB ✓ < 2MB · allocated 20MB ✓ <= 20MB');
    const over = await runFlow(host, 'perf\nexpect perf janky<5 js<1s renders:Row<=40 renders:Cell<1');
    expect(over.ok).toBe(false);
    expect(over.failed?.error).toMatch(/^over budget: janky 7\.5% ✗ < 5%; renders:Row 41 ✗ <= 40\nframes 100 · janky 7\.5%/);
  });

  it('rejects a budget it cannot read before running anything', async () => {
    const {host, calls} = fakeHost([['Home']]);
    const r = await runFlow(host, 'perf\nexpect perf speed<3');
    expect(r.ok).toBe(false);
    expect(r.failed?.error ?? '').toMatch(/unknown perf metric "speed"/);
    expect(calls).toEqual([]);
  });

  it('fails a budget on a metric this device cannot measure', async () => {
    const {host} = fakeHost([['Home']]);
    host.perf = async () => ({data: {memoryMb: 90, react: {react: false}}, text: 'memory 90 MB'});
    const r = await runFlow(host, 'perf\nexpect perf janky<5 memory<100');
    expect(r.failed?.error).toMatch(/janky: not measured here \(this device has no counter for it\)/);
  });

  it('rejects a mouse step without a target', async () => {
    const {host} = fakeHost([['Home']]);
    const r = await runFlow(host, 'mouse right');
    expect(r.failed?.error).toMatch(/mouse right\|hover <selector>/);
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

describe('a keyboard over the target', () => {
  it('is waited out when it was fullscreen and the app comes back a moment later', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    let keyboard = true;
    let after = 0;
    const calls: string[] = [];
    const greet: UiNode = {p: -1, w: 0, c: 'Button', b: [0, 400, 400, 450], id: 'greet', t: 'Greet', f: 'c'};
    const keys: UiNode = {p: -1, w: 0, c: 'View', b: [0, 0, 400, 500], id: 'keyboard_area'};
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'key' || cmd === 'tap') calls.push(`${cmd} ${JSON.stringify(args)}`);
        if (cmd === 'key' && args.code === 4) keyboard = false;
        if (cmd === 'tree') {
          // Two snapshots after the keyboard went, the app's window is still missing.
          if (keyboard || after++ < 2) return {windows: [{type: 'ime', title: 'Keyboard', pkg: 'com.example.ime'}], nodes: [keys]};
          return {windows: [{type: 'app', title: '', pkg: 'com.example.app'}], nodes: [greet]};
        }
        if (cmd === 'info') return {width: 400, height: 500};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    await new DeviceUi('dev', runner as never).press('id=greet');
    expect(calls).toEqual(['key {"code":4}', 'tap {"x":200,"y":425}']);
  });

  it('is hidden when a fullscreen one comes up on the tap of a fill, and the text goes in after', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    let keyboard = false;
    let value = '';
    const calls: string[] = [];
    const field = (): UiNode => ({p: -1, w: 0, c: 'Field', b: [0, 100, 400, 150], id: 'name', t: value, f: 'ce'});
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (['key', 'tap', 'text'].includes(cmd)) calls.push(cmd);
        if (cmd === 'tap') keyboard = true;
        if (cmd === 'key' && args.code === 4) keyboard = false;
        if (cmd === 'text') {
          if (keyboard) return {set: false};
          value = String(args.text);
          return {set: true};
        }
        if (cmd === 'tree') return keyboard ? {windows: [{type: 'ime', title: 'Keyboard', pkg: 'com.example.ime'}], nodes: []} : {windows: [{type: 'app', title: '', pkg: 'com.example.app'}], nodes: [field()]};
        if (cmd === 'info') return {width: 400, height: 500};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    await new DeviceUi('dev', runner as never).fill('id=name', 'Ada');
    expect(calls).toEqual(['tap', 'text', 'key', 'text']);
    expect(value).toBe('Ada');
  });

  it('is hidden before the tap even when its window shows no views', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    let keyboard = true;
    const calls: string[] = [];
    const greet: UiNode = {p: -1, w: 0, c: 'Button', b: [0, 400, 400, 450], id: 'greet', t: 'Greet', f: 'c'};
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'key' || cmd === 'tap') calls.push(`${cmd} ${JSON.stringify(args)}`);
        if (cmd === 'key' && args.code === 4) keyboard = false;
        if (cmd === 'tree') return {windows: [{type: 'app', title: '', pkg: 'com.example.app'}, ...(keyboard ? [{type: 'ime', title: 'Keyboard', pkg: 'com.example.ime'}] : [])], nodes: [greet]};
        if (cmd === 'info') return {width: 400, height: 500};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    await new DeviceUi('dev', runner as never).press('id=greet');
    expect(calls).toEqual(['key {"code":4}', 'tap {"x":200,"y":425}']);
  });
});

describe('focus map', () => {
  it('tells apart cells that share one id', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    const cells: UiNode[] = ['A', 'B', 'C'].map((t, i) => ({p: -1, w: 0, c: 'Cell', b: [i * 100, 0, i * 100 + 90, 90], id: 'AppCell', t, f: 'cf'}));
    let at = 0;
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'focus') return {input: cells[at]};
        if (cmd === 'key') at = args.code === 22 ? Math.min(2, at + 1) : args.code === 21 ? Math.max(0, at - 1) : at;
        if (cmd === 'tree') return {windows: [{type: 'app', title: '', pkg: 'com.example.app'}], nodes: cells.map((c, i) => ({...c, f: i === at ? 'cfF' : 'cf'}))};
        if (cmd === 'info') return {width: 300, height: 100};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    const ui = new DeviceUi('dev', runner as never);
    const map = await ui.focusMap(60);
    expect(map.reached).toBe(3);
    expect(map.unreached).toEqual([]);
    expect(map.traps).toEqual([]);
  });
});

describe('focus map on a list that scrolls under the focus', () => {
  it('keeps nodes without ids apart by text, not by bounds that move', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    const rows = ['One', 'Two', 'Three'];
    let at = 0;
    // The focused row is always drawn at the top: the list scrolls with the focus.
    const node = (i: number): UiNode => ({p: -1, w: 0, c: 'Cell', b: [0, (i - at) * 60 + 100, 800, (i - at) * 60 + 150], t: rows[i], f: i === at ? 'cfF' : 'cf'});
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'focus') return {input: node(at)};
        if (cmd === 'key') at = args.code === 20 ? Math.min(2, at + 1) : args.code === 19 ? Math.max(0, at - 1) : at;
        if (cmd === 'tree') return {windows: [{type: 'app', title: '', pkg: 'com.example.app'}], nodes: rows.map((_, i) => node(i))};
        if (cmd === 'info') return {width: 800, height: 600};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    const map = await new DeviceUi('dev', runner as never).focusMap(60);
    expect(map).toMatchObject({reached: 3, focusable: 3, unreached: [], traps: []});
  });
});
