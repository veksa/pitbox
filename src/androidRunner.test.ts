// The host side of the Android runner against a fake device: several daemons reaching one device at once install
// and start the runner once between them, and a runner that is already there (this version or a newer one) is used
// as it is. Installing or force-stopping the runner on a real device kills it mid-call for whoever uses it.

import net from 'node:net';
import {afterEach, describe, expect, it} from 'vitest';
import type {AndroidDriver} from './drivers/android/driver.ts';
import {AndroidRunner, RUNNER_VERSION} from './drivers/android/runner.ts';

type Device = {version?: number; updated: number; running: boolean; out: string; installs: number; launches: number; kills: number};

/** A device whose runner listens on a local port while `running`; installing or stopping it drops its connections. */
const fakeDevice = async (init: Partial<Device> = {}) => {
  const dev: Device = {updated: 0, running: false, out: '', installs: 0, launches: 0, kills: 0, ...init};
  const sockets = new Set<net.Socket>();
  const server = net.createServer(s => {
    if (!dev.running) return void s.destroy();
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    let buf = '';
    s.on('data', d => {
      buf += d.toString();
      let k: number;
      while ((k = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, k)) as {id: number};
        buf = buf.slice(k + 1);
        // A runner answers after a moment: long enough for another daemon to act in between.
        setTimeout(() => s.writable && s.write(`${JSON.stringify({id: req.id, ok: true})}\n`), 30);
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  const kill = () => {
    if (dev.running) dev.kills++;
    dev.running = false;
    for (const s of sockets) s.destroy();
  };
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  const driver = {
    async adb(args: string[]) {
      await pause(20);
      if (args[0] === 'forward') return {code: 0, stdout: args[1] === '--remove' ? '' : `${port}\n`, stderr: ''};
      if (args[0] === 'install') {
        await pause(150);
        kill();
        dev.installs++;
        dev.version = RUNNER_VERSION;
        dev.updated++;
        return {code: 0, stdout: 'Success\n', stderr: ''};
      }
      if (args[0] === 'uninstall') {
        kill();
        dev.version = undefined;
        return {code: 0, stdout: 'Success\n', stderr: ''};
      }
      throw new Error(`unexpected adb ${args.join(' ')}`);
    },
    async shell(_serial: string, cmd: string) {
      await pause(20);
      if (cmd.startsWith('dumpsys package')) return dev.version === undefined ? '' : `    versionCode=${dev.version} minSdk=24\n    lastUpdateTime=2026-01-01 00:00:${String(dev.updated).padStart(2, '0')}\n`;
      if (cmd.startsWith('am force-stop')) {
        kill();
        return '';
      }
      if (cmd.startsWith('getprop')) return '36\n';
      if (cmd.startsWith('cat ')) return dev.out;
      if (cmd.includes('am instrument')) {
        dev.launches++;
        dev.out = '';
        setTimeout(() => {
          dev.running = true;
          dev.out = 'INSTRUMENTATION_STATUS: pitbox=ready 7912\n';
        }, 200);
        return '';
      }
      throw new Error(`unexpected shell ${cmd}`);
    },
  } as unknown as AndroidDriver;
  return {dev, driver, close: () => new Promise<void>(r => (kill(), server.close(() => r())))};
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe('the android runner on a device several daemons use', () => {
  it('is installed and started once when several daemons reach a fresh device at once, and none is cut off', async () => {
    const {dev, driver, close} = await fakeDevice();
    closers.push(close);
    const runners = Array.from({length: 3}, () => new AndroidRunner(driver, 'emulator-5554'));
    try {
      await Promise.all(runners.map(r => r.call('info')));
      // Every daemon's runner is still connected after all of them started: nobody's install or start killed another's.
      await Promise.all(runners.map(r => r.call('info')));
      expect({installs: dev.installs, launches: dev.launches, kills: dev.kills}).toEqual({installs: 1, launches: 1, kills: 0});
    } finally {
      for (const r of runners) await r.stop();
    }
  }, 30_000);

  it('uses a newer runner as it is: two versions of pitbox do not replace each other in turn', async () => {
    const {dev, driver, close} = await fakeDevice({version: RUNNER_VERSION + 1, running: true});
    closers.push(close);
    const r = new AndroidRunner(driver, 'emulator-5554');
    try {
      await r.call('info');
      expect({installs: dev.installs, launches: dev.launches, kills: dev.kills}).toEqual({installs: 0, launches: 0, kills: 0});
    } finally {
      await r.stop();
    }
  }, 30_000);

  it('replaces an older runner once', async () => {
    const {dev, driver, close} = await fakeDevice({version: RUNNER_VERSION - 1, running: true});
    closers.push(close);
    const runners = [new AndroidRunner(driver, 'emulator-5554'), new AndroidRunner(driver, 'emulator-5554')];
    try {
      await Promise.all(runners.map(r => r.call('info')));
      expect({installs: dev.installs, launches: dev.launches, version: dev.version}).toEqual({installs: 1, launches: 1, version: RUNNER_VERSION});
    } finally {
      for (const r of runners) await r.stop();
    }
  }, 30_000);
});
