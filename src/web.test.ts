import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {WebRunner, webKey} from './drivers/web/runner.ts';
import {DeviceUi} from './ui/device.ts';
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

let port = 0;
let server: http.Server;
let dir = '';

beforeAll(async () => {
  port = await freePort();
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/hello')) {
      const name = new URL(req.url, 'http://x').searchParams.get('name');
      setTimeout(() => res.end(`Signed in as ${name}`), 200);
    } else if (req.url === '/second') res.end('<!doctype html><title>Second</title><h2 data-testid="second">Second page</h2><button onclick="boom()">Break</button>');
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
    } finally {
      await e.stopAll();
    }
  });
});
