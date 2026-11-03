// What an agent sees of a screen: one short line per node worth acting on or reading, with a ref (`@e12`).
// An interactive container without a label takes its descendants' text and those text nodes are folded into
// it, so a button is one line, not three. Platform-neutral: drivers produce `UiNode`s.

export type Bounds = [number, number, number, number];

export type UiNode = {
  /** Parent index in the flat list, -1 for a root. */
  p: number;
  /** Window index. */
  w: number;
  /** Class name without package. */
  c: string;
  b: Bounds;
  id?: string;
  t?: string;
  d?: string;
  h?: string;
  /** Flags: c clickable, l long-clickable, f focusable, F focused, A a11y-focused, e editable, s scrollable, x/X checkable/checked, S selected, d disabled, p password. */
  f?: string;
  /** Place in the window's painting, later on top (Android): follows elevation, unlike the tree's order. */
  z?: number;
};

export type UiWindow = {type: string; title: string; pkg: string};

/** Packages of the platform's own apps: the permission controller, the package installer, the launcher. */
const SYSTEM_APP = /^com\.(google\.)?android\.(permissioncontroller|packageinstaller|launcher|apps\.nexuslauncher)/;
const PERMISSION_APP = /^com\.(google\.)?android\.(permissioncontroller|packageinstaller)$/;

/** The question of a runtime permission request over the app ("Allow MyApp to send you notifications?"), if any. */
export const permissionPrompt = (snap: Pick<Snapshot, 'windows' | 'nodes'>): string | undefined => {
  const w = snap.windows.findIndex(x => PERMISSION_APP.test(x.pkg));
  if (w < 0) return undefined;
  const nodes = snap.nodes.filter(n => n.w === w);
  return (nodes.find(n => n.id === 'permission_message') ?? nodes.find(n => n.t && /\?\s*$/.test(n.t)))?.t ?? 'a permission request';
};

export type Snapshot = {
  windows: UiWindow[];
  nodes: UiNode[];
  lines: string[];
  /** ref → node index */
  refs: Map<string, number>;
  /** node index → ref, for nodes that got a line */
  refOf: Map<number, string>;
  /** node index → the string its line quotes (its text, or the label folded in from its children) */
  shown?: Map<number, string>;
};

const has = (n: UiNode, flag: string) => (n.f ?? '').includes(flag);
export const interactive = (n: UiNode) => /[clesxX]/.test(n.f ?? '');

const role = (n: UiNode): string => {
  const c = n.c.toLowerCase();
  if (has(n, 'e') || c.includes('edittext')) return 'field';
  if (has(n, 'x') || has(n, 'X') || /checkbox|switch|toggle|radio/.test(c)) return 'check';
  if (c.includes('button')) return 'button';
  if (has(n, 's') || /scroll|recycler|listview|pager|gridview/.test(c)) return 'list';
  if (c.includes('image')) return has(n, 'c') ? 'button' : 'image';
  if (c.includes('textview') || c === 'text') return has(n, 'c') ? 'button' : 'text';
  if (has(n, 'c')) return 'button';
  return 'view';
};

const clean = (s: string, max = 80) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** Descendant indexes per node, from the flat parent links. */
const childrenOf = (nodes: UiNode[]) => {
  const kids = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    const list = kids.get(n.p) ?? [];
    list.push(i);
    kids.set(n.p, list);
  });
  return kids;
};

const descendants = (kids: Map<number, number[]>, i: number): number[] => {
  const out: number[] = [];
  const stack = [...(kids.get(i) ?? [])];
  while (stack.length) {
    const j = stack.shift()!;
    out.push(j);
    stack.push(...(kids.get(j) ?? []));
  }
  return out;
};

export type SnapshotOptions = {
  /** Include system UI (status and navigation bars). */
  system?: boolean;
  /** Screen height, to mark nodes below the fold. */
  height?: number;
  /** Append each node's bounds `[l,t,r,b]` — for gestures that need coordinates. */
  bounds?: boolean;
};

export const buildSnapshot = (windows: UiWindow[], nodes: UiNode[], opts: SnapshotOptions = {}): Snapshot => {
  const kids = childrenOf(nodes);
  const hidden = new Set<number>();
  const label = new Map<number, string>();

  nodes.forEach((n, i) => {
    const w = windows[n.w];
    // System UI windows (bars, and on XR the shell's own panels and window captions) unless asked for.
    if (!opts.system && w && w.pkg?.startsWith('com.android.systemui')) hidden.add(i);
  });

  // Fold unlabelled interactive containers with their text descendants — but not lists (they hold many items),
  // and never through another interactive descendant, whose texts are its own.
  nodes.forEach((n, i) => {
    if (hidden.has(i) || !interactive(n) || n.t || n.d || has(n, 'e') || has(n, 's')) return;
    const texts: string[] = [];
    const stack = [...(kids.get(i) ?? [])];
    while (stack.length) {
      const j = stack.shift()!;
      const m = nodes[j]!;
      if (interactive(m)) continue;
      const s = m.t ?? m.d;
      if (s && !m.id) {
        texts.push(s);
        hidden.add(j);
      }
      stack.push(...(kids.get(j) ?? []));
    }
    if (texts.length) label.set(i, texts.slice(0, 3).join(' · '));
  });

  // A control whose description already says what its children say (React Native merges them): the children
  // without ids add nothing but tokens.
  nodes.forEach((n, i) => {
    if (hidden.has(i) || !interactive(n) || !n.d) return;
    const d = n.d.toLowerCase();
    const stack = [...(kids.get(i) ?? [])];
    while (stack.length) {
      const j = stack.shift()!;
      const m = nodes[j]!;
      if (interactive(m)) continue;
      const s = (m.t ?? m.d)?.toLowerCase();
      if (s && !m.id && d.includes(s)) hidden.add(j);
      stack.push(...(kids.get(j) ?? []));
    }
  });

  const lines: string[] = [];
  const refs = new Map<string, number>();
  const refOf = new Map<number, string>();
  const shown = new Map<number, string>();
  let lastWindow = -1;
  nodes.forEach((n, i) => {
    if (hidden.has(i)) return;
    const own = n.t ?? label.get(i) ?? (interactive(n) ? n.d : undefined);
    if (!own && !n.d && !n.id && !interactive(n)) return;
    if (own) shown.set(i, own);
    if (n.w !== lastWindow) {
      const w = windows[n.w];
      if (w && w.type !== 'app') lines.push(`— ${w.type}${w.title ? ` "${clean(w.title, 40)}"` : ''}`);
      // The first window is the app's, unless the system's own app is in front of it (a permission request, the
      // launcher): then say whose screen this is.
      else if (w && (lastWindow >= 0 || SYSTEM_APP.test(w.pkg))) lines.push(`— ${w.pkg}`);
      lastWindow = n.w;
    }
    const ref = `@e${refs.size + 1}`;
    refs.set(ref, i);
    refOf.set(i, ref);
    const parts = [ref, role(n)];
    if (own) parts.push(JSON.stringify(clean(own)));
    if (n.d && n.d !== own) parts.push(`(${clean(n.d, 60)})`);
    if (!own && n.h) parts.push(`hint ${JSON.stringify(clean(n.h, 40))}`);
    if (n.id) parts.push(`#${n.id}`);
    const flags = [has(n, 'F') && 'focused', (has(n, 'X') || has(n, 'S')) && 'on', has(n, 'x') && !has(n, 'X') && 'off', has(n, 'd') && 'disabled', opts.height && n.b[1] >= opts.height && 'below'].filter(Boolean);
    if (flags.length) parts.push(`[${flags.join(' ')}]`);
    if (opts.bounds) parts.push(`@[${n.b.join(',')}]`);
    lines.push(parts.join(' '));
  });
  return {windows, nodes, lines, refs, refOf, shown};
};

/** Lines without their refs, for comparing two snapshots. */
const key = (line: string) => line.replace(/^@e\d+ /, '');

export type SnapshotDiff = {changed: boolean; full: boolean; lines: string[]};

/** What changed: added lines with their new refs and removed lines; the whole snapshot when most of it changed. */
export const diffSnapshots = (before: Snapshot | undefined, after: Snapshot): SnapshotDiff => {
  if (!before) return {changed: true, full: true, lines: after.lines};
  const old = new Map<string, number>();
  for (const l of before.lines) old.set(key(l), (old.get(key(l)) ?? 0) + 1);
  const added: string[] = [];
  for (const l of after.lines) {
    const k = key(l);
    const c = old.get(k) ?? 0;
    if (c > 0) old.set(k, c - 1);
    else added.push(`+ ${l}`);
  }
  const removed = [...old.entries()].flatMap(([k, c]) => Array.from({length: c}, () => `- ${k}`));
  const total = Math.max(before.lines.length, after.lines.length, 1);
  if (!added.length && !removed.length) return {changed: false, full: false, lines: []};
  if ((added.length + removed.length) / total > 0.6) return {changed: true, full: true, lines: after.lines};
  return {changed: true, full: false, lines: [...added, ...removed.slice(0, 15), ...(removed.length > 15 ? [`- … ${removed.length - 15} more`] : [])]};
};

export type Target = {node?: UiNode; index?: number; x: number; y: number; ref?: string};

const centre = (b: Bounds) => ({x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2)});

/**
 * Resolves a selector against a snapshot:
 * `@e12` · `id=submit` · `text=Continue` / `text~=Contin` · `label=Close` / `label~=…` · `540,1200` · bare words
 * (id, text or label, exact first, then contains). Several matches prefer interactive nodes, then reading order.
 */
export const resolveTarget = (snap: Snapshot, selector: string): Target => {
  const sel = selector.trim();
  const point = /^(\d+)\s*,\s*(\d+)$/.exec(sel);
  if (point) return {x: Number(point[1]), y: Number(point[2])};
  if (/^@e\d+$/.test(sel)) {
    const i = snap.refs.get(sel);
    if (i === undefined) throw new Error(`unknown ref ${sel} — refs change after every snapshot; take a fresh one`);
    const node = snap.nodes[i]!;
    return {node, index: i, ref: sel, ...centre(node.b)};
  }
  const m = /^(id|text|label)(~?=)(.*)$/s.exec(sel);
  // Lines show any run of whitespace (a no-break space too) as one space; selectors match what lines show.
  const lower = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  let match: (n: UiNode, i: number) => boolean;
  // `text=` matches what a line quotes: a control with no text of its own is shown by its label or by the text of
  // the children folded into it (`button "Close"`).
  const quoted = (n: UiNode, i: number) => n.t ?? snap.shown?.get(i) ?? (interactive(n) ? n.d : undefined);
  if (m) {
    const [, field, op, raw] = m;
    const v = lower(raw!.replace(/^["']|["']$/g, ''));
    const get = (n: UiNode, i: number) => lower(field === 'id' ? n.id : field === 'text' ? quoted(n, i) : n.d);
    match = op === '=' ? (n, i) => get(n, i) === v : (n, i) => get(n, i).includes(v);
  } else {
    const v = lower(sel.replace(/^["']|["']$/g, ''));
    const exact = (n: UiNode, i: number) => lower(n.id) === v || lower(quoted(n, i)) === v || lower(n.d) === v;
    match = snap.nodes.some(exact) ? exact : (n, i) => lower(quoted(n, i)).includes(v) || lower(n.d).includes(v) || lower(n.id).includes(v);
  }
  const hits = snap.nodes.map((n, i) => ({n, i})).filter(({n, i}) => match(n, i));
  if (!hits.length) {
    const prompt = permissionPrompt(snap);
    throw new Error(`nothing matches "${sel}"${prompt ? ` — a permission request is on top: "${prompt}"` : ''}`);
  }
  hits.sort((a, b) => Number(interactive(b.n)) - Number(interactive(a.n)));
  const best = hits[0]!;
  return {node: best.n, index: best.i, ref: snap.refOf.get(best.i), ...centre(best.n.b)};
};

/**
 * Where a tap reaches a node: its centre, or the point of it nearest the centre that nothing covers when something
 * painted over it (a floating button, an overlay, a window above) owns the centre. `coveredBy` names the cover.
 * Within a window the painting order (`z`) decides; without it only windows above count.
 */
export const tapPoint = (snap: Snapshot, index: number): {x: number; y: number; coveredBy?: string} => {
  const n = snap.nodes[index]!;
  const c = centre(n.b);
  const chain = (j: number) => {
    const out = new Set<number>();
    for (let k = j; k >= 0 && !out.has(k); k = snap.nodes[k]?.p ?? -1) out.add(k);
    return out;
  };
  const mine = chain(index);
  const meets = (a: Bounds, b: Bounds) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const drawn = (m: UiNode) => interactive(m) || !!m.t || !!m.d || /image/i.test(m.c);
  const above = (m: UiNode) => (m.w < n.w ? snap.windows[m.w]?.type === 'app' : m.w === n.w && m.z !== undefined && n.z !== undefined && m.z > n.z);
  const covers = snap.nodes
    .map((m, j) => ({m, j}))
    .filter(({m, j}) => drawn(m) && above(m) && meets(m.b, n.b) && !mine.has(j) && !chain(j).has(index));
  if (!covers.length) return c;
  const inside = (x: number, y: number) => covers.find(({m}) => x >= m.b[0] && x < m.b[2] && y >= m.b[1] && y < m.b[3]);
  const cover = inside(c.x, c.y);
  if (!cover) return c;
  const ref = snap.refOf.get(cover.j);
  const coveredBy = (ref && snap.lines.find(l => l.startsWith(`${ref} `))) || `${cover.m.c}${cover.m.t || cover.m.d ? ` "${cover.m.t ?? cover.m.d}"` : ''}`;
  const pts: {x: number; y: number}[] = [];
  for (let i = 0; i < 9; i++) {
    for (let k = 0; k < 9; k++) pts.push({x: Math.round(n.b[0] + ((n.b[2] - n.b[0]) * (i + 0.5)) / 9), y: Math.round(n.b[1] + ((n.b[3] - n.b[1]) * (k + 0.5)) / 9)});
  }
  pts.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y));
  const free = pts.find(p => !inside(p.x, p.y));
  return {...(free ?? c), coveredBy};
};

/** Whether a selector currently matches anything. */
export const matches = (snap: Snapshot, selector: string) => {
  try {
    resolveTarget(snap, selector);
    return true;
  } catch {
    return false;
  }
};

/** The best selector to record for a node: id, then exact text, then label, then its centre. */
export const selectorFor = (snap: Snapshot, index: number): string => {
  const n = snap.nodes[index]!;
  const unique = (pred: (m: UiNode) => boolean) => snap.nodes.filter(pred).length === 1;
  if (n.id && unique(m => m.id === n.id)) return `id=${n.id}`;
  if (n.t && unique(m => m.t === n.t)) return `text=${JSON.stringify(n.t)}`;
  if (n.d && unique(m => m.d === n.d)) return `label=${JSON.stringify(n.d)}`;
  const kids = childrenOf(snap.nodes);
  for (const j of descendants(kids, index)) {
    const m = snap.nodes[j]!;
    if (m.t && unique(o => o.t === m.t)) return `text=${JSON.stringify(m.t)}`;
  }
  const c = centre(n.b);
  return `${c.x},${c.y}`;
};

/**
 * The top edge of the on-screen keyboard, or undefined when none is shown. The keyboard's own views count, not
 * its window's root, which can span the whole screen (a split keyboard).
 */
export const keyboardTop = (snap: Snapshot, height: number): number | undefined => {
  const top = Math.min(...snap.nodes.filter(n => snap.windows[n.w]?.type === 'ime' && n.b[3] - n.b[1] < height * 0.6).map(n => n.b[1]));
  return Number.isFinite(top) ? top : undefined;
};

/**
 * Where a directional swipe should run: the app's largest scrollable view, above the keyboard. A swipe across the
 * whole screen starts on whatever is there — the keyboard a large screen keeps open, a tablet's taskbar — and
 * scrolls nothing.
 */
export const swipeArea = (snap: Snapshot | undefined, width: number, height: number): Bounds => {
  let area: Bounds = [0, 0, width, height];
  if (!snap) return area;
  const size = (b: Bounds) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  // The topmost app window that scrolls (windows come top layer first): on a desktop the launcher behind a small
  // app window has a larger scroller, and a swipe there moves nothing the app shows.
  const scrollables = snap.nodes.filter(n => (n.f ?? '').includes('s') && snap.windows[n.w]?.type === 'app' && size(n.b) > 0);
  const top = Math.min(...scrollables.map(n => n.w));
  const largest = scrollables.filter(n => n.w === top).sort((a, b) => size(b.b) - size(a.b))[0];
  const root = largest ? snap.nodes.find(n => n.w === largest.w && n.p === -1) : undefined;
  // Large within its own window: a small strip that happens to scroll (a chip row) is not the content.
  if (largest && size(largest.b) >= (root ? size(root.b) : width * height) * 0.3) area = [...largest.b];
  const imeTop = keyboardTop(snap, height) ?? Infinity;
  if (Number.isFinite(imeTop) && imeTop > area[1] + 100 && imeTop < area[3]) area = [area[0], area[1], area[2], imeTop];
  return area;
};

/**
 * A tap that only closed the on-screen keyboard: it was up before and is gone after, and nothing else on screen
 * changed. A scrolling list in React Native (keyboardShouldPersistTaps "never", the default) and many native forms
 * spend the first tap on closing the keyboard, so the control under the finger never got it.
 */
export const onlyClosedKeyboard = (before: Snapshot, after: Snapshot): boolean => {
  const ime = (s: Snapshot) => s.windows.some(w => w.type === 'ime');
  // React Native decides by the focused field, not by the keyboard: with a hardware keyboard (an emulator's)
  // there is none on screen, and the first tap still only takes the focus off the field; with a soft one the
  // keyboard may still be on its way down when the screen looks settled.
  const focusedField = (s: Snapshot) => s.nodes.some(n => s.windows[n.w]?.type !== 'ime' && (n.f ?? '').includes('e') && (n.f ?? '').includes('F'));
  const closed = ime(before) && !ime(after);
  const blurred = focusedField(before) && !focusedField(after);
  if (!closed && !blurred) return false;
  // A window the keyboard had shrunk grows back: what shows up where the keyboard was (more rows of a list) is
  // the screen coming back, not the tap's doing.
  const imeNodes = before.nodes.filter(n => before.windows[n.w]?.type === 'ime');
  const imeTop = imeNodes.length ? Math.min(...imeNodes.map(n => n.b[1])) : Infinity;
  const key = (n: UiNode) => `${n.c}|${n.id ?? ''}|${n.t ?? ''}|${n.d ?? ''}|${n.h ?? ''}|${(n.f ?? '').replace(/[FA]/g, '')}`;
  const left = new Map<string, number>();
  for (const n of before.nodes) if (before.windows[n.w]?.type !== 'ime') left.set(key(n), (left.get(key(n)) ?? 0) + 1);
  for (const n of after.nodes) {
    if (after.windows[n.w]?.type === 'ime') continue;
    const k = key(n);
    const count = left.get(k) ?? 0;
    if (count > 0) left.set(k, count - 1);
    else if (n.b[1] < imeTop) return false;
  }
  return [...left.values()].every(c => c === 0);
};
