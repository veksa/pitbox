import {describe, expect, it} from 'vitest';
import {parseFlow, validateFlow} from './flows/flow.ts';
import {parseArgs, toCall} from './cli.ts';
import {DeviceUi} from './ui/device.ts';
import {buildSnapshot, type Bounds, type UiNode, type UiWindow} from './ui/snapshot.ts';
import {dropHint, freeSpot, menuItems, homeWidget, homeWidgets, iosGalleryPage, iosHomeWidgets, iosPages, iosSizes, parseWidget, springboardTurn, turnBounds, pickEntry, pickerEntries, pickerHeader, widget} from './ui/widget.ts';

const LAUNCHER = 'com.android.launcher3';
const launcher: UiWindow[] = [{type: 'app', title: '', pkg: LAUNCHER}];
const snap = (nodes: UiNode[], windows = launcher) => buildSnapshot(windows, nodes);
const SB: UiWindow[] = [{type: 'app', title: '', pkg: 'com.apple.springboard'}];

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
    expect(pickerEntries(snap(old))).toEqual([{index: 2, name: 'Note', size: '2x1'}]);
  });

  it('reads a cell in any language from its class, its name view and the numbers after the name', () => {
    const cell: UiNode[] = [
      {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 2400]},
      {p: 0, w: 0, c: 'WidgetCell', b: [69, 843, 1011, 1532], d: 'Widget „Notizen 2“, Breite: 4, Höhe: 2 Zeigt 3 Notizen.', f: 'cf'},
      {p: 1, w: 0, c: 'FrameLayout', b: [69, 885, 1011, 1345], id: 'widget_preview_container', f: 'clf'},
      {p: 2, w: 0, c: 'WidgetCell$2', b: [69, 885, 1011, 1345], d: 'Notizen 2'},
      {p: 0, w: 0, c: 'WidgetCell', b: [69, 1532, 529, 2122], d: 'Виджет "Заметка", ширина: 3, высота: 1', f: 'cf'},
      {p: 4, w: 0, c: 'TextView', b: [190, 1987, 407, 2038], id: 'widget_name', t: 'Заметка'},
    ];
    expect(pickerEntries(snap(cell)).map(e => `${e.name} ${e.size}`)).toEqual(['Notizen 2 4x2', 'Заметка 3x1']);
  });

  it('tries the menu row that opens the picker by its place when its words are not English', () => {
    const menu = (words: string[]): UiNode[] => [
      {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 2400], id: 'drag_layer'},
      {p: 0, w: 0, c: 'LinearLayout', b: [135, 996, 702, 1559], id: 'popup_container'},
      ...words.flatMap((t, k): UiNode[] => [
        {p: 1, w: 0, c: 'FrameLayout', b: [135, 996 + k * 140, 702, 1133 + k * 140], id: 'system_shortcut', f: 'clf'},
        {p: 2 + k * 2, w: 0, c: 'TextView', b: [135, 996 + k * 140, 702, 1133 + k * 140], id: 'bubble_text', t},
      ]),
    ];
    expect(menuItems(snap(menu(['Hintergrund', 'Widgets', 'Einstellungen'])))).toEqual([4, 2, 6]);
    expect(menuItems(snap(menu(['Обои и стиль', 'Виджеты', 'Главный экран'])))).toEqual([4, 2, 6]);
    expect(menuItems(snap(menu(['Wallpapers', 'Home settings', 'Widgets'])))).toEqual([6, 4, 2]);
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
  let carrying = false;
  let finger = {x: 0, y: 0};
  const calls: string[] = [];
  const at = (b: Bounds, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  const WIDGET: Bounds = [60, 900, 1020, 1400];
  const REMOVE: Bounds = [100, 100, 400, 250];
  const tree = (): {windows: UiWindow[]; nodes: UiNode[]} => {
    const root: UiNode = {p: -1, w: 0, c: 'FrameLayout', b: [0, 0, 1080, 2400], id: 'workspace', f: 's'};
    const homeNodes: UiNode[] = [root, {p: 0, w: 0, c: 'TextView', b: [60, 1500, 260, 1750], t: 'MyApp', d: 'MyApp', f: 'cl'}];
    if (placed) homeNodes.push({p: 0, w: 0, c: 'FrameLayout', b: WIDGET, d: 'Note'});
    if (screen === 'drag') homeNodes.push({p: 0, w: 0, c: 'Button', b: REMOVE, id: 'delete_target_text', t: 'Remove', f: 'c'});
    if (screen === 'drag' && carrying) homeNodes.push({p: 0, w: 0, c: 'View', b: [finger.x - 270, finger.y - 250, finger.x + 270, finger.y + 250], d: 'Move to row 2 column 1 in Home screen 1 of 1'});
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
        // The dragged view hangs under the finger and carries the launcher's answer.
        finger = {x, y};
        if (a.phase === 'down') held = at(WIDGET, x, y) || (screen === 'chosen' && at([0, 600, 540, 1100], x, y));
        if (a.phase === 'move' && held && screen === 'chosen') [screen, carrying] = ['drag', true];
        else if (a.phase === 'move' && held && placed) screen = 'drag';
        if (a.phase === 'up') {
          if (screen === 'drag' && at(REMOVE, x, y)) placed = false;
          else if (carrying) placed = true;
          held = false;
          carrying = false;
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
  it('reads where a dragged widget would land in any language, only on the view under the finger', () => {
    const node = (d: string, extra: Partial<UiNode> = {}): UiNode => ({c: 'FrameLayout', b: [199, 688, 744, 1233], d, ...extra}) as UiNode;
    const finger = {x: 400, y: 900};
    expect(dropHint(node('Move to row 2 column 1 in Home screen 1 of 1'), finger)).toBe(true);
    expect(dropHint(node('In Zeile 2, Spalte 2 verschoben'), finger)).toBe(true);
    expect(dropHint(node('In Zeile 2, Spalte 2 verschoben'), {x: 900, y: 900})).toBe(false);
    expect(dropHint(node('14:20', {t: '14:20'}), finger)).toBe(false);
    expect(dropHint(node('Akku bei 100 Prozent.', {id: 'battery'}), finger)).toBe(false);
  });

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

  it('is refused on a foldable iPhone, whose SpringBoard lists both screens', async () => {
    const root = (b: Bounds): UiNode => ({p: -1, w: 0, c: 'Other', b, id: 'Home screen icons'});
    const runner = {
      call: async (cmd: string) => (cmd === 'tree' ? {windows: SB, nodes: [root([0, 0, 669, 951]), root([0, 0, 466, 678])]} : cmd === 'info' ? {width: 466, height: 678} : {idle: true}),
      stop: async () => undefined,
    };
    await expect(widget(new DeviceUi('sim', runner as never), 'ios', parseWidget('list'))).rejects.toThrow(/not supported on a foldable iPhone/);
  }, 20_000);

  it('refuses a size the platform does not have', async () => {
    const runner = {call: async () => ({}), stop: async () => undefined};
    await expect(widget(new DeviceUi('sim', runner as never), 'ios', parseWidget('add Note size=4x2'))).rejects.toThrow(/size on iOS is one of small/);
    await expect(widget(new DeviceUi('dev', runner as never), 'android', parseWidget('add Note size=medium'))).rejects.toThrow(/medium is an iOS size/);
  });
});


describe('the iOS home screen', () => {
  // Labels and values are in whatever language the device speaks: only ids, types and shapes are read.
  const home: UiNode[] = [
    {p: -1, w: 0, c: 'Other', b: [0, 0, 402, 874], id: 'Home screen icons'},
    {p: 0, w: 0, c: 'Icon', b: [210, 88, 378, 279], t: 'MyApp', d: 'Widget, Stack', id: 'MyApp', f: 'c'},
    {p: 1, w: 0, c: 'Other', b: [212, 90, 376, 254], id: 'widget-stack:<MyApp,Other app>'},
    {p: 2, w: 0, c: 'ScrollView', b: [212, 90, 376, 254], f: 's'},
    {p: 0, w: 0, c: 'Icon', b: [24, 88, 193, 279], t: 'Notes', d: 'Widget', id: 'Notes', f: 'c'},
    {p: 4, w: 0, c: 'ScrollView', b: [26, 90, 191, 254], f: 's'},
    {p: 0, w: 0, c: 'Icon', b: [20, 289, 104, 379], t: 'MyApp', d: 'Wednesday', id: 'MyApp', f: 'c'},
    {p: 0, w: 0, c: 'Icon', b: [121, 289, 189, 379], t: 'Tools folder', d: '2 apps', id: 'Tools', f: 'c'},
    {p: 0, w: 0, c: 'Other', b: [163, 704, 239, 739], t: 'Seite 2 von 3', id: 'Page control'},
  ];

  it('tells widgets from app icons and folders by the content inside them', () => {
    expect(iosHomeWidgets(snap(home, SB))).toEqual([
      {index: 4, label: 'Notes'},
      {index: 1, label: 'MyApp', stack: ['MyApp', 'Other app']},
    ]);
  });

  it('finds widgets by their size while the page is being edited and their content is out of the tree', () => {
    const editing: UiNode[] = [
      {p: -1, w: 0, c: 'Other', b: [0, 0, 402, 874], id: 'Home screen icons'},
      {p: 0, w: 0, c: 'Button', b: [36, 19, 102, 47], t: 'Bearbeiten', f: 'c'},
      {p: 0, w: 0, c: 'Icon', b: [24, 88, 193, 279], t: 'Notes', d: 'Widget', id: 'Notes', f: 'c'},
      {p: 2, w: 0, c: 'Button', b: [20, 83, 46, 109], id: 'DeleteButton', f: 'c'},
      {p: 0, w: 0, c: 'Icon', b: [210, 88, 378, 279], t: 'MyApp', d: 'Widget', id: 'MyApp', f: 'c'},
      {p: 0, w: 0, c: 'Icon', b: [28, 289, 96, 379], t: 'Other app', id: 'Other app', f: 'c'},
      {p: 5, w: 0, c: 'Button', b: [20, 281, 46, 307], id: 'DeleteButton', f: 'c'},
    ];
    expect(iosHomeWidgets(snap(editing, SB)).map(x => x.label)).toEqual(['Notes', 'MyApp']);
  });

  it('reads the page from the page control\'s numbers in any language', () => {
    expect(iosPages(snap(home, SB))).toEqual({page: 2, pages: 3});
    expect(iosPages(snap(home.slice(0, 8), SB))).toEqual({page: 1, pages: 1});
  });
});

describe('the iOS widget gallery', () => {
  const page = (b: Bounds, label = 'MyApp, Up next'): UiNode[] => [
    {p: -1, w: 0, c: 'Other', b: [-402, -874, 804, 1748], id: 'PopoverDismissRegion'},
    {p: 0, w: 0, c: 'CollectionView', b: [0, 306, 402, 729], f: 's'},
    {p: 1, w: 0, c: 'Button', b, t: label, d: 'Widget, Klein', f: 'c'},
    {p: 0, w: 0, c: 'PageIndicator', b: [24, 735, 378, 766], t: '1 / 8'},
    {p: 0, w: 0, c: 'Button', b: [24, 766, 378, 816], t: 'Widget hinzufügen', f: 'c'},
    {p: 0, w: 0, c: 'Button', b: [359, 153, 381, 174], t: 'Close', f: 'c'},
  ];

  it('reads the widget\'s name after the app\'s and finds the Add button below it', () => {
    expect(iosGalleryPage(snap(page([119, 435, 283, 600]), SB), 'myapp')).toEqual({preview: 2, add: 4, name: 'Up next', label: 'MyApp, Up next', box: [119, 435, 283, 600]});
    expect(iosGalleryPage(snap(page([119, 435, 283, 600], 'Other app, Up next'), SB), 'MyApp')).toBeUndefined();
  });

  it('tells the sizes from the previews\' shapes, all drawn to one scale', () => {
    // A phone's gallery and a tablet's, which draws the same sizes smaller.
    expect(iosSizes([[119, 435, 283, 600], [45, 444, 357, 591], [45, 355, 357, 680], [89, 336, 314, 699]])).toEqual(['small', 'medium', 'large', 'extra large portrait']);
    expect(iosSizes([[411, 544, 531, 664], [300, 560, 640, 680], [354, 487, 588, 721], [230, 487, 710, 721]])).toEqual(['small', 'medium', 'large', 'extra large']);
    expect(iosSizes([[354, 487, 588, 721], [411, 544, 531, 664]])).toEqual(['large', 'small']);
  });
});

describe('an iPad on its side', () => {
  const icon = (b: Bounds, label: Bounds): UiNode[] => [
    {p: 0, w: 0, c: 'Icon', b, t: 'MyApp', id: 'MyApp', f: 'c'},
    {p: -2, w: 0, c: 'Other', b: label, id: 'label-view'},
  ];
  const page = (...icons: UiNode[][]): UiNode[] => {
    const nodes: UiNode[] = [{p: -1, w: 0, c: 'Other', b: [0, 0, 756, 1158], id: 'Home screen icons'}];
    for (const [i, l] of icons) {
      nodes.push(i!);
      nodes.push({...l!, p: nodes.length - 1});
    }
    return nodes;
  };

  it('tells how the home screen\'s frames are turned from where its icons\' names lie', () => {
    expect(springboardTurn(page(icon([106, 107, 182, 190], [100, 168, 188, 188])), 756)).toBe(0);
    expect(springboardTurn(page(icon([589, 190, 684, 268], [591, 192, 611, 266])), 756)).toBe(90);
    expect(springboardTurn(page(icon([211, 333, 306, 405], [284, 341, 304, 398])), 756)).toBe(270);
    expect(springboardTurn([{p: -1, w: 0, c: 'Other', b: [0, 0, 756, 1158], id: 'PopoverDismissRegion'}], 756)).toBeUndefined();
  });

  it('turns a frame into the space a finger touches', () => {
    // A stack drawn at the top left of the turned screen, reported along the upright frame's right edge.
    expect(turnBounds([430, 167, 711, 431], 90, 756, 1158)).toEqual([167, 45, 431, 326]);
    expect(turnBounds([430, 167, 711, 431], 270, 756, 1158)).toEqual([727, 430, 991, 711]);
    expect(turnBounds([1, 2, 3, 4], 0, 756, 1158)).toEqual([1, 2, 3, 4]);
  });
});
