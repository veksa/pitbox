// Services must outlive the daemon that started them: no shared console (Windows kills console processes when
// it closes) and no pipe through the daemon (the next write after it exits dies of EPIPE). Both failures are
// silent — the service just disappears a little later — so this runs the real thing in child processes.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {freePort, tcpOpen} from './util/net.ts';
import {killTreeAndWait} from './util/proc.ts';

describe('services outlive the daemon', () => {
  it('keeps serving and logging after the daemon process exits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-exit-'));
    const port = await freePort();
    const node = process.execPath.replace(/\\/g, '/');
    const grandchild = path.join(dir, 'grandchild.cjs');
    fs.writeFileSync(grandchild, `require('http').createServer((q, s) => s.end('ok')).listen(${port}); setInterval(() => console.log('tick', Date.now()), 100);`);
    const service = path.join(dir, 'service.cjs');
    // Like a file-watching dev server: the process that serves is a grandchild, started through a console shell.
    const launch = process.platform === 'win32' ? `['cmd.exe', ['/d', '/c', ${JSON.stringify(node)}, ${JSON.stringify(grandchild)}]]` : `[${JSON.stringify(node)}, [${JSON.stringify(grandchild)}]]`;
    fs.writeFileSync(service, `const [f, a] = ${launch}; require('child_process').spawn(f, a, {stdio: 'inherit'}); setInterval(() => {}, 1000);`);
    const daemon = path.join(dir, 'daemon.mts');
    const services = pathToFileURL(path.resolve('src/stand/services.ts')).href;
    fs.writeFileSync(
      daemon,
      `import {ServiceManager} from ${JSON.stringify(services)};
const m = new ServiceManager({root: ${JSON.stringify(dir)}, stateDir: ${JSON.stringify(path.join(dir, '.pitbox'))}}, {svc: {start: ${JSON.stringify(`"${node}" "${service.replace(/\\/g, '/')}"`)}, health: 'tcp:${port}', startTimeout: 30}});
const [s] = await m.up();
console.log(JSON.stringify(s));
process.exit(0);
`,
    );
    const out = fs.openSync(path.join(dir, 'daemon.log'), 'a');
    const d = spawn(process.execPath, [daemon], {detached: true, windowsHide: true, stdio: ['ignore', out, out]});
    await new Promise(r => d.on('exit', r));
    const started = fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8');
    expect(started).toContain('"status":"up"');

    const log = path.join(dir, '.pitbox', 'logs', 'svc.log');
    const size0 = fs.statSync(log).size;
    await new Promise(r => setTimeout(r, 2500));
    expect(await tcpOpen(port)).toBe(true);
    expect(fs.statSync(log).size).toBeGreaterThan(size0);

    const pid = JSON.parse(fs.readFileSync(path.join(dir, '.pitbox', 'pids.json'), 'utf8')).svc;
    await killTreeAndWait(pid.pid, 8000, pid.startedAt);
    expect(await tcpOpen(port)).toBe(false);
  }, 60_000);
});
