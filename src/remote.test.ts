import type {AddressInfo} from 'node:net';
import {describe, expect, it} from 'vitest';
import {RemoteApple, RemoteAppleCrashes} from './remote/appleRemote.ts';

const onMac = process.platform === 'darwin';

describe.runIf(onMac)('device host', () => {
  it('answers with the token only and says what it is', async () => {
    const {createDeviceHost} = await import('./remote/deviceHost.ts');
    const {server, close} = createDeviceHost('secret');
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(new RemoteApple(url, 'wrong').call('hello')).rejects.toThrow(/refused the token/);
      expect(await new RemoteApple(url, 'secret').call('hello')).toMatchObject({version: 1});
      await expect(new RemoteApple(url, 'secret').call('nope')).rejects.toThrow(/unknown device host method/);
    } finally {
      await close();
    }
  });
});

describe('remote mac', () => {
  it('says what to check when the mac does not answer', async () => {
    await expect(new RemoteApple('http://127.0.0.1:9', 't').call('hello', {}, 2000)).rejects.toThrow(/serve-devices/);
  });

  it('moves crash times from the mac clock onto this one', async () => {
    const remote = {call: async () => ({events: [{at: 1_000_000, kind: 'crash', summary: 'x', lines: []}], now: Date.now() - 60_000})};
    const [e] = await new RemoteAppleCrashes(remote as never, 'AAA', 'com.example.app').since(Date.now());
    // The mac runs a minute behind: its 1_000_000 is this machine's 1_060_000.
    expect(Math.round((e!.at - 1_000_000) / 1000)).toBe(60);
  });
});
