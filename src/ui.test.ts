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
  it('folds a text into the view that only carries an id around it, and drops a text its parent already says', () => {
    const w: UiWindow[] = [{type: 'app', title: '', pkg: 'com.example.app'}];
    const snap = buildSnapshot(w, [
      {p: -1, w: 0, c: 'Other', b: [0, 0, 400, 50], id: 'banner-title'},
      {p: 0, w: 0, c: 'Other', b: [0, 0, 400, 50]},
      {p: 1, w: 0, c: 'StaticText', b: [0, 0, 400, 50], t: 'Welcome'},
      {p: -1, w: 0, c: 'Other', b: [0, 700, 100, 800], id: 'footer-home', t: 'Home'},
      {p: 3, w: 0, c: 'StaticText', b: [0, 760, 100, 800], t: 'Home'},
    ]);
    expect(snap.lines).toEqual(['@e1 view "Welcome" #banner-title', '@e2 view "Home" #footer-home']);
    // iOS: the text as the view's sibling in the same rectangle.
    const ios = buildSnapshot(w, [
      {p: -1, w: 0, c: 'Other', b: [0, 0, 400, 300], id: 'banner'},
      {p: 0, w: 0, c: 'Other', b: [100, 50, 300, 80], id: 'banner-title'},
      {p: 0, w: 0, c: 'Text', b: [100, 50, 300, 80], t: 'Welcome'},
      {p: 0, w: 0, c: 'Text', b: [100, 90, 300, 120], t: 'Sign in to continue'},
      {p: 0, w: 0, c: 'Text', b: [100, 130, 300, 160], t: 'WHAT YOU GET'},
      {p: 0, w: 0, c: 'Other', b: [100, 130, 300, 160], id: 'intro-title'},
    ]);
    expect(ios.lines).toEqual(['@e1 view #banner', '@e2 view "Welcome" #banner-title', '@e3 text "Sign in to continue"', '@e4 view "WHAT YOU GET" #intro-title']);
    expect(resolveTarget(snap, 'text=Welcome').ref).toBe('@e1');
    expect(resolveTarget(snap, 'id=banner-title').ref).toBe('@e1');
  });

  it('drops the iOS scroll indicators and keeps the position of a long list on its line', () => {
    const w: UiWindow[] = [{type: 'app', title: '', pkg: 'com.example.app'}];
    const snap = buildSnapshot(w, [
      {p: -1, w: 0, c: 'ScrollView', b: [0, 0, 400, 800], f: 's', id: 'feed'},
      {p: 0, w: 0, c: 'Other', b: [390, 0, 400, 800], t: 'Vertical scroll bar, 3 pages', d: '40%'},
      {p: 0, w: 0, c: 'Other', b: [0, 790, 400, 800], t: 'Horizontal scroll bar, 1 page', d: '0%'},
      {p: -1, w: 0, c: 'ScrollView', b: [0, 800, 400, 900], f: 's', id: 'chips'},
      {p: 3, w: 0, c: 'Other', b: [390, 800, 400, 900], t: 'Vertical scroll bar, 1 page', d: '0%'},
    ]);
    expect(snap.lines).toEqual(['@e1 list #feed [3 pages 40%]', '@e2 list #chips']);
  });

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
    // The button its line quotes, not the text folded into it.
    expect(resolveTarget(snap, 'text="Get started"').node?.id).toBe('get-started');
    expect(resolveTarget(snap, 'label=search').node?.d).toBe('Search');
    // The line quotes a textless control's label, so `text=` finds it by what the agent read.
    expect(resolveTarget(snap, 'text=Search').node?.d).toBe('Search');
    expect(resolveTarget(snap, 'popular').node?.t).toBe('Popular items');
    expect(resolveTarget(snap, '10,20')).toEqual({x: 10, y: 20});
    expect(() => resolveTarget(snap, '@e99')).toThrow(/fresh one/);
  });

  it('prefers the button of an alert on top to the row behind it with the same text', () => {
    const w: UiWindow[] = [{type: 'app', title: '', pkg: 'com.example.app'}, {type: 'app', title: '', pkg: 'com.apple.springboard'}];
    const alert = buildSnapshot(w, [
      {p: -1, w: 0, c: 'Other', b: [0, 0, 400, 800]},
      {p: 0, w: 0, c: 'Button', b: [0, 600, 400, 650], t: 'Sign out', id: 'settings-sign-out', f: 'c'},
      {p: 0, w: 0, c: 'Alert', b: [60, 300, 340, 500], t: 'Sign out?'},
      {p: 2, w: 0, c: 'Button', b: [60, 450, 200, 500], t: 'Cancel', f: 'c'},
      {p: 2, w: 0, c: 'Button', b: [200, 450, 340, 500], t: 'Sign out', f: 'c'},
      {p: 0, w: 0, c: 'Button', b: [0, 700, 400, 750], t: 'Allow', f: 'c'},
      {p: -1, w: 1, c: 'Button', b: [200, 400, 340, 440], t: 'Allow', f: 'c'},
    ]);
    expect(resolveTarget(alert, 'text=Sign out').index).toBe(4);
    expect(resolveTarget(alert, 'Sign out').index).toBe(4);
    // The shell's alert is above the whole app.
    expect(resolveTarget(alert, 'text=Allow').index).toBe(6);
    // A match only behind the alert is still found.
    expect(resolveTarget(alert, 'id=settings-sign-out').index).toBe(1);
  });

  it("prefers the button of React Native's alert, listed after the screen and nested in its scroll views", () => {
    // As an iOS runner reads Alert.alert: the screen stays in the tree, the alert follows it in the same window
    // with its title and its buttons each in a scroll view of their own.
    const rn = buildSnapshot([{type: 'app', title: '', pkg: 'com.example.app'}], [
      {p: -1, w: 0, c: 'Other', b: [0, 0, 402, 874], id: 'content-list'},
      {p: 0, w: 0, c: 'Button', b: [16, 400, 386, 440], t: 'Remove', id: 'remove', f: 'c'},
      {p: -1, w: 0, c: 'Alert', b: [41, 388, 361, 514], t: 'Remove the row?'},
      {p: 2, w: 0, c: 'ScrollView', b: [41, 388, 361, 434], f: 's'},
      {p: 3, w: 0, c: 'Text', b: [71, 410, 331, 430], t: 'Remove the row?'},
      {p: 2, w: 0, c: 'ScrollView', b: [41, 434, 361, 514], f: 's'},
      {p: 5, w: 0, c: 'Button', b: [57, 450, 197, 498], t: 'Cancel', f: 'c'},
      {p: 5, w: 0, c: 'Button', b: [205, 450, 345, 498], t: 'Remove', f: 'c'},
    ]);
    expect(resolveTarget(rn, 'text=Remove').index).toBe(7);
    expect(resolveTarget(rn, 'Remove').index).toBe(7);
  });

  it('finds a control by the label folded in from its children, as its line quotes it', () => {
    const folded = buildSnapshot(windows, [
      {p: -1, w: 1, c: 'View', b: [0, 0, 200, 100], f: 'c'},
      {p: 0, w: 1, c: 'ImageView', b: [10, 10, 60, 60], d: 'Close'},
    ]);
    expect(folded.lines).toEqual(['@e1 button "Close"']);
    expect(resolveTarget(folded, 'text=Close')).toMatchObject({index: 0, ref: '@e1'});
    expect(resolveTarget(folded, 'Close').index).toBe(0);
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

  it('presses an optional target when it shows and goes on when it does not', async () => {
    const {host, calls} = fakeHost([['Save Password?', 'Not Now'], ['Home']]);
    const r = await runFlow(host, 'press? text="Not Now" 1\npress? text=Later\nexpect text=Home');
    expect(r).toMatchObject({ok: true, steps: 3});
    expect(calls).toEqual(['press text="Not Now"']);
  });

  it('folds, rotates and re-windows the device as flow steps', async () => {
    const {host, calls} = fakeHost([['Home']]);
    const r = await runFlow(host, 'posture half\nrotate 90\nwindow freeform 0,0,800,600\nposture reset');
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['posture half', 'rotate 90', 'window freeform 0,0,800,600', 'posture reset']);
  });

  it('reads a quoted name in a step the way the window step does', async () => {
    const {host, calls} = fakeHost([['Home']]);
    host.state = async n => void calls.push(`state ${n}`);
    host.loadFlow = n => (calls.push(`run ${n}`), 'sleep 0');
    const r = await runFlow(host, 'device "iPhone 18 Pro"\nwindow "My Doc"\nstate \'signed in\'\nrun "sign-in"\nscreenshot "home page"');
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['device iPhone 18 Pro', 'window My Doc', 'state signed in', 'run sign-in']);
    expect(r.notes).toContain('screenshot: /shots/home page.jpg');
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

describe('a permission request over the app', () => {
  const perm: UiWindow[] = [{type: 'app', title: '', pkg: 'com.google.android.permissioncontroller'}];
  const dialog: UiNode[] = [
    {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 2400]},
    {p: 0, w: 0, c: 'TextView', b: [40, 900, 1040, 1000], t: 'Allow MyApp to send you notifications?', id: 'permission_message'},
    {p: 0, w: 0, c: 'Button', b: [40, 1100, 1040, 1200], t: 'Allow', id: 'permission_allow_button', f: 'c'},
  ];
  const snap = buildSnapshot(perm, dialog);

  it('names the system app whose screen it is, and the question', async () => {
    const {permissionPrompt} = await import('./ui/snapshot.ts');
    expect(snap.lines[0]).toBe('— com.google.android.permissioncontroller');
    expect(permissionPrompt(snap)).toBe('Allow MyApp to send you notifications?');
    expect(permissionPrompt(buildSnapshot(windows, nodes))).toBeUndefined();
  });

  it('says so when a selector finds nothing under it', () => {
    expect(() => resolveTarget(snap, 'id=home')).toThrow(/nothing matches "id=home" — a permission request is on top: "Allow MyApp/);
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

  it('leaves a masked area out on both sides, so a baseline taken without the mask still matches', async () => {
    const {compareFingerprints} = await import('./ui/visual.ts');
    const grid = Array.from({length: 10 * 20}, () => 100);
    const base = {cols: 10, rows: 20, width: 1000, height: 2000, grid};
    // The device blanks the mask in the grid it takes now; the baseline still has the content there.
    const blanked = [...grid];
    for (const i of [33, 34, 43, 44]) blanked[i] = 0;
    expect(compareFingerprints(base, {...base, grid: blanked}).same).toBe(false);
    expect(compareFingerprints(base, {...base, grid: blanked}, [[300, 300, 500, 500]])).toMatchObject({same: true, score: 0, regions: []});
  });
});

describe('a target with something drawn over its centre', () => {
  // A floating button with elevation: earlier in the tree, painted last.
  const fab: UiNode = {p: -1, w: 0, c: 'ImageView', b: [940, 140, 1080, 280], d: 'Tools', z: 2};
  const profile: UiNode = {p: -1, w: 0, c: 'ViewGroup', b: [900, 100, 1060, 260], id: 'profile', f: 'c', z: 1};
  const app: UiWindow[] = [{type: 'app', title: '', pkg: 'com.example.app'}];

  it('is tapped where the screen shows it, and the answer says what covered it', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    const taps: string[] = [];
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'tap') taps.push(`${args.x},${args.y}`);
        if (cmd === 'tree') return {windows: app, nodes: [fab, profile]};
        if (cmd === 'info') return {width: 1080, height: 2400};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    const r = await new DeviceUi('dev', runner as never).press('id=profile');
    const [x, y] = taps[0]!.split(',').map(Number) as [number, number];
    expect(x < 940 || y < 140).toBe(true);
    expect(x >= 900 && x < 1060 && y >= 100 && y < 260).toBe(true);
    expect(r.note).toMatch(/^tapped \d+,\d+: the centre is under @e1 .*Tools/);
  });

  it('is not covered in an iOS shell alert, which the runner lists after the app but which is on top', async () => {
    const {tapPoint} = await import('./ui/snapshot.ts');
    const windows: UiWindow[] = [{type: 'app', title: '', pkg: 'com.example.app'}, {type: 'app', title: 'Allow?', pkg: 'com.apple.springboard'}];
    const list: UiNode = {p: -1, w: 0, c: 'List', b: [0, 0, 1000, 2000], f: 'cs', d: 'Popular'};
    const allow: UiNode = {p: -1, w: 1, c: 'Button', b: [500, 900, 800, 1000], t: 'Allow', f: 'c'};
    const behind: UiNode = {p: -1, w: 0, c: 'Button', b: [500, 900, 800, 1000], id: 'start', f: 'c'};
    expect(tapPoint(buildSnapshot(windows, [list, allow]), 1)).toEqual({x: 650, y: 950});
    expect(tapPoint(buildSnapshot(windows, [behind, allow]), 0).coveredBy).toMatch(/Allow/);
  });

  it('is tapped in the centre when what overlaps it is painted below, or is its own child', async () => {
    const {tapPoint} = await import('./ui/snapshot.ts');
    expect(tapPoint(buildSnapshot(app, [{...fab, z: 0}, profile]), 1)).toEqual({x: 980, y: 180});
    const child: UiNode = {p: 0, w: 0, c: 'ImageView', b: [940, 140, 1000, 200], d: 'icon', z: 2};
    expect(tapPoint(buildSnapshot(app, [{...profile, p: -1}, child]), 0)).toEqual({x: 980, y: 180});
  });
});

describe("React Native's warnings toast over a target", () => {
  const app: UiWindow[] = [{type: 'app', title: '', pkg: 'com.example.app'}];
  const tab: UiNode = {p: -1, w: 0, c: 'Button', b: [810, 2204, 1080, 2325], id: 'tab-profile', f: 'c'};
  const toast: UiNode[] = [
    {p: -1, w: 0, c: 'Button', b: [26, 2170, 1054, 2295], d: '!, Open debugger to view warnings.', f: 'c'},
    {p: -1, w: 0, c: 'Button', b: [970, 2207, 1022, 2259], f: 'c'},
  ];

  it('is closed with its own dismiss button, then the target gets the tap, and the answer says so', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    const taps: string[] = [];
    let shown = true;
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'tap') {
          taps.push(`${args.x},${args.y}`);
          if (args.x === 996 && args.y === 2233) shown = false;
        }
        if (cmd === 'tree') return {windows: app, nodes: shown ? [tab, ...toast] : [tab]};
        if (cmd === 'info') return {width: 1080, height: 2424};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    const r = await new DeviceUi('dev', runner as never).press('id=tab-profile');
    expect(taps).toEqual(['996,2233', '945,2265']);
    expect(r.note).toMatch(/closed React Native's warnings toast/);
  }, 15_000);

  it('is left alone when the target is not under it, or is the toast itself', async () => {
    const {logBoxToast} = await import('./ui/snapshot.ts');
    expect(logBoxToast(buildSnapshot(app, [tab, ...toast]))?.dismiss.b).toEqual([970, 2207, 1022, 2259]);
    expect(logBoxToast(buildSnapshot(app, [tab, {...toast[0]!, d: 'Open settings'}, toast[1]!]))).toBeUndefined();
    const {DeviceUi} = await import('./ui/device.ts');
    const taps: string[] = [];
    const top: UiNode = {p: -1, w: 0, c: 'Button', b: [0, 100, 540, 200], id: 'search', f: 'c'};
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'tap') taps.push(`${args.x},${args.y}`);
        if (cmd === 'tree') return {windows: app, nodes: [top, tab, ...toast]};
        if (cmd === 'info') return {width: 1080, height: 2424};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    await new DeviceUi('dev', runner as never).press('id=search');
    expect(taps).toEqual(['270,150']);
  }, 15_000);
});

describe('a press that starts a navigation after the UI looked quiet', () => {
  it('answers with the screen it led to, not with the first frame of the change', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    const app: UiWindow[] = [{type: 'app', title: '', pkg: 'com.example.app'}];
    const home: UiNode[] = [
      {p: -1, w: 0, c: 'Button', b: [0, 100, 1080, 600], id: 'hero', f: 'c'},
      {p: -1, w: 0, c: 'Button', b: [810, 2204, 1080, 2325], id: 'tab-profile', f: 'c'},
    ];
    const leaving = home.slice(0, 1);
    const detail: UiNode[] = [{p: -1, w: 0, c: 'View', b: [0, 0, 1080, 2400], id: 'detail-screen'}, {p: 0, w: 0, c: 'Button', b: [40, 900, 400, 1000], id: 'watch', f: 'c'}];
    let tapped = 0;
    let reads = 0;
    const runner = {
      call: async (cmd: string) => {
        if (cmd === 'tap') tapped = Date.now();
        // The tab bar goes first; the next screen is mounted a few hundred milliseconds later.
        if (cmd === 'tree') return {windows: app, nodes: !tapped ? home : (reads++, Date.now() - tapped < 400 ? leaving : detail)};
        if (cmd === 'info') return {width: 1080, height: 2400};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    const r = await new DeviceUi('dev', runner as never).press('id=hero');
    expect(r.diff.lines.join('\n')).toMatch(/#detail-screen/);
  }, 15_000);
});

describe("iOS's offer to save a password", () => {
  const app: UiWindow[] = [{type: 'app', title: '', pkg: 'com.example.app'}];
  const sheet: UiNode[] = [
    {p: -1, w: 0, c: 'Other', b: [0, 1400, 1179, 2556], t: 'Save Password?'},
    {p: 0, w: 0, c: 'Button', b: [80, 2300, 560, 2420], t: 'Not Now', f: 'c'},
    {p: 0, w: 0, c: 'Button', b: [620, 2300, 1100, 2420], t: 'Save', f: 'c'},
  ];
  const home: UiNode[] = [{p: -1, w: 0, c: 'Other', b: [0, 0, 1179, 200], id: 'user-avatar'}];

  it('is declined with Not Now, so a wait sees the app behind it, and the next press says so', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    const taps: string[] = [];
    let shown = true;
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'tap') {
          taps.push(`${args.x},${args.y}`);
          shown = false;
        }
        if (cmd === 'tree') return {windows: app, nodes: shown ? sheet : home};
        if (cmd === 'info') return {width: 1179, height: 2556};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    const ui = new DeviceUi('sim', runner as never);
    await ui.wait('id=user-avatar', {timeoutMs: 2000});
    expect(taps).toEqual(['320,2360']);
    shown = true;
    const r = await ui.press('id=user-avatar');
    expect(r.note).toMatch(/declined "Save Password\?"/);
  }, 15_000);

  it('is left alone without its Not Now, and nothing else counts as it', async () => {
    const {passwordOffer} = await import('./ui/snapshot.ts');
    expect(passwordOffer(buildSnapshot(app, sheet.slice(0, 1)))).toBeUndefined();
    expect(passwordOffer(buildSnapshot(app, [{...sheet[0]!, t: 'Save your progress?'}, sheet[1]!]))).toBeUndefined();
    expect(passwordOffer(buildSnapshot(app, sheet))?.title).toBe('Save Password?');
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
        if (cmd === 'key' || cmd === 'tap') calls.push(`${cmd} ${JSON.stringify(cmd === 'tap' ? {x: args.x, y: args.y} : args)}`);
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

  it('is closed with return where the device has no back (iOS), and the target pressed after', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    let keyboard = true;
    const calls: string[] = [];
    const submit: UiNode = {p: -1, w: 0, c: 'Button', b: [0, 400, 400, 450], id: 'submit', t: 'Sign in', f: 'c'};
    const keys: UiNode = {p: -1, w: 1, c: 'Keyboard', b: [0, 300, 400, 500]};
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'key' || cmd === 'tap') calls.push(`${cmd} ${JSON.stringify(cmd === 'tap' ? {x: args.x, y: args.y} : args)}`);
        if (cmd === 'key' && args.code === 4) throw new Error('key code 4 has no equivalent on this device (home, enter and del do)');
        if (cmd === 'key' && args.code === 66) keyboard = false;
        if (cmd === 'tree') {
          const app = {type: 'app', title: '', pkg: 'com.example.app'};
          return keyboard ? {windows: [app, {type: 'ime', title: 'Keyboard', pkg: 'com.apple.keyboard'}], nodes: [submit, keys]} : {windows: [app], nodes: [submit]};
        }
        if (cmd === 'info') return {width: 400, height: 500};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    await new DeviceUi('sim', runner as never).press('id=submit');
    expect(calls).toEqual(['key {"code":4}', 'key {"code":66}', 'tap {"x":200,"y":425}']);
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

  it('is waited for after a fill, when it comes up a moment after the screen settled', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    let keyboard = false;
    let trees = 0;
    let pressFrom = Infinity;
    const calls: string[] = [];
    const field: UiNode = {p: -1, w: 0, c: 'Field', b: [0, 100, 400, 150], id: 'name', f: 'ce'};
    const greet: UiNode = {p: -1, w: 0, c: 'Button', b: [0, 400, 400, 450], id: 'greet', t: 'Greet', f: 'c'};
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (['key', 'tap'].includes(cmd)) calls.push(cmd);
        if (cmd === 'key' && args.code === 4) keyboard = false;
        if (cmd === 'tree') {
          trees++;
          // The press's first look at the screen has no keyboard yet; it is there on the second.
          if (trees === pressFrom + 2) keyboard = true;
          return {windows: [{type: 'app', title: '', pkg: 'com.example.app'}, ...(keyboard ? [{type: 'ime', title: 'Keyboard', pkg: 'com.example.ime'}] : [])], nodes: [field, greet]};
        }
        if (cmd === 'info') return {width: 400, height: 500};
        if (cmd === 'text') return {set: true};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    const ui = new DeviceUi('dev', runner as never);
    await ui.fill('id=name', 'Ada');
    calls.length = 0;
    pressFrom = trees;
    await ui.press('id=greet');
    expect(calls).toEqual(['key', 'tap']);
  });

  it('is hidden before the tap even when its window shows no views', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    let keyboard = true;
    const calls: string[] = [];
    const greet: UiNode = {p: -1, w: 0, c: 'Button', b: [0, 400, 400, 450], id: 'greet', t: 'Greet', f: 'c'};
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'key' || cmd === 'tap') calls.push(`${cmd} ${JSON.stringify(cmd === 'tap' ? {x: args.x, y: args.y} : args)}`);
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

describe('a keyboard that comes up by itself', () => {
  it('is waited for when the target is missing, then hidden', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    let trees = 0;
    let keyboard = false;
    let hidden = false;
    const calls: string[] = [];
    const greet: UiNode = {p: -1, w: 0, c: 'Button', b: [0, 100, 400, 150], id: 'greet', t: 'Greet', f: 'c'};
    const face: UiNode = {p: -1, w: 0, c: 'View', b: [0, 0, 400, 400], id: 'watchface'};
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'key' || cmd === 'tap') calls.push(cmd);
        if (cmd === 'key' && args.code === 4) {
          keyboard = false;
          hidden = true;
        }
        if (cmd === 'tree') {
          // A fullscreen keyboard on its way: first the app is gone from the list, then the keyboard is there.
          if (++trees === 2 && !hidden) keyboard = true;
          if (hidden) return {windows: [{type: 'app', title: '', pkg: 'com.example.app'}], nodes: [greet]};
          return keyboard ? {windows: [{type: 'ime', title: 'Keyboard', pkg: 'com.example.ime'}], nodes: []} : {windows: [{type: 'app', title: '', pkg: 'com.example.face'}], nodes: [face]};
        }
        if (cmd === 'info') return {width: 400, height: 400};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    await new DeviceUi('dev', runner as never).press('id=greet');
    expect(calls).toEqual(['key', 'tap']);
  });
});

describe('a tap that only closed the keyboard', () => {
  it('is pressed again, so the control gets it', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    let keyboard = true;
    let greeted = false;
    const calls: string[] = [];
    const greet: UiNode = {p: -1, w: 0, c: 'Button', b: [0, 100, 400, 150], id: 'greet', t: 'Greet', f: 'c'};
    const keys: UiNode = {p: -1, w: 1, c: 'Keyboard', b: [0, 300, 400, 500]};
    const runner = {
      call: async (cmd: string) => {
        if (cmd === 'tap') {
          calls.push(cmd);
          // A list that spends the first tap on the keyboard.
          if (keyboard) keyboard = false;
          else greeted = true;
        }
        if (cmd === 'tree') {
          const nodes = [greet, ...(greeted ? [{p: -1, w: 0, c: 'Text', b: [0, 160, 400, 200], t: 'Hello'} as UiNode] : []), ...(keyboard ? [keys] : [])];
          return {windows: [{type: 'app', title: '', pkg: 'com.example.app'}, ...(keyboard ? [{type: 'ime', title: 'keyboard', pkg: 'com.apple.keyboard'}] : [])], nodes};
        }
        if (cmd === 'info') return {width: 400, height: 500};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    const r = await new DeviceUi('dev', runner as never).press('id=greet');
    expect(calls).toEqual(['tap', 'tap']);
    expect(greeted).toBe(true);
    expect(r.note).toMatch(/pressed again/);
  });
});

describe('a tap whose control closes the keyboard itself', () => {
  it('is not pressed again when what it did shows a moment later', async () => {
    const {DeviceUi} = await import('./ui/device.ts');
    let keyboard = true;
    let saved = false;
    const calls: string[] = [];
    const save: UiNode = {p: -1, w: 0, c: 'Button', b: [0, 100, 400, 150], id: 'save', t: 'Save', f: 'c'};
    // Its keys have labels, so the keyboard going is a change of the screen.
    const keys: UiNode = {p: -1, w: 1, c: 'Key', b: [0, 300, 400, 500], t: 'return', f: 'c'};
    const runner = {
      call: async (cmd: string) => {
        if (cmd === 'tap') {
          calls.push(cmd);
          // The control takes the tap, closes the keyboard at once and shows that it saved after a moment.
          keyboard = false;
          setTimeout(() => (saved = true), 450);
        }
        // The keyboard going down is a stream of events: the runner is quiet only once it is down.
        if (cmd === 'idle') {
          await new Promise(r => setTimeout(r, 300));
          return {idle: true};
        }
        if (cmd === 'tree') {
          const nodes = [save, ...(saved ? [{p: -1, w: 0, c: 'Text', b: [0, 160, 400, 200], t: 'Saved'} as UiNode] : []), ...(keyboard ? [keys] : [])];
          return {windows: [{type: 'app', title: '', pkg: 'com.example.app'}, ...(keyboard ? [{type: 'ime', title: 'keyboard', pkg: 'com.apple.keyboard'}] : [])], nodes};
        }
        if (cmd === 'info') return {width: 400, height: 500};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    const r = await new DeviceUi('dev', runner as never).press('id=save');
    expect(calls).toEqual(['tap']);
    expect(saved).toBe(true);
    expect(r.note ?? '').not.toMatch(/pressed again/);
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

describe('back where the device has no back key (iOS)', () => {
  const app: UiWindow[] = [{type: 'app', title: '', pkg: 'com.example.app'}];
  const pushed: UiNode[] = [
    {p: -1, w: 0, c: 'NavigationBar', b: [0, 62, 402, 116], id: 'Settings'},
    {p: 0, w: 0, c: 'Button', b: [16, 62, 60, 106], t: 'Back', id: 'BackButton', f: 'c'},
    {p: 0, w: 0, c: 'Text', b: [168, 74, 234, 94], t: 'Settings'},
    {p: -1, w: 0, c: 'Text', b: [141, 458, 261, 498], t: 'Settings', id: 'settings_screen'},
  ];

  it("finds UIKit's back button, or the bar's first button at its start, and nothing on a root screen", async () => {
    const {backButton} = await import('./ui/snapshot.ts');
    expect(backButton(buildSnapshot(app, pushed))).toBe(1);
    const titled = pushed.map(n => (n.id === 'BackButton' ? {...n, id: undefined, t: 'Inbox'} : n));
    expect(backButton(buildSnapshot(app, titled))).toBe(1);
    // A root screen's bar holds only an action on its end.
    const root: UiNode[] = [pushed[0]!, {p: 0, w: 0, c: 'Button', b: [340, 62, 390, 106], t: 'Edit', f: 'c'}];
    expect(backButton(buildSnapshot(app, root))).toBeUndefined();
  });

  const device = async (nodes: UiNode[]) => {
    const {DeviceUi} = await import('./ui/device.ts');
    const calls: string[] = [];
    let back = false;
    const runner = {
      call: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'key' && args.code === 4) throw new Error('key code 4 has no equivalent on this device (home, enter and del do)');
        if (cmd === 'tap' || cmd === 'swipe') {
          calls.push(`${cmd} ${JSON.stringify(cmd === 'tap' ? {x: args.x, y: args.y} : args)}`);
          back = true;
        }
        if (cmd === 'tree') return {windows: app, nodes: back ? [{p: -1, w: 0, c: 'Text', b: [0, 100, 400, 140], t: 'Home', id: 'home'}] : nodes};
        if (cmd === 'info') return {width: 402, height: 874};
        return {idle: true};
      },
      stop: async () => undefined,
    };
    return {ui: new DeviceUi('sim', runner as never), calls};
  };

  it("presses the navigation bar's back button", async () => {
    const {ui, calls} = await device(pushed);
    const r = await ui.key(['back']);
    expect(calls).toEqual(['tap {"x":38,"y":84}']);
    expect(r.note).toMatch(/navigation bar's back button "Back"/);
  });

  it('swipes in from the left edge when there is no back button', async () => {
    const {ui, calls} = await device(pushed.slice(3));
    const r = await ui.key(['back']);
    expect(calls).toEqual(['swipe {"x1":1,"y1":437,"x2":302,"y2":437,"duration":300}']);
    expect(r.note).toMatch(/swiped in from the left edge/);
  });
});
