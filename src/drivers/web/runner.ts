// A web app as a pitbox device: a browser driven through Playwright, answering the same runner commands as the
// Android and Apple runners (tree, tap, text, key, swipe, idle, screenshot, fingerprint, frames, focus, mouse). The
// page becomes the same flat node list, so snapshots, selectors, diffs, waits and flows work unchanged.
//
// Playwright is not a dependency of pitbox's core: `playwright-core` (or `playwright`) is loaded the first time a
// web app is driven, from the project first and pitbox's own install second. Browsers are the ones Playwright
// installs (`npx playwright-core install chromium`) or a channel the machine has (`chrome`, `msedge`).

import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {pitboxFmt} from '../../devserver/valuefmt.ts';
import type {UiNode, UiWindow} from '../../ui/snapshot.ts';
import type {AppEvent} from '../android/events.ts';
import {KEYS} from '../android/driver.ts';

export type WebAppConfig = {
  /** Where the app lives: `open` goes here, and a route that starts with `/` is joined to it. */
  url: string;
  /** Browser window as `WxH` in CSS pixels. Default 1440x900. */
  viewport?: string;
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** A browser the machine has instead of Playwright's own: `chrome`, `msedge`. */
  channel?: string;
  /** Show the window. Default false. */
  headed?: boolean;
  /** Device scale factor. Default 1. */
  scale?: number;
  /** A Playwright device preset (`iPhone 15`, `Pixel 7`): its viewport, scale, user agent, touch and mobile flags. */
  device?: string;
  /** A mobile browser: the page's meta viewport is honoured, as on a phone. */
  mobile?: boolean;
  /** Touch input: taps, long presses, swipes and a held finger reach the page as touch events. */
  touch?: boolean;
  userAgent?: string;
};

/** What a web app emulates. Layers apply in order (the config's, then the runtime's); a preset sets every field it has. */
export type WebEmulation = {device?: string; viewport?: string; scale?: number; mobile?: boolean; touch?: boolean; userAgent?: string; dark?: boolean; locale?: string};

export type WebContextOptions = {
  viewport: {width: number; height: number};
  /** The whole screen of a preset (`window.screen`), past the viewport's browser bars. */
  screen?: {width: number; height: number};
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent?: string;
  colorScheme?: 'dark' | 'light';
  locale?: string;
  /** The preset the options came from, for the answer. */
  preset?: string;
};

/** A downloaded file, saved into the project's state folder. */
export type WebDownload = {n: number; name: string; url: string; at: number; state: 'saving' | 'done' | 'failed'; file?: string; size?: number; type?: string; ms?: number; error?: string};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Pw = any;

/** The hint goes into the message, as with every other error here: a flow, the CLI and MCP print the message only. */
export class WebError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(hint ? `${message}\nhint: ${hint}` : message);
    this.hint = hint;
  }
}

/** The version of the Playwright package a resolved entry file belongs to; undefined when its package.json is not found. */
const playwrightVersion = (file: string): string | undefined => {
  for (let dir = path.dirname(file), i = 0; i < 4; dir = path.dirname(dir), i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {name?: string; version?: string};
      if (pkg.name === 'playwright-core' || pkg.name === 'playwright') return pkg.version;
    } catch {
      // up
    }
  }
  return undefined;
};

/** Whether a Playwright version saves IndexedDB with the storage state (1.51 and later). */
export const keepsIndexedDb = (version?: string): boolean => {
  const [major = 0, minor = 0] = (version ?? '').split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 51);
};

/** `playwright-core` or `playwright`, from the project first (its own version), then pitbox's install. */
const loadPlaywright = async (root: string): Promise<Pw> => {
  const tries = [createRequire(path.join(root, 'package.json')), createRequire(import.meta.url)];
  for (const req of tries) {
    for (const name of ['playwright-core', 'playwright']) {
      try {
        const file = req.resolve(name);
        const mod = await import(pathToFileURL(file).href);
        const pw = mod.default ?? mod;
        return Object.assign(Object.create(pw), {version: playwrightVersion(file)});
      } catch {
        // next
      }
    }
  }
  throw new WebError('Playwright is not installed', 'add playwright-core to the project (yarn add -D playwright-core) and `npx playwright-core install chromium`');
};

/** Android keycodes back to names, for the keys DeviceUi sends. */
const NAMES = new Map(Object.entries(KEYS).map(([k, v]) => [v, k]));
const PW_KEYS: Record<string, string> = {
  back: 'GoBack', enter: 'Enter', center: 'Enter', select: 'Enter', del: 'Backspace', forward_del: 'Delete', tab: 'Tab', space: 'Space',
  escape: 'Escape', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', page_up: 'PageUp', page_down: 'PageDown',
  move_home: 'Home', move_end: 'End', home: 'Home', search: 'F3', menu: 'ContextMenu', playpause: 'MediaPlayPause',
};

export const webKey = (code: number, meta = 0): string => {
  let key: string | undefined;
  if (code >= 29 && code <= 54) key = String.fromCharCode(97 + code - 29);
  else if (code >= 7 && code <= 16) key = String(code - 7);
  else {
    const name = NAMES.get(code);
    key = name ? PW_KEYS[name] : undefined;
    if (!key) throw new WebError(`no browser key for "${name ?? code}"`, `browser keys: ${Object.keys(PW_KEYS).join(', ')}, letters, digits`);
  }
  const mods = [meta & 0x3000 ? 'Control' : '', meta & 0x41 ? 'Shift' : '', meta & 0x12 ? 'Alt' : '', meta & 0x30000 ? 'Meta' : ''].filter(Boolean);
  return [...mods, key].join('+');
};

/** A preset by its name, case, dashes and spaces aside (`iphone 15`, `Pixel-7`); an unknown one names the nearest. */
export const presetName = (name: string, devices: Record<string, unknown>): string => {
  if (devices[name]) return name;
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  const want = norm(name);
  const hit = Object.keys(devices).find(k => norm(k) === want);
  if (hit) return hit;
  const first = want.split(' ')[0] ?? want;
  const near = Object.keys(devices).filter(k => !/landscape/i.test(k) && norm(k).includes(first)).slice(0, 8);
  throw new WebError(`no device preset "${name}"`, near.length ? `Playwright has: ${near.join(', ')}` : 'a name from Playwright\'s devices: "iPhone 15", "Pixel 7", "iPad Mini", "Desktop Chrome"');
};

const parseSize = (v: string): {width: number; height: number} => {
  const m = /^(\d+)x(\d+)$/.exec(v.trim());
  if (!m) throw new WebError(`not a size: "${v}"`, 'WxH in CSS pixels, like 390x844');
  return {width: Number(m[1]), height: Number(m[2])};
};

/** The browser context's options from layers of emulation; `devices` is Playwright's preset table. */
export const contextOptions = (layers: WebEmulation[], devices: Record<string, Pw>): WebContextOptions => {
  const o: WebContextOptions = {viewport: {width: 1440, height: 900}, deviceScaleFactor: 1, isMobile: false, hasTouch: false};
  for (const l of layers) {
    if (l.device) {
      const name = presetName(l.device, devices);
      const d = devices[name];
      Object.assign(o, {viewport: {...d.viewport}, screen: d.screen ? {...d.screen} : undefined, deviceScaleFactor: d.deviceScaleFactor ?? 1, isMobile: !!d.isMobile, hasTouch: !!d.hasTouch, userAgent: d.userAgent, preset: name});
    }
    if (l.viewport) {
      o.viewport = parseSize(l.viewport);
      o.screen = undefined;
    }
    if (l.scale !== undefined) o.deviceScaleFactor = l.scale;
    if (l.mobile !== undefined) o.isMobile = l.mobile;
    if (l.touch !== undefined) o.hasTouch = l.touch;
    if (l.userAgent !== undefined) o.userAgent = l.userAgent || undefined;
    if (l.dark !== undefined) o.colorScheme = l.dark ? 'dark' : 'light';
    if (l.locale !== undefined) o.locale = l.locale || undefined;
  }
  return o;
};

/** One line for an answer: `390x844 @3x mobile touch · iPhone 15 · dark`. */
export const describeEmulation = (o: WebContextOptions): string =>
  [
    `${o.viewport.width}x${o.viewport.height}${o.deviceScaleFactor !== 1 ? ` @${o.deviceScaleFactor}x` : ''}${o.isMobile ? ' mobile' : ''}${o.hasTouch ? ' touch' : ' mouse'}`,
    o.preset ?? (o.userAgent ? `user agent "${o.userAgent.slice(0, 40)}${o.userAgent.length > 40 ? '…' : ''}"` : ''),
    o.colorScheme ?? '',
    o.locale ?? '',
  ]
    .filter(Boolean)
    .join(' · ');

/** A file's type from its first bytes, else from its extension. */
export const fileType = (head: Buffer, name: string): string | undefined => {
  const hex = head.subarray(0, 12).toString('hex');
  const ascii = head.subarray(0, 12).toString('latin1');
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (ascii.startsWith('GIF8')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('%PDF')) return 'application/pdf';
  if (ascii.slice(4, 8) === 'ftyp') return /^ftyp(heic|heix|mif1)/.test(ascii.slice(4, 12)) ? 'image/heic' : ascii.slice(8, 11) === 'M4A' ? 'audio/mp4' : ascii.slice(8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  if (ascii.startsWith('OggS')) return 'audio/ogg';
  if (ascii.startsWith('ID3') || hex.startsWith('fffb')) return 'audio/mpeg';
  if (hex.startsWith('504b0304')) return 'application/zip';
  const ext = path.extname(name).slice(1).toLowerCase();
  const byExt: Record<string, string> = {txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', svg: 'image/svg+xml', ics: 'text/calendar', vcf: 'text/vcard'};
  return byExt[ext];
};

/** A download's URL for an answer: a data URL by its type alone, others cut short. */
const shortUrl = (u: string) => (u.startsWith('data:') ? `${u.slice(0, Math.min(u.indexOf(',') + 1 || 30, 40))}…` : u.length > 120 ? `${u.slice(0, 117)}…` : u);

/**
 * Runs in the page: the visible elements as UiNodes. An element becomes a node when it is interactive, carries text
 * of its own, a label, or a test id; its parent is the nearest such ancestor. Bounds are CSS pixels of the viewport.
 */
/**
 * `page.evaluate` that survives a navigation: a press that reloads or leaves the page (a sign-out) destroys the
 * document the read started in. The read waits for the next document and runs again there.
 */
const evaluateAcrossNavigation = async <A, R>(page: Pw, fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await page.evaluate(fn, arg)) as R;
    } catch (error) {
      if (attempt >= 4 || !/Execution context was destroyed|navigat/i.test(String((error as Error)?.message ?? error))) throw error;
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }
  }
};

function pageTree(): {windows: UiWindow[]; nodes: UiNode[]} {
  const out: any[] = [];
  const index = new Map<Element, number>();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const active = document.activeElement;
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  // A <label> is not a control of its own: its text becomes its field's label.
  const clickableTags = new Set(['BUTTON', 'A', 'SUMMARY', 'SELECT']);
  const clickableRoles = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'combobox', 'treeitem']);
  const visit = (el: Element, parent: number) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || Number(st.opacity) === 0) return;
    const r = el.getBoundingClientRect();
    const onScreen = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
    const tag = el.tagName;
    const role = el.getAttribute('role') ?? '';
    const input = el as HTMLInputElement;
    const type = (input.type ?? '').toLowerCase();
    const editable = (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'].includes(type)) || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
    const checkable = (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) || ['checkbox', 'radio', 'switch'].includes(role);
    const parentCursor = el.parentElement ? getComputedStyle(el.parentElement).cursor : '';
    const clickable =
      !editable &&
      (clickableTags.has(tag) ||
        (tag === 'INPUT' && ['button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio'].includes(type)) ||
        clickableRoles.has(role) ||
        el.hasAttribute('onclick') ||
        (st.cursor === 'pointer' && parentCursor !== 'pointer'));
    const scrollable = (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1) || (/(auto|scroll)/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 1);
    let own = '';
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) own += n.textContent ?? '';
    own = clean(own);
    if (tag === 'IMG') own = '';
    const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-test-id');
    // Ids a framework generates (React's useId: `:r0:`, `«r0»`, `_r_0_`) change between renders and name nothing.
    const domId = el.id && !/[:«]|^_r_\w*_$/.test(el.id) ? el.id : '';
    const fieldLabel = (editable || checkable || tag === 'SELECT') && (el as HTMLInputElement).labels?.length ? clean((el as HTMLInputElement).labels![0]!.textContent) : '';
    const label = clean(el.getAttribute('aria-label') ?? (tag === 'IMG' ? el.getAttribute('alt') : null) ?? el.getAttribute('title')) || fieldLabel;
    const interactive = clickable || editable || checkable || scrollable;
    let me = parent;
    if (onScreen && (interactive || own || label || testId || (tag === 'IMG' && r.width >= 24))) {
      const c = editable ? 'EditText' : checkable ? 'CheckBox' : scrollable && !clickable ? 'ScrollView' : clickable ? 'Button' : tag === 'IMG' || tag === 'svg' || role === 'img' ? 'Image' : own ? 'TextView' : 'View';
      const node: any = {p: parent, w: 0, c, b: [Math.round(Math.max(0, r.left)), Math.round(Math.max(0, r.top)), Math.round(Math.min(vw, r.right)), Math.round(Math.min(vh, r.bottom))]};
      if (testId || domId) node.id = testId || domId;
      if (editable) {
        const v = tag === 'INPUT' || tag === 'TEXTAREA' ? input.value : clean(el.textContent);
        if (v) node.t = type === 'password' ? '•'.repeat(Math.min(v.length, 12)) : v;
        const ph = el.getAttribute('placeholder');
        if (ph) node.h = ph;
      } else if (own) node.t = own;
      else if (tag === 'INPUT' && input.value && ['button', 'submit', 'reset'].includes(type)) node.t = input.value;
      if (label && label !== node.t) node.d = label;
      let f = '';
      if (clickable) f += 'c';
      if (editable || clickable || (el as HTMLElement).tabIndex >= 0) f += 'f';
      if (el === active) f += 'F';
      if (editable) f += 'e';
      if (scrollable) f += 's';
      if (checkable) f += (input.checked || el.getAttribute('aria-checked') === 'true') ? 'X' : 'x';
      if (el.getAttribute('aria-selected') === 'true') f += 'S';
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') f += 'd';
      if (type === 'password') f += 'p';
      if (f) node.f = f;
      me = out.length;
      index.set(el, me);
      out.push(node);
    }
    for (const child of Array.from(el.children)) visit(child, me);
    if ((el as HTMLElement).shadowRoot) for (const child of Array.from((el as HTMLElement).shadowRoot!.children)) visit(child, me);
  };
  // The page itself scrolls: its scroller is the root node, as an app's main list would be.
  const doc = document.scrollingElement ?? document.documentElement;
  const pageScrolls = doc.scrollHeight > vh + 1;
  let root = -1;
  if (pageScrolls) {
    out.push({p: -1, w: 0, c: 'ScrollView', b: [0, 0, vw, vh], f: 's'});
    root = 0;
  }
  for (const child of Array.from(document.body?.children ?? [])) visit(child, root);
  return {windows: [{type: 'app', title: document.title, pkg: location.host || location.href}], nodes: out};
}

/** Runs in the page: resolves when the DOM has not changed for `quiet` ms, or after `timeout`; true when quiet. */
function pageQuiet(args: {quiet: number; timeout: number}): Promise<boolean> {
  return new Promise(resolve => {
    let last = performance.now();
    const obs = new MutationObserver(() => (last = performance.now()));
    obs.observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
    const start = performance.now();
    const tick = () => {
      const now = performance.now();
      if (now - last >= args.quiet) {
        obs.disconnect();
        resolve(true);
      } else if (now - start >= args.timeout) {
        obs.disconnect();
        resolve(false);
      } else setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  });
}

/** Runs in a blank page: an image (data URL) as a luma grid, `cols` wide, with masked rectangles blanked. */
function labFingerprint(args: {src: string; cols: number; masks: number[][]; scale: number}): Promise<{cols: number; rows: number; grid: number[]}> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('the screenshot did not decode'));
    img.onload = () => {
      const rows = Math.max(1, Math.floor((args.cols * img.height) / img.width));
      const big = document.createElement('canvas');
      big.width = img.width;
      big.height = img.height;
      const g = big.getContext('2d')!;
      g.drawImage(img, 0, 0);
      g.fillStyle = '#000';
      for (const m of args.masks) g.fillRect(m[0]! * args.scale, m[1]! * args.scale, (m[2]! - m[0]!) * args.scale, (m[3]! - m[1]!) * args.scale);
      const small = document.createElement('canvas');
      small.width = args.cols;
      small.height = rows;
      const s = small.getContext('2d')!;
      s.imageSmoothingQuality = 'high';
      s.drawImage(big, 0, 0, args.cols, rows);
      const px = s.getImageData(0, 0, args.cols, rows).data;
      const grid: number[] = [];
      for (let i = 0; i < px.length; i += 4) grid.push(Math.floor((px[i]! * 299 + px[i + 1]! * 587 + px[i + 2]! * 114) / 1000));
      resolve({cols: args.cols, rows, grid});
    };
    img.src = args.src;
  });
}

/** Runs in a blank page: an image downscaled to a JPEG data URL. */
function labJpeg(args: {src: string; scale: number; quality: number}): Promise<{data: string; width: number; height: number}> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('the screenshot did not decode'));
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * args.scale));
      c.height = Math.max(1, Math.round(img.height * args.scale));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      resolve({data: c.toDataURL('image/jpeg', args.quality / 100).split(',')[1]!, width: c.width, height: c.height});
    };
    img.src = args.src;
  });
}

export class WebRunner {
  readonly name: string;
  readonly cfg: WebAppConfig;
  readonly #root: string;
  readonly #stateDir: string;
  #browser?: Pw;
  #context?: Pw;
  #page?: Pw;
  #lab?: Pw;
  #cdp?: Pw;
  #starting?: Promise<Pw>;
  /** Emulation set at run time (`settings`), over the config's. */
  #over: WebEmulation = {};
  /** The options the current context was made with. */
  #opts?: WebContextOptions;
  /** Uncaught page errors and console errors, for the actions' crash reports. */
  readonly events: AppEvent[] = [];
  #touch?: {x: number; y: number};
  readonly #downloads: WebDownload[] = [];
  /** Downloads an answer has shown: `downloads wait` waits for one that is not. */
  #downloadsSeen = 0;
  #downloadSeq = 0;

  constructor(name: string, cfg: WebAppConfig, root: string, stateDir = path.join(root, '.pitbox')) {
    this.name = name;
    this.cfg = cfg;
    this.#root = root;
    this.#stateDir = stateDir;
  }

  get viewport(): {width: number; height: number} {
    if (this.#opts) return this.#opts.viewport;
    const m = /^(\d+)x(\d+)$/.exec(this.cfg.viewport ?? '');
    return m ? {width: Number(m[1]), height: Number(m[2])} : {width: 1440, height: 900};
  }

  get #scale(): number {
    return this.#opts?.deviceScaleFactor ?? this.cfg.scale ?? 1;
  }

  /** The config's emulation, as the first layer. */
  get #base(): WebEmulation {
    const c = this.cfg;
    return {device: c.device, viewport: c.viewport, scale: c.scale, mobile: c.mobile, touch: c.touch, userAgent: c.userAgent};
  }

  /**
   * The app's page, started on first use. A device runs its app: a browser that has just started opens the app's
   * URL, so a snapshot or a tap before any `open` sees the app, not a blank page (`goto` asks for no landing).
   */
  async page(land = true): Promise<Pw> {
    if (this.#page && !this.#page.isClosed()) return this.#page;
    this.#starting ??= this.#start()
      .then(async p => {
        if (land) await p.goto(this.cfg.url, {waitUntil: 'domcontentloaded', timeout: 60_000});
        return p;
      })
      .finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  /**
   * `js eval` on a web app: the expression runs in the page, its value formatted as an app's is. Statements and
   * promises are fine; a top-level `await` is retried inside an async function, as in the app.
   */
  async evaluate(expr: string, timeoutMs = 10_000): Promise<{value?: string; error?: string}> {
    const page = await this.page();
    const run = (src: string) =>
      `(async () => { const fmt = ${pitboxFmt.toString()}; let v; try { v = await (0, eval)(${JSON.stringify(src)}); } catch (e) { return {error: e && e.name ? e.name + ': ' + e.message : String(e)}; } const s = fmt(v, 0, []); return {value: s.length > 4000 ? s.slice(0, 4000) + '… (' + s.length + ' chars)' : s}; })()`;
    const once = (src: string) =>
      Promise.race([
        page.evaluate(run(src)) as Promise<{value?: string; error?: string}>,
        new Promise<{error: string}>(resolve => setTimeout(() => resolve({error: `the promise did not settle in ${Math.round(timeoutMs / 1000)}s`}), timeoutMs)),
      ]);
    let r = await once(expr);
    if (r.error?.startsWith('SyntaxError') && /\bawait\b/.test(expr)) {
      const wrapped = await once(`(async () => (${expr}))()`);
      r = wrapped.error?.startsWith('SyntaxError') ? await once(`(async () => {${expr}\n})()`) : wrapped;
    }
    return r;
  }

  async #start(): Promise<Pw> {
    const pw = await loadPlaywright(this.#root);
    if (!this.#browser?.isConnected?.()) {
      const type = pw[this.cfg.browser ?? 'chromium'];
      this.#context = undefined;
      try {
        this.#browser = await type.launch({headless: !this.cfg.headed, ...(this.cfg.channel ? {channel: this.cfg.channel} : {})});
      } catch (e) {
        const msg = (e as Error).message.split('\n')[0] ?? '';
        throw new WebError(`cannot start ${this.cfg.browser ?? 'chromium'}: ${msg}`, /Executable doesn't exist|install/i.test(msg) ? `npx playwright-core install ${this.cfg.browser ?? 'chromium'}, or set web.<app>.channel: 'chrome'` : undefined);
      }
    }
    if (this.#context) return this.#newPage();
    return this.#openContext(contextOptions([this.#base, this.#over], pw.devices ?? {}));
  }

  /** A context with these options (and the storage of an earlier one), and its page. */
  async #openContext(o: WebContextOptions, storageState?: unknown): Promise<Pw> {
    const {preset: _preset, ...opts} = o;
    if (!opts.screen) delete opts.screen;
    // Firefox has no mobile mode: its viewport and touch still apply.
    if (this.cfg.browser === 'firefox') delete (opts as Partial<WebContextOptions>).isMobile;
    this.#context = await this.#browser.newContext({...opts, acceptDownloads: true, ...(storageState ? {storageState} : {})});
    // Every page of the context, popups and new tabs included, saves its downloads.
    this.#context.on('page', (p: Pw) => p.on('download', (d: Pw) => this.#download(d)));
    this.#opts = o;
    return this.#newPage();
  }

  async #newPage(): Promise<Pw> {
    const page = await this.#context.newPage();
    page.on('pageerror', (err: Error) => this.#event(`${err.name}: ${err.message}`, err.stack));
    page.on('console', (m: Pw) => {
      if (m.type() === 'error') this.#event(m.text());
    });
    this.#page = page;
    this.#cdp = undefined;
    return page;
  }

  #event(message: string, stack?: string) {
    this.events.push({kind: 'js-error', at: Date.now(), summary: message.slice(0, 300), lines: stack ? stack.split('\n').slice(1, 6).map(l => l.trim()) : []});
    if (this.events.length > 200) this.events.shift();
  }

  /** A download the page started: saved under the state folder by its suggested name (a repeated name gets -2, -3). */
  #download(d: Pw) {
    const t0 = Date.now();
    const name = String(d.suggestedFilename() || 'download').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
    const rec: WebDownload = {n: ++this.#downloadSeq, name, url: shortUrl(String(d.url())), at: t0, state: 'saving'};
    const dir = path.join(this.#stateDir, 'downloads', this.name);
    const taken = new Set(this.#downloads.map(x => x.file));
    const ext = path.extname(name);
    let file = path.join(dir, name);
    // A file left by an earlier browser (a restarted daemon, a download dropped from the list) is not overwritten either.
    for (let i = 2; taken.has(file) || fs.existsSync(file); i++) file = path.join(dir, `${name.slice(0, name.length - ext.length)}-${i}${ext}`);
    rec.file = file;
    this.#downloads.push(rec);
    if (this.#downloads.length > 50) {
      this.#downloads.shift();
      this.#downloadsSeen = Math.max(0, this.#downloadsSeen - 1);
    }
    void (async () => {
      try {
        fs.mkdirSync(dir, {recursive: true});
        await d.saveAs(file);
        const failure = await d.failure();
        if (failure) throw new Error(failure);
        rec.size = fs.statSync(file).size;
        const fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(16);
        fs.readSync(fd, head, 0, 16, 0);
        fs.closeSync(fd);
        rec.type = fileType(head, name);
        rec.state = 'done';
      } catch (e) {
        rec.state = 'failed';
        rec.error = (e as Error).message.split('\n')[0];
      }
      rec.ms = Date.now() - t0;
    })();
  }

  /**
   * The page's downloads, newest last. With `waitMs`, waits for one no answer has shown yet (matching `grep`) to
   * finish and answers with it alone; without, lists the last `limit` and counts the finished ones as shown.
   */
  async downloads(opts: {grep?: string; waitMs?: number; limit?: number} = {}): Promise<{downloads: WebDownload[]; dir: string; waited?: number}> {
    const dir = path.join(this.#stateDir, 'downloads', this.name);
    const re = opts.grep ? new RegExp(opts.grep, 'i') : undefined;
    const match = (d: WebDownload) => !re || re.test(d.name);
    if (opts.waitMs === undefined) {
      // Shown means finished and listed: one still saving, or left out by `grep`, is still new for a wait.
      const pending = this.#downloads.findIndex((d, i) => i >= this.#downloadsSeen && (d.state === 'saving' || !match(d)));
      this.#downloadsSeen = pending >= 0 ? pending : this.#downloads.length;
      return {downloads: this.#downloads.filter(match).slice(-(opts.limit ?? 10)), dir};
    }
    // A wait that is not a number (`--wait name.pdf` took the name) would never time out.
    if (!(opts.waitMs >= 0)) throw new WebError('the wait is not a number of seconds', 'downloads [name-regex] --wait 10');
    const t0 = Date.now();
    for (;;) {
      const fresh = this.#downloads.slice(this.#downloadsSeen).find(match);
      if (fresh && fresh.state !== 'saving') {
        this.#downloadsSeen = this.#downloads.indexOf(fresh) + 1;
        return {downloads: [fresh], dir, waited: Date.now() - t0};
      }
      if (Date.now() - t0 >= opts.waitMs) {
        throw new Error(
          fresh
            ? `"${fresh.name}" is still downloading after ${Math.round(opts.waitMs / 1000)}s`
            : `no new download${re ? ` matching /${opts.grep}/` : ''} in ${Math.round(opts.waitMs / 1000)}s${this.#lastNote(re)}`,
        );
      }
      await new Promise(r => setTimeout(r, 150));
    }
  }

  /** What came instead, for a wait that found nothing: new downloads the pattern left out, or the last one shown. */
  #lastNote(re?: RegExp): string {
    const unseen = this.#downloads.slice(this.#downloadsSeen).filter(d => re && !re.test(d.name));
    if (unseen.length) return ` (new, not matching: ${unseen.map(d => `"${d.name}"`).join(', ')})`;
    const last = this.#downloads[this.#downloads.length - 1];
    return last ? ` (the last one, "${last.name}", was already shown)` : '';
  }

  /** A blank page in its own context for image work: no app CSP, no app state. */
  async #labPage(): Promise<Pw> {
    if (this.#lab && !this.#lab.isClosed()) return this.#lab;
    await this.page();
    const ctx = await this.#browser.newContext();
    this.#lab = await ctx.newPage();
    return this.#lab;
  }

  /**
   * Opens a URL (a path is joined to the app's URL). `relaunch` closes the tab and opens a new one in the same
   * profile, as an app is closed and opened again: cookies, local storage and IndexedDB stay, the page's memory and
   * session storage go. `fresh` starts from a clean profile.
   */
  async goto(target?: string, mode?: 'relaunch' | 'fresh'): Promise<{url: string}> {
    if (mode === 'fresh' && this.#context) {
      await this.#context.close().catch(() => undefined);
      this.#page = undefined;
      this.#context = undefined;
    } else if (mode === 'relaunch' && this.#page && this.#context) {
      await this.#page.close().catch(() => undefined);
      await this.#newPage();
    }
    const page = await this.page(false);
    const url = !target ? this.cfg.url : /^[a-z][\w+.-]*:/i.test(target) ? target : new URL(target, this.cfg.url).href;
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60_000});
    return {url: page.url()};
  }

  /**
   * Changes what the browser emulates (`settings` on a web app): a device preset, the size, the scale, mobile,
   * touch, the user agent, dark, the locale; `reset` goes back to the config's. A colour scheme alone changes in
   * place; anything else needs a new context, which takes over the cookies and storage (IndexedDB too) and reloads
   * the page that was open.
   */
  async emulate(change: WebEmulation & {reset?: boolean; unset?: (keyof WebEmulation)[]}): Promise<string[]> {
    const {reset, unset = [], ...set} = change;
    const given = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined)) as WebEmulation;
    if (given.scale !== undefined && !(Number.isFinite(given.scale) && given.scale > 0 && given.scale <= 10)) throw new WebError(`not a scale: ${given.scale}`, 'density=<device scale factor>, like 2 or 3; density=reset for the preset\'s or the config\'s');
    if (!reset && !unset.length && !Object.keys(given).length) throw new WebError('nothing to change', 'settings emulate="iPhone 15" | size=390x844 density=3 touch=true mobile=true userAgent=… dark=true locale=fr-FR | emulate=reset');
    // A new preset replaces the earlier run-time size, scale and flags; dark and the locale stay.
    const kept: WebEmulation = reset ? {} : given.device ? {dark: this.#over.dark, locale: this.#over.locale} : {...this.#over};
    // `size=reset`, `density=reset`: back to the preset's or the config's value for that field alone.
    for (const k of unset) delete kept[k];
    const over = {...kept, ...given};
    const pw = await loadPlaywright(this.#root);
    const next = contextOptions([this.#base, over], pw.devices ?? {});
    this.#over = over;
    const prev = this.#opts;
    // Touch input goes through Chromium's input protocol; another browser reports touch support but gets the mouse.
    const mouseOnly = next.hasTouch && (this.cfg.browser ?? 'chromium') !== 'chromium' ? [`${this.cfg.browser} takes no synthesized touch: press, swipe and touch stay the mouse's (browser: chromium for touch)`] : [];
    if (!this.#context || !this.#browser?.isConnected?.()) {
      await this.page();
      return [describeEmulation(this.#opts ?? next), ...mouseOnly];
    }
    const same = (a: WebContextOptions, b: WebContextOptions) => JSON.stringify({...a, colorScheme: 0}) === JSON.stringify({...b, colorScheme: 0});
    if (prev && same(prev, next)) {
      if (prev.colorScheme !== next.colorScheme) await this.#page?.emulateMedia({colorScheme: next.colorScheme ?? null});
      this.#opts = next;
      return [describeEmulation(next), ...mouseOnly];
    }
    const url = this.#page && !this.#page.isClosed() ? String(this.#page.url()) : undefined;
    const state = await this.#context.storageState({indexedDB: true}).catch(() => this.#context.storageState().catch(() => undefined));
    await this.#context.close().catch(() => undefined);
    this.#context = undefined;
    this.#page = undefined;
    const page = await this.#openContext(next, state);
    const back = url && /^https?:/.test(url) ? url : this.cfg.url;
    await page.goto(back, {waitUntil: 'domcontentloaded', timeout: 60_000});
    const storage = keepsIndexedDb(pw.version) ? 'cookies and storage kept' : `cookies and local storage kept, IndexedDB lost (Playwright ${pw.version ?? 'of unknown version'} keeps it from 1.51)`;
    return [describeEmulation(next), `new browser context: ${storage}, ${new URL(page.url()).pathname} reloaded (session storage and the page's memory are gone)`, ...mouseOnly];
  }

  /** The device-protocol session for touch input: Chromium with touch on; undefined otherwise (input stays the mouse). */
  async #touchInput(page: Pw): Promise<Pw | undefined> {
    if (!this.#opts?.hasTouch || (this.cfg.browser ?? 'chromium') !== 'chromium') return undefined;
    this.#cdp ??= await this.#context.newCDPSession(page);
    return this.#cdp;
  }

  /** Clears cookies and storage of the app's origin (the app's data on a phone). */
  async clear(): Promise<void> {
    if (!this.#context) return;
    await this.#context.clearCookies();
    const page = await this.page();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    }).catch(() => undefined);
  }

  async call<T extends Record<string, unknown> = Record<string, unknown>>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const page = await this.page();
    const n = (k: string) => Number(args[k]);
    const r = await this.#run(page, cmd, args, n, timeoutMs);
    return r as T;
  }

  async #run(page: Pw, cmd: string, args: Record<string, unknown>, n: (k: string) => number, timeoutMs: number): Promise<Record<string, unknown>> {
    switch (cmd) {
      case 'ping':
        return {version: 'web'};
      case 'info':
        return {...this.viewport, density: 160 * this.#scale, sdk: 0};
      case 'tree':
        return (await evaluateAcrossNavigation(page, pageTree)) as Record<string, unknown>;
      case 'idle': {
        const quiet = Number(args.quiet ?? 300);
        const timeout = Number(args.timeout ?? 3000);
        const ok = await page.evaluate(pageQuiet, {quiet, timeout}).catch(() => false);
        return {idle: ok};
      }
      case 'tap':
      case 'longpress': {
        const hold = Number(args.hold ?? (cmd === 'longpress' ? 800 : 40));
        const touch = await this.#touchInput(page);
        if (touch && cmd === 'tap') {
          await this.#finger(touch, 'touchStart', n('x'), n('y'));
          await page.waitForTimeout(hold);
          await this.#finger(touch, 'touchEnd');
          return {};
        }
        // A held finger as the browser's gesture detector sees it: raw touch events alone never make a long press
        // (no contextmenu, no long-press gesture); a synthesized one does, with its touch events — on macOS. Chromium
        // on Linux and Windows derives no gesture from it: the page gets the held finger and no contextmenu.
        if (touch) {
          await touch.send('Input.synthesizeTapGesture', {x: n('x'), y: n('y'), duration: hold, tapCount: 1, gestureSourceType: 'touch'});
          return {};
        }
        await page.mouse.move(n('x'), n('y'));
        await page.mouse.down();
        await page.waitForTimeout(hold);
        await page.mouse.up();
        return {};
      }
      case 'doubletap': {
        const touch = await this.#touchInput(page);
        if (!touch) {
          await page.mouse.dblclick(n('x'), n('y'));
          return {};
        }
        for (let i = 0; i < 2; i++) {
          if (i) await page.waitForTimeout(Number(args.gap ?? 90));
          await this.#finger(touch, 'touchStart', n('x'), n('y'));
          await page.waitForTimeout(30);
          await this.#finger(touch, 'touchEnd');
        }
        return {};
      }
      case 'swipe': {
        // With touch, a finger drags across the page (the browser scrolls, or the page's own gesture takes it).
        const touch = await this.#touchInput(page);
        if (touch) {
          const duration = Math.max(50, Number(args.duration ?? 300));
          const steps = Math.max(4, Math.round(duration / 16));
          await this.#finger(touch, 'touchStart', n('x1'), n('y1'));
          if (Number(args.hold ?? 0) > 0) await page.waitForTimeout(Number(args.hold));
          for (let i = 1; i <= steps; i++) {
            await this.#finger(touch, 'touchMove', n('x1') + ((n('x2') - n('x1')) * i) / steps, n('y1') + ((n('y2') - n('y1')) * i) / steps);
            await page.waitForTimeout(duration / steps);
          }
          await this.#finger(touch, 'touchEnd');
          await page.waitForTimeout(150);
          return {};
        }
        // A swipe on a page is a scroll by the distance travelled, at its start point.
        await page.mouse.move(n('x1'), n('y1'));
        await page.mouse.wheel(n('x1') - n('x2'), n('y1') - n('y2'));
        await page.waitForTimeout(Math.min(600, Number(args.duration ?? 300)));
        return {};
      }
      case 'key': {
        const key = webKey(n('code'), Number(args.meta ?? 0));
        if (key === 'GoBack') await page.goBack({waitUntil: 'domcontentloaded'}).catch(() => undefined);
        else await page.keyboard.press(key);
        return {};
      }
      case 'text': {
        const text = String(args.text ?? '');
        const b = args.bounds as number[] | undefined;
        if (b) {
          await page.mouse.click((b[0]! + b[2]!) / 2, (b[1]! + b[3]!) / 2);
        }
        const set = await page.evaluate(
          (a: {text: string; append: boolean}) => {
            const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
            if (!el) return false;
            if ('value' in el) {
              const proto = Object.getPrototypeOf(el);
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              const v = a.append ? el.value + a.text : a.text;
              // The native setter, so React and other frameworks see the change as typed.
              if (setter) setter.call(el, v);
              else el.value = v;
              el.dispatchEvent(new Event('input', {bubbles: true}));
              el.dispatchEvent(new Event('change', {bubbles: true}));
              return true;
            }
            if ((el as HTMLElement).isContentEditable) {
              if (!a.append) (el as HTMLElement).textContent = '';
              document.execCommand('insertText', false, a.text);
              return true;
            }
            return false;
          },
          {text, append: !!args.append},
        );
        return {set};
      }
      case 'screenshot': {
        const png = (await page.screenshot({type: 'png', timeout: timeoutMs, scale: 'css'})) as Buffer;
        const lab = await this.#labPage();
        const r = await lab.evaluate(labJpeg, {src: `data:image/png;base64,${png.toString('base64')}`, scale: Number(args.scale ?? 0.5), quality: Number(args.quality ?? 70)});
        return {jpeg: r.data, width: r.width, height: r.height};
      }
      case 'png': {
        const png = (await page.screenshot({type: 'png', timeout: timeoutMs, fullPage: !!args.full})) as Buffer;
        return {png: png.toString('base64')};
      }
      case 'fingerprint': {
        // In CSS pixels, as the masks are, whatever the device scale.
        const png = (await page.screenshot({type: 'png', timeout: timeoutMs, scale: 'css'})) as Buffer;
        const lab = await this.#labPage();
        const fp = await lab.evaluate(labFingerprint, {src: `data:image/png;base64,${png.toString('base64')}`, cols: Number(args.cols ?? 54), masks: (args.masks as number[][] | undefined) ?? [], scale: 1});
        return {...fp, width: this.viewport.width, height: this.viewport.height};
      }
      case 'frames': {
        const count = Number(args.count ?? 4);
        const interval = Number(args.interval ?? 400);
        const b = args.bounds as number[] | undefined;
        const lab = await this.#labPage();
        const luma: number[] = [];
        const diff: number[] = [];
        let prev: number[] | undefined;
        for (let i = 0; i < count; i++) {
          if (i) await page.waitForTimeout(interval);
          const clip = b ? {x: b[0]!, y: b[1]!, width: Math.max(1, b[2]! - b[0]!), height: Math.max(1, b[3]! - b[1]!)} : undefined;
          const png = (await page.screenshot({type: 'png', scale: 'css', ...(clip ? {clip} : {})})) as Buffer;
          const fp = (await lab.evaluate(labFingerprint, {src: `data:image/png;base64,${png.toString('base64')}`, cols: 32, masks: [], scale: 1})) as {grid: number[]};
          luma.push(fp.grid.reduce((s, v) => s + v, 0) / fp.grid.length);
          if (prev) diff.push(fp.grid.reduce((s, v, k) => s + Math.abs(v - prev![k]!), 0) / fp.grid.length);
          prev = fp.grid;
        }
        return {luma, diff};
      }
      case 'focus': {
        const tree = (await evaluateAcrossNavigation(page, pageTree)) as {nodes: UiNode[]};
        const input = tree.nodes.find(x => (x.f ?? '').includes('F'));
        return input ? {input} : {};
      }
      case 'mouse': {
        const action = String(args.action);
        if (action === 'right') await page.mouse.click(n('x'), n('y'), {button: 'right'});
        else if (action === 'hover') await page.mouse.move(n('x'), n('y'));
        else {
          await page.mouse.move(n('x'), n('y'));
          await page.mouse.wheel(0, Number(args.amount ?? 1) * -120);
        }
        return {};
      }
      case 'touch': {
        const phase = String(args.phase);
        const finger = await this.#touchInput(page);
        if (finger) {
          if (phase === 'down') {
            await this.#finger(finger, 'touchStart', n('x'), n('y'));
            this.#touch = {x: n('x'), y: n('y')};
          } else if (phase === 'move') {
            const from = this.#touch ?? {x: n('x'), y: n('y')};
            for (let i = 1; i <= 8; i++) await this.#finger(finger, 'touchMove', from.x + ((n('x') - from.x) * i) / 8, from.y + ((n('y') - from.y) * i) / 8);
            this.#touch = {x: n('x'), y: n('y')};
          } else {
            await this.#finger(finger, 'touchEnd');
            this.#touch = undefined;
          }
          return {down: !!this.#touch};
        }
        if (phase === 'down') {
          await page.mouse.move(n('x'), n('y'));
          await page.mouse.down();
          this.#touch = {x: n('x'), y: n('y')};
        } else if (phase === 'move') {
          await page.mouse.move(n('x'), n('y'), {steps: 8});
        } else {
          await page.mouse.up();
          this.#touch = undefined;
        }
        return {down: !!this.#touch};
      }
      default:
        throw new WebError(`"${cmd}" is not available in a browser`);
    }
  }

  /** One touch event with one finger (none for the end of a touch). */
  async #finger(cdp: Pw, type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number) {
    await cdp.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x: Math.round(x!), y: Math.round(y!)}]});
  }

  async stop(): Promise<void> {
    await this.#browser?.close().catch(() => undefined);
    this.#browser = undefined;
    this.#context = undefined;
    this.#page = undefined;
    this.#lab = undefined;
    this.#cdp = undefined;
    this.#opts = undefined;
  }
}
