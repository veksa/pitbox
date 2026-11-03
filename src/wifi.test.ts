// Wireless debugging: adb's mDNS listing, the QR payload, the code a phone shows, and the QR flow against a fake adb.

import {describe, expect, it} from 'vitest';
import {connected, paired, pairByQr, pairingCode, parseCodePairing, parseMdnsServices, type MdnsService} from './drivers/android/wifi.ts';

describe('wireless debugging', () => {
  it("reads adb's mDNS services", () => {
    const out = ['List of discovered mdns services', 'adb-R5CT1234-AbCdEf\t_adb-tls-connect._tcp\t192.168.1.23:37011', 'pitbox-a1b2c3\t_adb-tls-pairing._tcp.\t192.168.1.23:41567', 'studio-x\t_adb._tcp\t[fe80::1]:5555', ''].join('\r\n');
    expect(parseMdnsServices(out)).toEqual([
      {name: 'adb-R5CT1234-AbCdEf', type: 'connect', host: '192.168.1.23', port: 37011},
      {name: 'pitbox-a1b2c3', type: 'pairing', host: '192.168.1.23', port: 41567},
      {name: 'studio-x', type: 'other', host: 'fe80::1', port: 5555},
    ]);
  });

  it('makes a QR the Wireless debugging screen reads', () => {
    const c = pairingCode();
    expect(c.name).toMatch(/^pitbox-[0-9a-f]{6}$/);
    expect(c.password).toMatch(/^\d{6}$/);
    expect(c.qr).toBe(`WIFI:T:ADB;S:${c.name};P:${c.password};;`);
  });

  it("takes the pairing code screen's address and code, and tells adb's answers apart", () => {
    expect(parseCodePairing('192.168.1.23:41567 123456')).toEqual({host: '192.168.1.23', port: 41567, code: '123456'});
    expect(() => parseCodePairing('192.168.1.23 123456')).toThrow(/<ip>:<port> <6-digit code>/);
    expect(paired('Successfully paired to 192.168.1.23:41567 [guid=adb-R5CT1234]')).toBe(true);
    expect(paired('Failed: Wrong password or connection was dropped.')).toBe(false);
    expect(connected('connected to 192.168.1.23:37011')).toBe(true);
    expect(connected('failed to connect to 192.168.1.23:37011')).toBe(false);
  });

  it('pairs with the phone that advertises the QR name, then connects', async () => {
    const calls: string[] = [];
    let polls = 0;
    const adb = {
      mdnsServices: async (): Promise<MdnsService[]> => (++polls < 3 ? [{name: 'someone-else', type: 'pairing', host: '10.0.0.9', port: 1}] : [{name: 'pitbox-a1b2c3', type: 'pairing', host: '10.0.0.5', port: 41567}]),
      pair: async (host: string, port: number, code: string) => void calls.push(`pair ${host}:${port} ${code}`),
      connectPaired: async (host: string) => {
        calls.push(`connect ${host}`);
        return `${host}:37011`;
      },
    };
    expect(await pairByQr(adb, {name: 'pitbox-a1b2c3', password: '654321'}, {pollMs: 5})).toEqual({serial: '10.0.0.5:37011'});
    expect(calls).toEqual(['pair 10.0.0.5:41567 654321', 'connect 10.0.0.5']);
  });

  it('gives up when nobody scans, and passes on a failed pairing', async () => {
    const none = {mdnsServices: async () => [], pair: async () => undefined, connectPaired: async () => ''};
    expect((await pairByQr(none, {name: 'pitbox-x', password: '1'}, {timeoutMs: 30, pollMs: 5})).error).toMatch(/no phone scanned the QR/);
    const failing = {...none, mdnsServices: async (): Promise<MdnsService[]> => [{name: 'pitbox-x', type: 'pairing', host: '10.0.0.5', port: 1}], pair: async () => Promise.reject(new Error('pairing with 10.0.0.5:1 failed: Wrong password'))};
    expect(await pairByQr(failing, {name: 'pitbox-x', password: '1'}, {pollMs: 5})).toEqual({error: 'pairing with 10.0.0.5:1 failed: Wrong password'});
  });
});
