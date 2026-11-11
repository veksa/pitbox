import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {contextOptions, describeEmulation, fileType, presetName, WebError, WebRunner, webKey} from './drivers/web/runner.ts';
import {DeviceUi} from './ui/device.ts';
import {formatResult} from './format.ts';
import {freePort} from './util/net.ts';

// A small app: a sign-in form that answers after a request, a list taller than the window, a link to a second page.
const page = `<!doctype html><html><head><title>Example</title><style>
body{font-family:sans-serif;margin:0} .row{height:120px;border-bottom:1px solid #ccc}
#fab{position:fixed;right:10px;top:10px;width:60px;height:60px;z-index:9;background:#888}
</style></head><body>
<div id="fab" aria-label="Tools" onclick="document.title='fab'"></div>
<h1>Welcome</h1>
<form data-testid="sign-in" onsubmit="event.preventDefault();go()">
  <input data-testid="email" placeholder="Email">
  <input data-testid="password" type="password" placeholder="Password">
  <button data-testid="submit">Sign in</button>
</form>
<p data-testid="status"></p>
<a href="/second" data-testid="next">Next page</a>
${Array.from({length: 20}, (_, i) => `<div class="row">Row ${i + 1}</div>`).join('')}
<script>
async function go(){
  const r = await fetch('/hello?name=' + encodeURIComponent(document.querySelector('[data-testid=email]').value));
  document.querySelector('[data-testid=status]').textContent = await r.text();
}
</script></body></html>`;

// Touch events and clicks as the page sees them, a tall page to scroll, links that download.
const touchPage = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Touch</title><style>
body{margin:0;font-family:sans-serif} #pad{height:300px;background:#ddd} .row{height:200px;border-bottom:1px solid #ccc}
</style></head><body>
<div id="pad" data-testid="pad">Pad</div>
<a data-testid="get" href="/report.pdf">Get report</a>
<a data-testid="slow" href="/slow.zip">Get archive</a>
<a data-testid="blob" href="#" onclick="event.preventDefault();const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['a,b\\n1,2'],{type:'text/csv'}));a.download='table.csv';a.click()">Export</a>
${Array.from({length: 20}, (_, i) => `<div class="row">Row ${i + 1}</div>`).join('')}
<script>
window.seen = [];
for (const t of ['touchstart','touchmove','touchend','click','contextmenu','mousedown']) document.getElementById('pad').addEventListener(t, e => { if (seen[seen.length-1] !== t) seen.push(t); });
</script></body></html>`;

let port = 0;
let server: http.Server;
let dir = '';

beforeAll(async () => {
  port = await freePort();
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/hello')) {
      const name = new URL(req.url, 'http://x').searchParams.get('name');
      setTimeout(() => res.end(`Signed in as ${name}`), 200);
    } else if (req.url === '/touch') res.setHeader('content-type', 'text/html').end(touchPage);
    else if (req.url === '/slow.zip') {
      res.setHeader('content-type', 'application/zip').setHeader('content-disposition', 'attachment; filename="slow.zip"').write('PK\x03\x04');
      setTimeout(() => res.end('rest'), 1500);
    } else if (req.url === '/report.pdf') res.setHeader('content-type', 'application/pdf').setHeader('content-disposition', 'attachment; filename="report.pdf"').end('%PDF-1.4\n% a tiny file\n');
    else if (req.url === '/second') res.end('<!doctype html><title>Second</title><h2 data-testid="second">Second page</h2><button onclick="boom()">Break</button><button onclick="setTimeout(() => location.reload(), 30)">Reload</button>');
    else res.setHeader('content-type', 'text/html').end(page);
  });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-web-'));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
});

describe('keys in a browser', () => {
  it('names the keys DeviceUi sends as Playwright keys', () => {
    expect(webKey(66)).toBe('Enter');
    expect(webKey(4)).toBe('GoBack');
    expect(webKey(29 + 2, 0x3000)).toBe('Control+c');
    expect(() => webKey(264)).toThrow(/no browser key/);
  });
});

describe('a web app as a device', () => {
  let runner: WebRunner;
  let ui: DeviceUi;

  beforeAll(async () => {
    runner = new WebRunner('demo', {url: `http://127.0.0.1:${port}/`, viewport: '800x600'}, dir);
    ui = new DeviceUi('web:demo', runner, {}, {start: () => undefined, stop: () => undefined, since: t => runner.events.filter(e => e.at >= t)});
    await runner.goto();
  }, 60_000);

  afterAll(async () => {
    await ui.stop();
  });

  it('is a snapshot of lines with test ids, labels, hints and a scroller', async () => {
    const snap = await ui.snapshot();
    expect(snap.lines[0]).toMatch(/^@e1 list$/);
    expect(snap.lines).toContain('@e2 button "Tools" #fab');
    expect(snap.lines.some(l => /field hint "Email" #email/.test(l))).toBe(true);
    expect(snap.lines.some(l => /button "Sign in" #submit/.test(l))).toBe(true);
    expect(snap.lines.some(l => /Row 20/.test(l))).toBe(false);
  });

  it('fills, presses and waits for what the request brings, as on a phone', {timeout: 30_000}, async () => {
    await ui.fill('id=email', 'ann@example.test');
    await ui.fill('id=password', 'secret');
    expect((await ui.snapshot()).lines.some(l => /field "••••••" #password/.test(l))).toBe(true);
    const r = await ui.press('id=submit');
    expect(r.action).toBe('tap');
    await ui.wait('text=Signed in as ann@example.test', {timeoutMs: 5000});
  });

  it('scrolls to a target and reads the screen as a grid for visual checks', {timeout: 60_000}, async () => {
    await ui.scrollUntil('down', 'text=Row 20');
    const v = await ui.visual('end', path.join(dir, 'visual'));
    expect(v.status).toBe('saved');
    expect((await ui.visual('end', path.join(dir, 'visual'))).status).toBe('match');
    const shot = await ui.screenshot(path.join(dir, 'shot.jpg'));
    // Downscaled as on a phone: 0.4 of the 800 px window.
    expect(shot.width).toBe(320);
  });

  it('evaluates in the page for js eval: values, statements, promises, a top-level await, errors', {timeout: 30_000}, async () => {
    expect(await runner.evaluate('document.title')).toEqual({value: '"Example"'});
    expect(await runner.evaluate('const n = document.querySelectorAll(".row").length; n * 2')).toEqual({value: '40'});
    expect(await runner.evaluate('fetch("/hello?name=a").then(r => r.text())')).toEqual({value: '"Signed in as a"'});
    expect(await runner.evaluate('(await fetch("/hello?name=b")).status')).toEqual({value: '200'});
    expect((await runner.evaluate('nope.x')).error).toMatch(/^ReferenceError: nope is not defined/);
  });

  it('presses a control that reloads the page (a sign-out) and reads the page that comes back', {timeout: 30_000}, async () => {
    await runner.goto('/second');
    for (let i = 0; i < 5; i++) {
      const r = await ui.press('text=Reload');
      expect(r.action).toBe('tap');
      await ui.wait('id=second', {timeoutMs: 5000});
    }
  });

  it('follows a link, goes back with the back key, and reports a page error with the action', {timeout: 30_000}, async () => {
    await runner.goto('/second');
    const r = await ui.press('text=Break');
    expect(r.crashes?.[0]?.summary).toMatch(/boom is not defined/);
    await ui.key(['back']);
    expect((await runner.page()).url()).toBe(`http://127.0.0.1:${port}/`);
    // Back where it was: scrolled to the end of the list.
    await ui.wait('text=Row 20');
  });
});

describe('a web flow', () => {
  it('runs in the daemon with one verdict, from a config with a web app, as a phone flow does', {timeout: 90_000}, async () => {
    const {Engine} = await import('./daemon/engine.ts');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-webflow-'));
    fs.writeFileSync(path.join(project, 'pitbox.config.json'), JSON.stringify({web: {demo: {url: `http://127.0.0.1:${port}/`, viewport: '800x600'}}, routes: {second: '/second'}}));
    fs.mkdirSync(path.join(project, 'flows'));
    fs.writeFileSync(
      path.join(project, 'flows', 'sign-in.flow'),
      ['open!', 'wait id=email', 'fill id=email "${user}"', 'press id=submit', 'expect text~=Signed in as ${user}', 'goto second', 'expect id=second'].join('\n'),
    );
    const e = await Engine.create(path.join(project, 'pitbox.config.json'));
    try {
      const ok = (await e.methods.run({flow: 'sign-in', params: {user: 'bo@example.test'}, device: 'web:demo'})) as {ok: boolean; steps: number};
      expect(ok).toMatchObject({ok: true});
      // A flow that moves to the web app itself, and a fresh browser that lands on the app before any open.
      await e.stopAll();
      const moved = (await e.methods.run({steps: 'device web:demo\nexpect id=email'})) as {ok: boolean};
      expect(moved).toMatchObject({ok: true});
      const failed = (await e.methods.run({steps: 'open\nexpect id=nowhere', device: 'web:demo'})) as {ok: boolean; failed?: {line: number; screen?: string[]}};
      expect(failed).toMatchObject({ok: false, failed: {line: 2}});
      expect(failed.failed?.screen?.some(l => /#email/.test(l))).toBe(true);
      expect((await e.methods.devices({})) as {web?: unknown[]}).toMatchObject({web: [{name: 'web:demo'}]});
      // Settings on a web app emulate a phone; a phone's settings say what a web app takes instead.
      const set = await e.methods.settings({device: 'web:demo', emulate: 'iPhone 15', dark: 'true'});
      expect(formatResult('settings', set)).toMatch(/393x659 @3x mobile touch · iPhone 15 · dark/);
      await expect(e.methods.settings({device: 'web:demo', fontScale: 1.3})).rejects.toThrow(/fontScale: not for a web app\nhint: a web app takes emulate=/);
      const none = await e.methods.downloads({device: 'web:demo'});
      expect(formatResult('downloads', none)).toBe('no downloads on web:demo yet (they are saved to .pitbox/downloads/demo)');
      expect(formatResult('downloads', {serial: 'web:demo', root: '/p', dir: '/p/.pitbox/downloads/demo', waited: 1200, downloads: [{n: 1, name: 'a.pdf', url: 'http://x/a.pdf', at: 0, state: 'done', size: 2048, type: 'application/pdf', file: '/p/.pitbox/downloads/demo/a.pdf'}]})).toBe(
        'new download after 1.2s:\n✓ a.pdf · 2.0 KB · application/pdf · .pitbox/downloads/demo/a.pdf',
      );
    } finally {
      await e.stopAll();
    }
  });
});

describe('web errors', () => {
  it('carry the hint in the message, which is all a flow prints', () => {
    expect(new WebError('Playwright is not installed', 'yarn add -D playwright-core').message).toBe('Playwright is not installed\nhint: yarn add -D playwright-core');
    expect(new WebError('no page').message).toBe('no page');
  });
});

describe('web emulation', () => {
  it('resolves presets by loose names and layers explicit fields over them', async () => {
    const devices = {'iPhone 15': {viewport: {width: 393, height: 659}, screen: {width: 393, height: 852}, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'UA'}, 'iPhone 15 landscape': {}, 'Pixel 7': {}};
    expect(presetName('iphone-15', devices)).toBe('iPhone 15');
    expect(() => presetName('iPhone 99', devices)).toThrow(/no device preset "iPhone 99"\nhint: Playwright has: iPhone 15$/);
    const o = contextOptions([{viewport: '800x600'}, {device: 'iPhone 15'}, {touch: false, dark: true}], devices);
    expect(o).toMatchObject({viewport: {width: 393, height: 659}, deviceScaleFactor: 3, isMobile: true, hasTouch: false, userAgent: 'UA', colorScheme: 'dark', preset: 'iPhone 15'});
    expect(describeEmulation(o)).toBe('393x659 @3x mobile mouse · iPhone 15 · dark');
    expect(contextOptions([{device: 'iPhone 15'}, {viewport: '390x844'}], devices)).toMatchObject({viewport: {width: 390, height: 844}, screen: undefined, deviceScaleFactor: 3});
    expect(() => contextOptions([{viewport: 'wide'}], devices)).toThrow(/not a size/);
  });

  it("tells a downloaded file's type by its first bytes, then its extension", () => {
    expect(fileType(Buffer.from('89504e470d0a1a0a', 'hex'), 'x.bin')).toBe('image/png');
    expect(fileType(Buffer.from('%PDF-1.7'), 'x')).toBe('application/pdf');
    expect(fileType(Buffer.from('\0\0\0\x18ftypmp42'), 'v')).toBe('video/mp4');
    expect(fileType(Buffer.from('a,b'), 'table.csv')).toBe('text/csv');
    expect(fileType(Buffer.from('??'), 'x.weird')).toBeUndefined();
  });

  let runner: WebRunner;
  let ui: DeviceUi;
  const state = () => path.join(dir, 'state');

  beforeAll(async () => {
    runner = new WebRunner('touchy', {url: `http://127.0.0.1:${port}/touch`, viewport: '800x600'}, dir, state());
    ui = new DeviceUi('web:touchy', runner, {}, {start: () => undefined, stop: () => undefined, since: t => runner.events.filter(e => e.at >= t)});
    await runner.goto();
  }, 60_000);

  afterAll(async () => {
    await ui.stop();
  });

  const inPage = async (expr: string) => (await runner.evaluate(expr)).value;

  it('switches to a phone at run time and back, keeping cookies and storage', {timeout: 60_000}, async () => {
    await inPage('localStorage.setItem("token", "t1"); document.cookie = "sid=s1"; 1');
    await inPage('await new Promise(r => { const q = indexedDB.open("db", 1); q.onupgradeneeded = () => q.result.createObjectStore("kv"); q.onsuccess = () => { const t = q.result.transaction("kv", "readwrite"); t.objectStore("kv").put("v1", "k"); t.oncomplete = () => { q.result.close(); r(1); }; }; })');
    const applied = await runner.emulate({device: 'Pixel 7'});
    expect(await inPage('await new Promise(r => { const q = indexedDB.open("db", 1); q.onsuccess = () => { const g = q.result.transaction("kv").objectStore("kv").get("k"); g.onsuccess = () => r(g.result); }; })')).toBe('"v1"');
    expect(applied[0]).toBe('412x839 @2.625x mobile touch · Pixel 7');
    expect(applied[1]).toMatch(/cookies and storage kept, \/touch reloaded/);
    expect(await inPage('[innerWidth, navigator.maxTouchPoints > 0, localStorage.getItem("token"), document.cookie, /Android/.test(navigator.userAgent)]')).toBe('[412, true, "t1", "sid=s1", true]');
    expect((await ui.snapshot()).lines.some(l => /#pad/.test(l))).toBe(true);
    // Dark alone changes in place: no new context, nothing reloaded.
    expect(await runner.emulate({dark: true})).toEqual(['412x839 @2.625x mobile touch · Pixel 7 · dark']);
    expect(await runner.emulate({viewport: '360x640'})).toHaveLength(2);
    expect(await inPage('[innerWidth, matchMedia("(prefers-color-scheme: dark)").matches]')).toBe('[360, true]');
    await runner.emulate({reset: true});
    expect(await inPage('[innerWidth, navigator.maxTouchPoints, localStorage.getItem("token")]')).toBe('[800, 0, "t1"]');
    await expect(runner.emulate({})).rejects.toThrow(/nothing to change/);
  });

  it('taps, long-presses and swipes with touch events when the page has touch', {timeout: 60_000}, async () => {
    await runner.emulate({device: 'iPhone 15'});
    await inPage('seen.length = 0');
    await ui.press('id=pad');
    expect(await inPage('seen.join(" ")')).toBe('"touchstart touchend mousedown click"');
    await inPage('seen.length = 0');
    await ui.press('id=pad', 'longpress');
    expect(await inPage('seen.join(" ")')).toMatch(/^"touchstart contextmenu touchend/);
    await ui.swipe('up');
    expect(Number(await inPage('scrollY'))).toBeGreaterThan(100);
    await inPage('scrollTo(0, 0); seen.length = 0');
    await ui.touch('down', 'id=pad');
    expect(await inPage('seen.join(" ")')).toBe('"touchstart"');
    await ui.touch('up');
    // Without touch, the same calls are the mouse's.
    await runner.emulate({reset: true});
    await inPage('seen.length = 0');
    await ui.press('id=pad');
    expect(await inPage('seen.join(" ")')).toBe('"mousedown click"');
  });

  it('saves downloads into the state folder, lists them, and waits for a new one', {timeout: 60_000}, async () => {
    expect((await runner.downloads()).downloads).toEqual([]);
    await ui.press('id=get');
    const got = await runner.downloads({waitMs: 10_000});
    expect(got.downloads[0]).toMatchObject({name: 'report.pdf', state: 'done', type: 'application/pdf', size: 23, file: path.join(state(), 'downloads', 'touchy', 'report.pdf')});
    expect(fs.readFileSync(got.downloads[0]!.file!, 'utf8')).toMatch(/^%PDF/);
    // Shown already: a wait needs a new one.
    await expect(runner.downloads({waitMs: 300})).rejects.toThrow(/no new download in 0s \(the last one, "report.pdf", was already shown\)/);
    await ui.press('id=get');
    await ui.press('id=blob');
    expect((await runner.downloads({waitMs: 10_000, grep: 'csv'})).downloads[0]).toMatchObject({name: 'table.csv', type: 'text/csv', size: 7});
    const all = await runner.downloads();
    expect(all.downloads.map(d => path.basename(d.file!))).toEqual(['report.pdf', 'report-2.pdf', 'table.csv']);
  });

  it('waits for a download a listing showed while it was still saving', {timeout: 60_000}, async () => {
    await ui.press('id=slow');
    const t0 = Date.now();
    while (!(await runner.downloads()).downloads.some(d => d.name === 'slow.zip') && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 50));
    expect((await runner.downloads({grep: 'slow'})).downloads.at(-1)).toMatchObject({name: 'slow.zip', state: 'saving'});
    expect((await runner.downloads({waitMs: 10_000})).downloads[0]).toMatchObject({name: 'slow.zip', state: 'done'});
    await expect(runner.downloads({waitMs: Number('slow.zip') * 1000})).rejects.toThrow(/the wait is not a number of seconds/);
  });

  it('keeps the profile on a relaunch and starts clean when asked', {timeout: 60_000}, async () => {
    await inPage('localStorage.setItem("token", "t2"); sessionStorage.setItem("tab", "1"); 1');
    await runner.goto(undefined, 'relaunch');
    expect(await inPage('[localStorage.getItem("token"), sessionStorage.getItem("tab")]')).toBe('["t2", null]');
    await runner.goto(undefined, 'fresh');
    expect(await inPage('localStorage.getItem("token")')).toBe('null');
  });
});
