import {describe, expect, it} from 'vitest';
import {parseFlow, validateFlow} from './flows/flow.ts';
import {parseArgs, toCall} from './cli.ts';
import {DeviceUi} from './ui/device.ts';
import {buildSnapshot, type Bounds, type UiNode, type UiWindow} from './ui/snapshot.ts';
import {freeSpot, homeWidget, homeWidgets, parseWidget, pickEntry, pickerEntries, pickerHeader, widget} from './ui/widget.ts';

const LAUNCHER = 'com.android.launcher3';
const launcher: UiWindow[] = [{type: 'app', title: '', pkg: LAUNCHER}];
const snap = (nodes: UiNode[], windows = launcher) => buildSnapshot(windows, nodes);

describe('widget commands', () => {
  it('parse a quoted name, the app and the size', () => {
    expect(parseWidget('add "World clock" app="MyApp" size=4X2')).toEqual({op: 'add', name: 'World clock', app: 'MyApp', size: '4x2'});
    expect(parseWidget('remove World clock')).toEqual({op: 'remove', name: 'World clock'});
    expect(parseWidget('add Notes', {app: 'MyApp', size: 'Extra  Large'})).toEqual({op: 'add', name: 'Notes', app: 'MyApp', size: 'extra large'});
    expect(parseWidget('list MyApp')).toEqual({op: 'list', app: 'MyApp'});
    expect(parseWidget('list')).toEqual({op: 'list', app: undefined});
    expect(() => parseWidget('add')).toThrow(/needs the widget's name/);
    expect(() => parseWidget('move Notes')).toThrow(/widget add <name>/);
  });

  it('are checked in a flow and keep their quotes on the way to the engine', () => {
    expect(validateFlow(parseFlow('widget add "Notes" app="MyApp"\nwidget remove "Notes"\nwidget list'))).toEqual([]);
    expect(validateFlow(parseFlow('widget add\nwidget move x'))).toHaveLength(2);
  });

  it('map from the command line', () => {
    expect(toCall(parseArgs(['widget', 'add', 'World clock', '--app', 'MyApp', '--size', '4x2']))).toEqual({
      method: 'widget',
      params: {device: undefined, value: 'add "World clock"', app: 'MyApp', size: '4x2'},
    });
  });
});

describe('the Android widget picker', () => {
  const picker: UiNode[] = [
    {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 2400], id: 'container'},
    {p: 0, w: 0, c: 'LinearLayout', b: [0, 300, 1080, 450], id: 'widgets_list_header', f: 'c'},
    {p: 1, w: 0, c: 'TextView', b: [200, 320, 800, 380], id: 'app_title', t: 'MyApp'},
    {p: 0, w: 0, c: 'LinearLayout', b: [0, 450, 1080, 600], id: 'widgets_list_header', f: 'c'},
    {p: 3, w: 0, c: 'TextView', b: [200, 470, 800, 530], id: 'app_title', t: 'Other app'},
    {p: 0, w: 0, c: 'LinearLayout', b: [0, 600, 540, 1100], d: 'Four notes widget, 4 wide by 2 high Pinned notes', f: 'c'},
    {p: 0, w: 0, c: 'LinearLayout', b: [540, 600, 1080, 1100], d: 'Note widget, 2 wide by 2 high', f: 'c'},
    {p: 0, w: 0, c: 'LinearLayout', b: [0, 1100, 540, 1600], d: 'Note widget, 4 wide by 4 high', f: 'c'},
  ];

  it('reads each widget\'s name and size from its label', () => {
    expect(pickerEntries(snap(picker)).map(e => `${e.name} ${e.size}`)).toEqual(['Four notes 4x2', 'Note 2x2', 'Note 4x4']);
  });

  it('picks a widget by its whole name, not by a part of another one', () => {
    const entries = pickerEntries(snap(picker));
    expect(pickEntry(entries, 'note')?.size).toBe('2x2');
    expect(pickEntry(entries, 'Note', '4x4')?.index).toBe(7);
    expect(pickEntry(entries, 'Note', '1x1')).toBeUndefined();
    expect(pickEntry(entries, 'notes')).toBeUndefined();
  });

  it('reads an older cell from its name and size views', () => {
    const old: UiNode[] = [
      {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 2400]},
      {p: 0, w: 0, c: 'LinearLayout', b: [0, 600, 540, 1100], f: 'l'},
      {p: 1, w: 0, c: 'ImageView', b: [20, 620, 520, 980], id: 'widget_preview'},
      {p: 1, w: 0, c: 'TextView', b: [20, 1000, 300, 1050], id: 'widget_name', t: 'Note'},
      {p: 1, w: 0, c: 'TextView', b: [320, 1000, 520, 1050], id: 'widget_dims', t: '2 × 1'},
    ];
    expect(pickerEntries(snap(old))).toEqual([{index: 1, name: 'Note', size: '2x1'}]);
  });

  it('finds the app\'s header by its title, not by the search text', () => {
    const withSearch: UiNode[] = [...picker, {p: 0, w: 0, c: 'EditText', b: [0, 100, 1080, 200], id: 'widgets_search_bar_edit_text', t: 'Other app', f: 'ce'}];
    expect(pickerHeader(snap(withSearch), 'Other app')).toBe(3);
    expect(pickerHeader(snap(picker), 'MyApp')).toBe(1);
    expect(pickerHeader(snap(picker), 'Missing')).toBeUndefined();
  });
});

describe('the Android home screen', () => {
  const home: UiNode[] = [
    {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 2400], id: 'workspace', f: 's'},
    {p: 0, w: 0, c: 'FrameLayout', b: [60, 200, 1020, 700], d: 'Notes', f: 'l'},
    {p: 1, w: 0, c: 'FrameLayout', b: [80, 220, 1000, 680], d: 'Pinned list'},
    {p: 1, w: 0, c: 'Button', b: [100, 300, 400, 400], d: 'New note', f: 'c'},
    {p: 0, w: 0, c: 'TextView', b: [60, 1500, 260, 1750], t: 'Notes', d: 'Notes', f: 'cl'},
    {p: 0, w: 0, c: 'FrameLayout', b: [0, 1900, 1080, 2400], id: 'hotseat'},
    {p: 5, w: 0, c: 'TextView', b: [60, 1900, 260, 2100], t: 'Phone', f: 'c'},
  ];

  it('tells a widget from an app icon of the same name', () => {
    expect(homeWidget(snap(home), 'notes')).toBe(1);
    expect(homeWidget(snap(home), 'Phone')).toBeUndefined();
  });

  it('lists the widgets, not the labelled views inside them', () => {
    expect(homeWidgets(snap(home), [0, 0, 1080, 2400])).toEqual(['Notes']);
  });

  it('finds an empty spot away from icons, widgets and bars', () => {
    const s = freeSpot(snap(home), [0, 0, 1080, 2400])!;
    const on = (b: Bounds) => s.x >= b[0] && s.x <= b[2] && s.y >= b[1] && s.y <= b[3];
    expect(home.slice(1).some(n => on(n.b))).toBe(false);
    expect(s.y).toBeGreaterThan(700);
    expect(s.y).toBeLessThan(1900);
  });

  it('has no empty spot when everything is covered', () => {
    const full: UiNode[] = [{p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1000, 1000], id: 'workspace'}];
    for (let y = 0; y < 1000; y += 100) for (let x = 0; x < 1000; x += 250) full.push({p: 0, w: 0, c: 'TextView', b: [x, y, x + 250, y + 100], t: `${x}-${y}`, f: 'c'});
    expect(freeSpot(snap(full), [0, 0, 1000, 1000])).toBeUndefined();
  });
});

/** A Launcher3 that answers the runner's calls: home, its menu, the picker, the Add button and the Remove target. */
const fakeLauncher = (opts: {addButton?: boolean} = {}) => {
  let screen: 'home' | 'menu' | 'picker' | 'expanded' | 'chosen' | 'drag' = 'home';
  let placed = false;
  let held = false;
  const calls: string[] = [];
  const at = (b: Bounds, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  const WIDGET: Bounds = [60, 900, 1020, 1400];
  const REMOVE: Bounds = [100, 100, 400, 250];
  const tree = (): {windows: UiWindow[]; nodes: UiNode[]} => {
    const root: UiNode = {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 2400], id: 'workspace', f: 's'};
    const homeNodes: UiNode[] = [root, {p: 0, w: 0, c: 'TextView', b: [60, 1500, 260, 1750], t: 'MyApp', d: 'MyApp', f: 'cl'}];
    if (placed) homeNodes.push({p: 0, w: 0, c: 'FrameLayout', b: WIDGET, d: 'Note'});
    if (screen === 'drag') homeNodes.push({p: 0, w: 0, c: 'Button', b: REMOVE, id: 'delete_target_text', t: 'Remove', f: 'c'});
    if (screen === 'home' || screen === 'drag') return {windows: launcher, nodes: homeNodes};
    if (screen === 'menu') return {windows: launcher, nodes: [...homeNodes, {p: 0, w: 0, c: 'Button', b: [300, 1000, 800, 1100], f: 'c'}, {p: 2 + Number(placed), w: 0, c: 'TextView', b: [320, 1020, 780, 1080], t: 'Widgets', id: 'bubble_text'}]};
    const picker: UiNode[] = [
      {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 2400], id: 'container'},
      {p: 0, w: 0, c: 'EditText', b: [0, 100, 1080, 200], id: 'widgets_search_bar_edit_text', f: 'ce'},
      {p: 0, w: 0, c: 'LinearLayout', b: [0, 300, 1080, 450], id: 'widgets_list_header', f: 'c'},
      {p: 2, w: 0, c: 'TextView', b: [200, 320, 800, 380], id: 'app_title', t: 'MyApp'},
    ];
    if (screen !== 'picker') picker.push({p: 0, w: 0, c: 'LinearLayout', b: [0, 600, 540, 1100], d: 'Note widget, 2 wide by 2 high', f: 'c'});
    if (screen === 'chosen' && opts.addButton !== false) picker.push({p: 0, w: 0, c: 'Button', b: [700, 2000, 900, 2100], id: 'widget_add_button', t: 'Add', f: 'c'});
    return {windows: launcher, nodes: picker};
  };
  const runner = {
    call: async (cmd: string, a: Record<string, unknown> = {}) => {
      const x = Number(a.x);
      const y = Number(a.y);
      if (cmd === 'info') return {width: 1080, height: 2400};
      if (cmd === 'tree') return tree();
      if (cmd === 'idle') return {idle: true};
      calls.push(cmd === 'touch' ? `touch ${a.phase}` : cmd);
      if (cmd === 'key' && a.code === 3) screen = 'home';
      if (cmd === 'longpress' && screen === 'home') screen = 'menu';
      if (cmd === 'tap' && screen === 'menu' && at([300, 1000, 800, 1100], x, y)) screen = 'picker';
      else if (cmd === 'tap' && screen === 'picker' && at([0, 300, 1080, 450], x, y)) screen = 'expanded';
      else if (cmd === 'tap' && screen === 'expanded' && at([0, 600, 540, 1100], x, y)) screen = 'chosen';
      else if (cmd === 'tap' && screen === 'chosen' && at([700, 2000, 900, 2100], x, y)) [screen, placed] = ['home', true];
      if (cmd === 'text') return {set: true};
      if (cmd === 'touch') {
        if (a.phase === 'down') held = at(WIDGET, x, y) || (screen === 'chosen' && at([0, 600, 540, 1100], x, y));
        if (a.phase === 'move' && held && screen === 'chosen') screen = 'home';
        else if (a.phase === 'move' && held && placed) screen = 'drag';
        if (a.phase === 'up') {
          if (screen === 'drag' && at(REMOVE, x, y)) placed = false;
          else if (held && !placed && screen === 'home') placed = true;
          held = false;
          screen = 'home';
        }
      }
      return {};
    },
    stop: async () => undefined,
  };
  return {ui: new DeviceUi('emulator-5554', runner as never), calls, placed: () => placed};
};

describe('a widget on a Launcher3 home screen', () => {
  it('is added through the picker\'s Add button and removed by dragging it to Remove', async () => {
    const l = fakeLauncher();
    const added = await widget(l.ui, 'android', parseWidget('add Note app=MyApp'));
    expect(added).toMatchObject({widget: 'Note', size: '2x2', via: 'add button', on: 'home'});
    expect(l.placed()).toBe(true);
    const removed = await widget(l.ui, 'android', parseWidget('remove Note'));
    expect(removed).toMatchObject({widget: 'Note', removed: true});
    expect(l.placed()).toBe(false);
  }, 60_000);

  it('is dragged out of a picker that has no Add button', async () => {
    const l = fakeLauncher({addButton: false});
    const added = await widget(l.ui, 'android', parseWidget('add Note app=MyApp'));
    expect(added).toMatchObject({widget: 'Note', via: 'drag'});
    expect(l.calls).toContain('touch down');
  }, 60_000);

  it('records one flow step for the whole operation', async () => {
    const l = fakeLauncher();
    l.ui.recording = [];
    await widget(l.ui, 'android', parseWidget('add Note app=MyApp'));
    expect(l.ui.recording).toEqual(['widget add "Note" app="MyApp"']);
  }, 60_000);

  it('names a launcher it does not know instead of tapping at it', async () => {
    const runner = {
      call: async (cmd: string) => (cmd === 'tree' ? {windows: [{type: 'app', title: '', pkg: 'com.example.launcher'}], nodes: [{p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 2400], id: 'home_root'}]} : cmd === 'info' ? {width: 1080, height: 2400} : {idle: true}),
      stop: async () => undefined,
    };
    await expect(widget(new DeviceUi('dev', runner as never), 'android', parseWidget('add Note'))).rejects.toThrow(/launcher com\.example\.launcher is not supported/);
  }, 20_000);
});
