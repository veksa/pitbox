// Wireless debugging (Android 11+): a phone on the same network pairs with adb once, then connects without a
// cable. The QR flow is the one in Developer options → Wireless debugging → Pair device with QR code: the QR holds
// a service name and a password, the phone advertises that name over mDNS, and adb pairs with it.

import crypto from 'node:crypto';

export type MdnsService = {name: string; type: 'pairing' | 'connect' | 'other'; host: string; port: number};

/** `adb mdns services`: `<instance>\t<_adb-tls-pairing._tcp>\t<ip>:<port>` per line. */
export const parseMdnsServices = (out: string): MdnsService[] =>
  out.split(/\r?\n/).flatMap(line => {
    const m = /^(\S+)\s+(_[\w-]+\._tcp)\.?\s+(\[[0-9a-fA-F:]+\]|[\d.]+):(\d+)\s*$/.exec(line.trim());
    if (!m) return [];
    const type = /_adb-tls-pairing/.test(m[2]!) ? 'pairing' : /_adb-tls-connect/.test(m[2]!) ? 'connect' : 'other';
    return [{name: m[1]!, type, host: m[3]!.replace(/^\[|\]$/g, ''), port: Number(m[4])}];
  });

/** A name and password for one pairing, and the QR text the phone's camera reads. */
export const pairingCode = () => {
  const name = `pitbox-${crypto.randomBytes(3).toString('hex')}`;
  const password = String(crypto.randomInt(100000, 999999));
  return {name, password, qr: `WIFI:T:ADB;S:${name};P:${password};;`};
};

/** `adb pair` and `adb connect` answer on stdout with a sentence; these tell success apart. */
export const paired = (out: string) => /Successfully paired/i.test(out);
export const connected = (out: string) => /connected to|already connected/i.test(out) && !/failed|cannot|unable/i.test(out);

/** `ip:port code` as typed from the phone's "Pair device with pairing code" screen. */
export const parseCodePairing = (value: string): {host: string; port: number; code: string} => {
  const m = /^\s*(\[[0-9a-fA-F:]+\]|[\d.]+):(\d+)\s+(\d{6})\s*$/.exec(value);
  if (!m) throw new Error(`pairing by code takes "<ip>:<port> <6-digit code>" from the phone's Pair device with pairing code screen, not "${value}"`);
  return {host: m[1]!.replace(/^\[|\]$/g, ''), port: Number(m[2]), code: m[3]!};
};

export type WifiAdb = {
  mdnsServices: () => Promise<MdnsService[]>;
  pair: (host: string, port: number, code: string) => Promise<void>;
  connectPaired: (host: string) => Promise<string>;
};

/**
 * Waits for the phone that scanned the QR (it advertises the QR's service name), pairs with the QR's password
 * and connects. Answers the serial, or why not; `stop` ends the wait early (a newer pairing took over).
 */
export const pairByQr = async (adb: WifiAdb, code: {name: string; password: string}, opts: {timeoutMs?: number; pollMs?: number; stop?: () => boolean} = {}): Promise<{serial?: string; error?: string}> => {
  const end = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  try {
    while (Date.now() < end && !opts.stop?.()) {
      const svc = (await adb.mdnsServices()).find(s => s.type === 'pairing' && s.name === code.name);
      if (svc) {
        await adb.pair(svc.host, svc.port, code.password);
        return {serial: await adb.connectPaired(svc.host)};
      }
      await new Promise(r => setTimeout(r, opts.pollMs ?? 1000));
    }
    return {error: opts.stop?.() ? 'a newer pairing took over' : 'no phone scanned the QR in time: the same network as this computer, and Wireless debugging → Pair device with QR code'};
  } catch (e) {
    return {error: (e as Error).message};
  }
};
