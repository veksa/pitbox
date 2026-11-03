// A web app as a pitbox device: a browser driven through Playwright, answering the same runner commands as the
// Android and Apple runners (tree, tap, text, key, swipe, idle, screenshot, fingerprint, frames, focus, mouse). The
// page becomes the same flat node list, so snapshots, selectors, diffs, waits and flows work unchanged.
//
// Playwright is not a dependency of pitbox's core: `playwright-core` (or `playwright`) is loaded the first time a
// web app is driven, from the project first and pitbox's own install second. Browsers are the ones Playwright
// installs (`npx playwright install chromium`) or a channel the machine has (`chrome`, `msedge`).

import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
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
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Pw = any;

export class WebError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

/** `playwright-core` or `playwright`, from the project first (its own version), then pitbox's install. */
const loadPlaywright = async (root: string): Promise<Pw> => {
  const tries = [createRequire(path.join(root, 'package.json')), createRequire(import.meta.url)];
  for (const req of tries) {
    for (const name of ['playwright-core', 'playwright']) {
      try {
        const file = req.resolve(name);
        const mod = await import(pathToFileURL(file).href);
        return mod.default ?? mod;
      } catch {
        // next
      }
    }
  }
  throw new WebError('Playwright is not installed', 'add playwright-core to the project (yarn add -D playwright-core) and `npx playwright install chromium`');
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

/**
 * Runs in the page: the visible elements as UiNodes. An element becomes a node when it is interactive, carries text
 * of its own, a label, or a test id; its parent is the nearest such ancestor. Bounds are CSS pixels of the viewport.
 */
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
  #browser?: Pw;
  #context?: Pw;
  #page?: Pw;
  #lab?: Pw;
  #starting?: Promise<Pw>;
  /** Uncaught page errors and console errors, for the actions' crash reports. */
  readonly events: AppEvent[] = [];
  #touch?: {x: number; y: number};

  constructor(name: string, cfg: WebAppConfig, root: string) {
    this.name = name;
    this.cfg = cfg;
    this.#root = root;
  }

  get viewport(): {width: number; height: number} {
    const m = /^(\d+)x(\d+)$/.exec(this.cfg.viewport ?? '');
    return m ? {width: Number(m[1]), height: Number(m[2])} : {width: 1440, height: 900};
  }

  async page(): Promise<Pw> {
    if (this.#page && !this.#page.isClosed()) return this.#page;
    this.#starting ??= this.#start().finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  async #start(): Promise<Pw> {
    const pw = await loadPlaywright(this.#root);
    if (!this.#browser?.isConnected?.()) {
      const type = pw[this.cfg.browser ?? 'chromium'];
      try {
        this.#browser = await type.launch({headless: !this.cfg.headed, ...(this.cfg.channel ? {channel: this.cfg.channel} : {})});
      } catch (e) {
        const msg = (e as Error).message.split('\n')[0] ?? '';
        throw new WebError(`cannot start ${this.cfg.browser ?? 'chromium'}: ${msg}`, /Executable doesn't exist|install/i.test(msg) ? `npx playwright install ${this.cfg.browser ?? 'chromium'}, or set web.<app>.channel: 'chrome'` : undefined);
      }
    }
    this.#context = await this.#browser.newContext({viewport: this.viewport, deviceScaleFactor: this.cfg.scale ?? 1});
    const page = await this.#context.newPage();
    page.on('pageerror', (err: Error) => this.#event(`${err.name}: ${err.message}`, err.stack));
    page.on('console', (m: Pw) => {
      if (m.type() === 'error') this.#event(m.text());
    });
    this.#page = page;
    return page;
  }

  #event(message: string, stack?: string) {
    this.events.push({kind: 'js-error', at: Date.now(), summary: message.slice(0, 300), lines: stack ? stack.split('\n').slice(1, 6).map(l => l.trim()) : []});
    if (this.events.length > 200) this.events.shift();
  }

  /** A blank page in its own context for image work: no app CSP, no app state. */
  async #labPage(): Promise<Pw> {
    if (this.#lab && !this.#lab.isClosed()) return this.#lab;
    await this.page();
    const ctx = await this.#browser.newContext();
    this.#lab = await ctx.newPage();
    return this.#lab;
  }

  /** Opens a URL (a path is joined to the app's URL); `fresh` drops cookies and storage first, as a clean start. */
  async goto(target?: string, fresh = false): Promise<{url: string}> {
    if (fresh && this.#context) {
      await this.#context.close().catch(() => undefined);
      this.#page = undefined;
      this.#context = undefined;
    }
    const page = await this.page();
    const url = !target ? this.cfg.url : /^[a-z][\w+.-]*:/i.test(target) ? target : new URL(target, this.cfg.url).href;
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60_000});
    return {url: page.url()};
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
        return {...this.viewport, density: 160 * (this.cfg.scale ?? 1), sdk: 0};
      case 'tree':
        return (await page.evaluate(pageTree)) as Record<string, unknown>;
      case 'idle': {
        const quiet = Number(args.quiet ?? 300);
        const timeout = Number(args.timeout ?? 3000);
        const ok = await page.evaluate(pageQuiet, {quiet, timeout}).catch(() => false);
        return {idle: ok};
      }
      case 'tap':
      case 'longpress': {
        const hold = Number(args.hold ?? (cmd === 'longpress' ? 800 : 40));
        await page.mouse.move(n('x'), n('y'));
        await page.mouse.down();
        await page.waitForTimeout(hold);
        await page.mouse.up();
        return {};
      }
      case 'doubletap':
        await page.mouse.dblclick(n('x'), n('y'));
        return {};
      case 'swipe': {
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
        const png = (await page.screenshot({type: 'png', timeout: timeoutMs})) as Buffer;
        const lab = await this.#labPage();
        const r = await lab.evaluate(labJpeg, {src: `data:image/png;base64,${png.toString('base64')}`, scale: Number(args.scale ?? 0.5), quality: Number(args.quality ?? 70)});
        return {jpeg: r.data, width: r.width, height: r.height};
      }
      case 'png': {
        const png = (await page.screenshot({type: 'png', timeout: timeoutMs, fullPage: !!args.full})) as Buffer;
        return {png: png.toString('base64')};
      }
      case 'fingerprint': {
        const png = (await page.screenshot({type: 'png', timeout: timeoutMs})) as Buffer;
        const lab = await this.#labPage();
        const scale = this.cfg.scale ?? 1;
        const fp = await lab.evaluate(labFingerprint, {src: `data:image/png;base64,${png.toString('base64')}`, cols: Number(args.cols ?? 54), masks: (args.masks as number[][] | undefined) ?? [], scale});
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
          const png = (await page.screenshot({type: 'png', ...(clip ? {clip} : {})})) as Buffer;
          const fp = (await lab.evaluate(labFingerprint, {src: `data:image/png;base64,${png.toString('base64')}`, cols: 32, masks: [], scale: 1})) as {grid: number[]};
          luma.push(fp.grid.reduce((s, v) => s + v, 0) / fp.grid.length);
          if (prev) diff.push(fp.grid.reduce((s, v, k) => s + Math.abs(v - prev![k]!), 0) / fp.grid.length);
          prev = fp.grid;
        }
        return {luma, diff};
      }
      case 'focus': {
        const tree = (await page.evaluate(pageTree)) as {nodes: UiNode[]};
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

  async stop(): Promise<void> {
    await this.#browser?.close().catch(() => undefined);
    this.#browser = undefined;
    this.#context = undefined;
    this.#page = undefined;
    this.#lab = undefined;
  }
}
