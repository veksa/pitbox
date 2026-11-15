// A stand-in for the Wear OS Data Layer between two emulators: `device action=pair value=watch` with an Android
// phone. A real Data Layer connection needs the Play Store companion app and a Google account on both devices,
// which an emulator stand has not; Play services gives no shell way to add a connection. So pitbox pairs the two
// apps itself: the connect library's debug-only PitboxWearReceiver saves a pairing (where the daemon listens, a
// token naming the side, the device's node id), PitboxWearable answers the app's Data Layer calls from it, and the
// daemon relays messages — app → daemon over TCP to the emulator's host alias 10.0.2.2, daemon → app by `am
// broadcast`, which also wakes an app that is not running and reaches its WearableListenerService.

import {createHash, randomBytes} from 'node:crypto';
import net from 'node:net';
import {assertPackage, parseBroadcast} from '../../push/android.ts';

export const WEAR_RECEIVER = 'dev.pitbox.connect.PitboxWearReceiver';

/** The Data Layer's status codes a send can fail with (`WearableStatusCodes`). */
export const TARGET_NODE_NOT_CONNECTED = 4000;
export const DATA_TOO_LARGE = 4003;
/** MessageClient refuses a message larger than this. */
export const MAX_MESSAGE_BYTES = 100 * 1024;

export type Shell = (serial: string, command: string, timeoutMs?: number) => Promise<string>;

/** What the receiver reports about the app on one device. */
export type WearProbe = {paired: boolean; internet: boolean; services: string[]; capabilities: string[]; cert?: string; sdk?: number};

export type WearSide = {serial: string; name: string; node: string; token: string; capabilities: string[]};

export type WearPair = {id: string; pkg: string; phone: WearSide; watch: WearSide; messages: number; log: string[]};

const list = (v?: string) => (!v || v === '-' ? [] : v.split(','));

/** The receiver's `ok paired=… internet=… services=… capabilities=… cert=… sdk=…`. */
export const parseProbe = (data: string): WearProbe => {
  const kv = Object.fromEntries(data.replace(/^ok\s*/, '').split(/\s+/).filter(Boolean).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
  return {
    paired: kv.paired === 'true',
    internet: kv.internet === 'true',
    services: list(kv.services),
    capabilities: list(kv.capabilities),
    ...(kv.cert && kv.cert !== '-' ? {cert: kv.cert} : {}),
    ...(kv.sdk ? {sdk: Number(kv.sdk)} : {}),
  };
};

/** A node id the way Play services prints them (8 hex), stable for a device name and an app. */
export const nodeId = (name: string, pkg: string): string => createHash('sha256').update(`${name}\n${pkg}`).digest('hex').slice(0, 8);

/** Standard base64, padded: what PitboxWearable sends, and nothing that could mean anything else. */
export const isBase64 = (s: string): boolean => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);

/** Single quotes for the device's shell: a Data Layer path is any string. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export type WearReply = {ok: true; id?: number; nodes?: {id: string; name: string; capabilities: string[]}[]; source?: string; path?: string; data?: string} | {ok: false; code: number; error: string};

export class WearRelay {
  readonly #pairs = new Map<string, WearPair>();
  #server?: net.Server;
  #port?: number;
  #n = 0;
  #requests = 0;
  /** Messages accepted for a device, until its app fetched them and said what it did with them. */
  readonly #waiting = new Map<number, {to: WearSide; pair: WearPair; source: string; path: string; data: string; who: string; at: number; taken?: boolean}>();

  /** `host` is where an emulator reaches this machine's loopback (the daemon listens on 127.0.0.1 only). */
  readonly shell: Shell;
  readonly opts: {host?: string; listen?: boolean};

  constructor(shell: Shell, opts: {host?: string; listen?: boolean} = {}) {
    this.shell = shell;
    this.opts = opts;
  }

  pairs(): WearPair[] {
    return [...this.#pairs.values()];
  }

  /** The pair a device is in, as the phone or the watch. */
  pairOf(serial: string): WearPair | undefined {
    return this.pairs().find(p => p.phone.serial === serial || p.watch.serial === serial);
  }

  async #broadcast(serial: string, pkg: string, extras: string): Promise<{code: number; data?: string}> {
    assertPackage(pkg);
    // 0x10000020: FLAG_RECEIVER_FOREGROUND | FLAG_INCLUDE_STOPPED_PACKAGES — a stopped app is woken as Play services would.
    return parseBroadcast(await this.shell(serial, `am broadcast -f 0x10000020 -n ${pkg}/${WEAR_RECEIVER} ${extras}`, 20_000));
  }

  /** The app's side on one device; throws why it cannot be paired. */
  async probe(serial: string, pkg: string): Promise<WearProbe> {
    const r = await this.#broadcast(serial, pkg, '--es op probe');
    if (r.code === 1 && r.data) return parseProbe(r.data);
    if (r.data?.startsWith('error ')) throw new Error(`${pkg} on ${serial}: ${r.data.slice(6)}`);
    const installed = (await this.shell(serial, `pm path ${pkg}`).catch(() => '')).includes('package:');
    if (!installed) throw new Error(`${pkg} is not installed on ${serial}\nhint: install the debug build on both devices first, then pair`);
    throw new Error(`${pkg} on ${serial} has no pitbox wear receiver\nhint: build the debug variant with a @veksa/pitbox connect library that has the Wear OS relay (debugImplementation)`);
  }

  /** Where the apps reach the daemon: started on the first pair, on 127.0.0.1 and a port the system picks. */
  async #listen(): Promise<number> {
    if (this.#port !== undefined) return this.#port;
    if (this.opts.listen === false) return (this.#port = 0);
    const server = net.createServer(socket => this.#serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    this.#server = server;
    this.#port = (server.address() as net.AddressInfo).port;
    return this.#port;
  }

  #serve(socket: net.Socket) {
    socket.setTimeout(30_000, () => socket.destroy());
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (buf.length > 4 * MAX_MESSAGE_BYTES) return socket.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      let req: Record<string, unknown>;
      try {
        req = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return socket.end(`${JSON.stringify({ok: false, code: 13, error: 'bad request'})}\n`);
      }
      void this.handle(req).then(r => socket.end(`${JSON.stringify(r)}\n`), (e: Error) => socket.end(`${JSON.stringify({ok: false, code: 13, error: e.message})}\n`));
    });
    socket.on('error', () => undefined);
  }

  #sideOf(token: unknown): {pair: WearPair; me: WearSide; peer: WearSide} | undefined {
    if (typeof token !== 'string' || !token) return undefined;
    for (const pair of this.#pairs.values()) {
      if (pair.phone.token === token) return {pair, me: pair.phone, peer: pair.watch};
      if (pair.watch.token === token) return {pair, me: pair.watch, peer: pair.phone};
    }
    return undefined;
  }

  #note(pair: WearPair, line: string) {
    pair.log.push(line);
    if (pair.log.length > 20) pair.log.shift();
  }

  /** One request from an app: `nodes`, or `send` to the paired node. */
  async handle(req: Record<string, unknown>): Promise<WearReply> {
    const side = this.#sideOf(req.token);
    if (!side) return {ok: false, code: TARGET_NODE_NOT_CONNECTED, error: 'this device is not paired any more (pitbox device pair watch pairs it again)'};
    const {pair, me, peer} = side;
    if (req.op === 'nodes') return {ok: true, nodes: [{id: peer.node, name: peer.name, capabilities: peer.capabilities}]};
    if (req.op === 'take' || req.op === 'delivered') {
      const w = this.#waiting.get(Number(req.id));
      if (!w || w.to !== me) return {ok: false, code: 13, error: `no message ${String(req.id)} for this device`};
      if (req.op === 'delivered') {
        this.#waiting.delete(Number(req.id));
        this.#note(pair, `${w.who}: ${String(req.result ?? '').slice(0, 200)}`);
        return {ok: true};
      }
      w.taken = true;
      return {ok: true, source: w.source, path: w.path, data: w.data};
    }
    if (req.op !== 'send') return {ok: false, code: 13, error: `unknown op ${String(req.op)}`};
    const path = typeof req.path === 'string' ? req.path : '';
    const data = typeof req.data === 'string' ? req.data : '';
    if (!path.startsWith('/')) return {ok: false, code: 13, error: 'a message path starts with /'};
    if (!isBase64(data)) return {ok: false, code: 13, error: 'the message data is not base64'};
    if (req.node !== peer.node) return {ok: false, code: TARGET_NODE_NOT_CONNECTED, error: `node ${String(req.node)} is not connected (the paired node is ${peer.node})`};
    const bytes = Buffer.from(data, 'base64').length;
    if (bytes > MAX_MESSAGE_BYTES) return {ok: false, code: DATA_TOO_LARGE, error: `${bytes} bytes is more than a message carries (${MAX_MESSAGE_BYTES})`};
    for (const [k, w] of this.#waiting) if (Date.now() - w.at > 120_000) this.#waiting.delete(k);
    const id = ++this.#requests;
    const who = `${me === pair.phone ? 'phone→watch' : 'watch→phone'} ${path} ${bytes}B`;
    // The content waits here; the device gets only the id (a number) and fetches the rest over its own connection,
    // so nothing an app sent ever reaches the device's shell, and the size is not bound by a command line.
    this.#waiting.set(id, {to: peer, pair, source: me.node, path, data, who, at: Date.now()});
    const r = await this.#broadcast(peer.serial, pair.pkg, `--es op message --es id ${id}`).catch((e: Error) => ({code: -1, data: `error ${e.message.split('\n')[0]}`}));
    pair.messages++;
    if (r.code === 1) return {ok: true, id};
    this.#waiting.delete(id);
    this.#note(pair, `${who}: not delivered (${r.data?.replace(/^error\s*/, '') ?? 'no answer from the app'})`);
    if (/not-paired/.test(r.data ?? '')) return {ok: false, code: TARGET_NODE_NOT_CONNECTED, error: `the app on ${peer.name} is not paired (reinstalled or cleared?)`};
    return {ok: true, id};
  }

  async #pairSide(side: WearSide, pkg: string, port: number) {
    const host = this.opts.host ?? '10.0.2.2';
    const r = await this.#broadcast(side.serial, pkg, `--es op pair --es host ${host} --es port ${port} --es token ${side.token} --es node ${side.node} --es name ${quote(side.name)}`);
    if (r.code !== 1) throw new Error(`could not pair ${pkg} on ${side.serial}: ${r.data ?? 'no answer'}`);
  }

  /**
   * Pairs the app on a phone and a watch emulator. Both must have the same package (the Data Layer joins only one
   * app with itself); a different signing certificate is reported, as a real Data Layer would not deliver then.
   */
  async pair(pkg: string, phone: {serial: string; name: string}, watch: {serial: string; name: string}): Promise<{pair: WearPair; warnings: string[]}> {
    assertPackage(pkg);
    const [pp, wp] = await Promise.all([this.probe(phone.serial, pkg), this.probe(watch.serial, pkg)]);
    const warnings: string[] = [];
    for (const [what, pr] of [['phone', pp], ['watch', wp]] as const) {
      if (!pr.internet) warnings.push(`the app on the ${what} lacks the INTERNET permission: its sends cannot reach pitbox`);
      if (!pr.services.length) warnings.push(`the app on the ${what} declares no WearableListenerService for MESSAGE_RECEIVED: only listeners it adds hear messages`);
    }
    if (pp.cert && wp.cert && pp.cert !== wp.cert) warnings.push('the phone and watch builds are signed with different keys: a real Data Layer would not deliver between them');
    // A device already in another pair leaves it first.
    for (const s of [phone.serial, watch.serial]) {
      const old = this.pairOf(s);
      if (old) await this.unpair(old.id);
    }
    const port = await this.#listen();
    const side = (d: {serial: string; name: string}, caps: string[]): WearSide => ({...d, node: nodeId(d.name, pkg), token: randomBytes(16).toString('hex'), capabilities: caps});
    const pair: WearPair = {id: `wear-${++this.#n}`, pkg, phone: side(phone, pp.capabilities), watch: side(watch, wp.capabilities), messages: 0, log: []};
    await this.#pairSide(pair.phone, pkg, port);
    await this.#pairSide(pair.watch, pkg, port);
    this.#pairs.set(pair.id, pair);
    return {pair, warnings};
  }

  /** Pairs one side again: an install over the app keeps its data, but an uninstall or a clear forgets the pairing. */
  async repair(serial: string): Promise<boolean> {
    const pair = this.pairOf(serial);
    if (!pair || this.#port === undefined) return false;
    const side = pair.phone.serial === serial ? pair.phone : pair.watch;
    await this.#pairSide(side, pair.pkg, this.#port);
    return true;
  }

  /** Forgets a pair: both apps drop their pairing (where they still answer), and the daemon its tokens. */
  async unpair(id: string): Promise<WearPair | undefined> {
    const pair = this.#pairs.get(id);
    if (!pair) return undefined;
    this.#pairs.delete(id);
    await Promise.all([pair.phone, pair.watch].map(s => this.#broadcast(s.serial, pair.pkg, '--es op unpair').catch(() => undefined)));
    return pair;
  }

  async close() {
    for (const id of [...this.#pairs.keys()]) await this.unpair(id);
    this.#server?.close();
    this.#server = undefined;
    this.#port = undefined;
  }
}
