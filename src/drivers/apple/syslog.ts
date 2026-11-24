// A physical iPhone's or iPad's system log, read as `idevicesyslog` reads it: lockdown (port 62078 on the device,
// through usbmuxd) starts its `com.apple.syslog_relay` service in a TLS session made with the Mac's pair record,
// which usbmuxd hands out without root (`log collect --device` needs root). The relay streams only what is logged
// from then on, so the driver keeps one stream per device and the recent lines in memory: `logs` filters them as
// `log show` filters a simulator's.

import {execFileSync} from 'node:child_process';
import type net from 'node:net';
import tls from 'node:tls';
import {AppleError} from './driver.ts';
import {muxConnect, muxRequest} from './physical.ts';

/** One record of the relay: `Nov 24 10:38:12 <device> MyApp(CFNetwork)[123] <Error>: message`. */
export type LogEntry = {at: number; proc: string; pid: number; level: string; text: string};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RECORD = /^(\w{3})\s+(\d+) (\d\d):(\d\d):(\d\d) \S+ (.+?)\[(\d+)\] <(\w+)>: ([\s\S]*)$/;

/** A relay record, its time in the Mac's year (a December line read in January is last year's). */
export const parseSyslog = (record: string, now = Date.now()): LogEntry | undefined => {
  const m = RECORD.exec(record.replace(/\n+$/, ''));
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]!);
  if (month < 0) return undefined;
  const year = new Date(now).getFullYear();
  let at = new Date(year, month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  if (at - now > 86_400_000) at = new Date(year - 1, month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  // `MyApp(CFNetwork)`: the process, then the library that logged.
  const proc = m[6]!.replace(/\(.*\)$/, '');
  return {at, proc, pid: Number(m[7]), level: m[8]!, text: m[9]!};
};

const LETTER: Record<string, string> = {Debug: 'D', Info: 'I', Notice: 'N', Warning: 'W', Error: 'E', Fault: 'F'};

/** The levels `level` keeps: a simulator's `log show` reading of the same words. */
const levelsFor = (level?: string): Set<string> => {
  const l = level?.toLowerCase();
  if (l === 'e' || l === 'error') return new Set(['Error', 'Fault']);
  if (l === 'w' || l === 'warn' || l === 'warning') return new Set(['Warning', 'Error', 'Fault']);
  if (l === 'f' || l === 'fault') return new Set(['Fault']);
  if (l === 'd' || l === 'debug' || l === 'v') return new Set(Object.keys(LETTER));
  return new Set(['Info', 'Notice', 'Warning', 'Error', 'Fault']);
};

/** The last `lines` entries of a process (all when no `exe`), as short lines: `10:38:12 E MyApp[123] message`. */
export const formatLog = (entries: readonly LogEntry[], opts: {exe?: string; lines?: number; grep?: string; level?: string} = {}): string[] => {
  const keep = levelsFor(opts.level);
  const re = opts.grep ? new RegExp(opts.grep, 'i') : undefined;
  const out: string[] = [];
  for (const e of entries) {
    if (opts.exe && e.proc !== opts.exe) continue;
    if (!keep.has(e.level)) continue;
    const t = new Date(e.at);
    const line = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')} ${LETTER[e.level] ?? e.level} ${e.proc}[${e.pid}] ${e.text}`;
    if (re && !re.test(line)) continue;
    out.push(line);
  }
  return out.slice(-(opts.lines ?? 50));
};

const xmlOf = (bin: Buffer) => execFileSync('plutil', ['-convert', 'xml1', '-o', '-', '-'], {input: bin}).toString();
const dataOf = (xml: string, key: string) => {
  const m = new RegExp(`<key>${key}</key>\\s*<data>([^<]+)</data>`).exec(xml);
  return m ? Buffer.from(m[1]!.replace(/\s/g, ''), 'base64') : undefined;
};
const stringOf = (xml: string, key: string) => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1];
const plistOf = (o: Record<string, string>) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${Object.entries(o)
    .map(([k, v]) => `<key>${k}</key><string>${v}</string>`)
    .join('')}</dict></plist>`;

type PairRecord = {cert: string; key: string; hostId: string; buid: string};

/** The Mac's pairing with the device (its certificate and key for lockdown's TLS), from usbmuxd. */
const pairRecord = async (udid: string): Promise<PairRecord> => {
  const answer = await muxRequest({MessageType: 'ReadPairRecord', PairRecordID: udid});
  const data = dataOf(answer, 'PairRecordData');
  if (!data) throw new AppleError(`this Mac is not paired with ${udid}`, 'unlock the device and answer "Trust This Computer"');
  const xml = xmlOf(data);
  const cert = dataOf(xml, 'HostCertificate')?.toString();
  const key = dataOf(xml, 'HostPrivateKey')?.toString();
  const hostId = stringOf(xml, 'HostID');
  const buid = stringOf(xml, 'SystemBUID');
  if (!cert || !key || !hostId || !buid) throw new AppleError(`the pair record of ${udid} is incomplete`, 'pair the device again in Xcode › Devices');
  return {cert, key, hostId, buid};
};

/** Lockdown's framing: a 4-byte big-endian length, then a plist (XML from us, XML or binary back). */
const lockdownClient = (sock: net.Socket | tls.TLSSocket, timeoutMs: number) => {
  let buf = Buffer.alloc(0);
  const waiting: {resolve: (s: string) => void; reject: (e: Error) => void}[] = [];
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const n = buf.readUInt32BE(0);
      const body = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      // `bplist00`: binary.
      waiting.shift()?.resolve(body.subarray(0, 6).toString() === 'bplist' ? xmlOf(body) : body.toString());
    }
  };
  const onEnd = () => {
    for (const w of waiting.splice(0)) w.reject(new Error('lockdown closed the connection'));
  };
  sock.on('data', onData);
  sock.on('close', onEnd);
  return {
    ask: (o: Record<string, string>) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`lockdown did not answer ${o.Request}`)), timeoutMs);
        waiting.push({resolve: v => (clearTimeout(timer), resolve(v)), reject: e => (clearTimeout(timer), reject(e))});
        const body = Buffer.from(plistOf({Label: 'pitbox', ...o}));
        const head = Buffer.alloc(4);
        head.writeUInt32BE(body.length);
        sock.write(Buffer.concat([head, body]));
      }),
    detach: () => {
      sock.off('data', onData);
      sock.off('close', onEnd);
    },
  };
};

// The pair record's certificates are older than OpenSSL's default security level allows.
const tlsOver = (socket: net.Socket, pair: PairRecord) =>
  new Promise<tls.TLSSocket>((resolve, reject) => {
    const s = tls.connect({socket, cert: pair.cert, key: pair.key, rejectUnauthorized: false, ciphers: 'DEFAULT:@SECLEVEL=0', minVersion: 'TLSv1'});
    s.once('secureConnect', () => resolve(s));
    s.once('error', reject);
  });

const LOCKDOWN_PORT = 62078;

/** A connection to one of the device's lockdown services (`com.apple.syslog_relay`). */
export const startService = async (udid: string, service: string, timeoutMs = 10_000): Promise<net.Socket | tls.TLSSocket> => {
  const pair = await pairRecord(udid);
  const raw = await muxConnect(udid, LOCKDOWN_PORT, timeoutMs);
  try {
    const plain = lockdownClient(raw, timeoutMs);
    const session = await plain.ask({Request: 'StartSession', HostID: pair.hostId, SystemBUID: pair.buid});
    const sessionError = stringOf(session, 'Error');
    if (sessionError) throw new AppleError(`lockdown refused the session: ${sessionError}`, sessionError === 'InvalidHostID' ? 'pair the device again: unplug it, plug it in and answer "Trust This Computer"' : undefined);
    plain.detach();
    const secure = /<key>EnableSessionSSL<\/key>\s*<true/.test(session) ? await tlsOver(raw, pair) : raw;
    const started = await lockdownClient(secure, timeoutMs).ask({Request: 'StartService', Service: service});
    const port = Number(/<key>Port<\/key>\s*<integer>(\d+)<\/integer>/.exec(started)?.[1]);
    if (!port) throw new AppleError(`lockdown did not start ${service}: ${stringOf(started, 'Error') ?? 'no port'}`, deviceLockedHint(started));
    const s = await muxConnect(udid, port, timeoutMs);
    return /<key>EnableServiceSSL<\/key>\s*<true/.test(started) ? await tlsOver(s, pair) : s;
  } finally {
    raw.destroy();
  }
};

const deviceLockedHint = (answer: string) => (/PasswordProtected/.test(answer) ? 'unlock the device' : undefined);

/** How many records a device's log keeps: some minutes of a busy device (it logs a few hundred lines a second). */
const KEEP = 60_000;

/** A device's log since the stream started, kept while the device is in use. */
export class DeviceLog {
  readonly since = Date.now();
  #entries: LogEntry[] = [];
  #partial = '';
  #closed = false;
  readonly #sock: net.Socket | tls.TLSSocket;

  private constructor(sock: net.Socket | tls.TLSSocket) {
    this.#sock = sock;
    // The stream must not hold the daemon open on its own.
    (sock as net.Socket).unref?.();
    sock.on('data', (d: Buffer) => this.#take(d.toString('utf8')));
    sock.on('close', () => (this.#closed = true));
    sock.on('error', () => (this.#closed = true));
  }

  static async open(udid: string): Promise<DeviceLog> {
    return new DeviceLog(await startService(udid, 'com.apple.syslog_relay'));
  }

  get closed() {
    return this.#closed;
  }

  get entries(): readonly LogEntry[] {
    return this.#entries;
  }

  /** Records end with a NUL byte; a message of several lines is one record. */
  #take(chunk: string) {
    const parts = (this.#partial + chunk).split('\0');
    this.#partial = parts.pop() ?? '';
    for (const p of parts) {
      const e = parseSyslog(p);
      if (e) this.#entries.push(e);
    }
    if (this.#entries.length > KEEP * 1.2) this.#entries = this.#entries.slice(-KEEP);
  }

  close() {
    this.#closed = true;
    this.#sock.destroy();
  }
}
