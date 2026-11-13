// The stand's push gateway: a stand-in for APNs and FCM that a project's server reaches in its local
// environment instead of Apple's and Google's services. It takes the requests those services take — the same
// paths and bodies, so a server only swaps the origin — and delivers each push to the running simulator or
// emulator through `push`. No credentials, no Google account on the emulator.
//
//   POST /3/device/<token>                     APNs (HTTP/2 cleartext or HTTP/1.1): apns-topic, apns-collapse-id,
//                                               apns-push-type, apns-priority headers; the body is the payload
//   POST /v1/projects/<project>/messages:send  FCM HTTP v1: {message: {token, notification, data, android, apns}}
//   POST /fcm/send                             FCM legacy: {to | registration_ids, notification, data, …}
//   POST /push                                 pitbox: {token?, device?, app?, apns? | fcm? | title, body, data…}
//   GET  /health                               200 while it runs
//
// Every answer carries `x-pitbox-verdict`: what the device showed.

import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import {assertPortFree} from '../util/net.ts';
import {PushUnregistered, type PushCenter, type PushOptions, type PushResult} from './push.ts';

export type GatewayRequest = {method: string; path: string; headers: Record<string, string | undefined>; body: string};
export type GatewayAnswer = {status: number; headers?: Record<string, string>; body?: unknown};

type Center = Pick<PushCenter, 'send' | 'route' | 'bind'>;

const json = (body: string): Record<string, unknown> => {
  if (!body.trim()) return {};
  const v = JSON.parse(body) as unknown;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('the body is not a JSON object');
  return v as Record<string, unknown>;
};

// Header values are Latin-1: the verdict's typography goes plain.
const plain = (s: string) => s.replace(/[^\x20-\x7e]/g, c => ({'—': '-', '·': '|', '…': '...', '×': 'x'})[c] ?? '?').slice(0, 500);
const verdictHeader = (r: PushResult) => ({'x-pitbox-verdict': plain(r.verdict)});

/** APNs and FCM refuse payloads over 4 KB; the gateway does too, so a server sees the same error locally. */
export const MAX_PAYLOAD = 4096;
/** A request body larger than this is not read at all. */
const MAX_BODY = 64 * 1024;

/**
 * Whether a push failed because the device cannot take pushes for the app at all (not installed, no receiver, no
 * FCM client): the only case where the gateway answers as APNs and FCM do for a dead token. Anything else — a push
 * delivered but not shown, notifications not allowed — answers 200, as the real services do: a server deletes a
 * token on BadDeviceToken / UNREGISTERED, and every later push would vanish.
 */
const unregistered = (r: PushResult) => r.reason === 'unregistered';

type Sent = {result: PushResult} | {error: string; unregistered: boolean};

const deliver = async (center: Center, opts: PushOptions, source: string, token?: string): Promise<Sent> => {
  try {
    return {result: await center.send(opts, source, token)};
  } catch (e) {
    return {error: (e as Error).message, unregistered: e instanceof PushUnregistered};
  }
};

/** Answers one request; separate from the sockets so a test can call it directly. */
export const handlePush = async (center: Center, req: GatewayRequest, apps: {android?: string; apple?: string}): Promise<GatewayAnswer> => {
  const {method, path} = req;
  if (method === 'GET' && (path === '/health' || path === '/')) return {status: 200, body: {ok: true}};
  if (method !== 'POST') return {status: 405, body: {reason: 'MethodNotAllowed'}};

  const apns = /^\/3\/device\/([^/?]+)/.exec(path);
  if (apns) {
    const token = decodeURIComponent(apns[1]!);
    const topic = req.headers['apns-topic'];
    if (topic?.endsWith('.voip') || req.headers['apns-push-type'] === 'voip') {
      return {status: 400, body: {reason: 'BadTopic', pitbox: 'VoIP (PushKit) pushes cannot be delivered to a simulator'}};
    }
    if (Buffer.byteLength(req.body) > MAX_PAYLOAD) return {status: 413, body: {reason: 'PayloadTooLarge'}};
    let payload: Record<string, unknown>;
    try {
      payload = json(req.body);
    } catch {
      return {status: 400, body: {reason: 'PayloadEmpty'}};
    }
    const routed = await center.route('apns', token);
    if (!routed.device) return {status: 503, body: {reason: 'ServiceUnavailable', pitbox: 'no simulator of this session booted (devices held by other sessions or nobody are not delivered to)'}};
    const s = await deliver(center, {device: routed.device, app: topic ?? apps.apple, apns: payload, apnsHeaders: apnsHeaders(req.headers), wait: 2000, fromGateway: true, routeNote: routed.note}, 'gateway apns', token);
    if ('error' in s) return s.unregistered ? {status: 400, body: {reason: 'BadDeviceToken', pitbox: s.error}} : {status: 500, body: {reason: 'InternalServerError', pitbox: s.error}};
    const r = s.result;
    // APNs answers 200 with an apns-id and no body.
    if (unregistered(r)) return {status: 400, headers: verdictHeader(r), body: {reason: 'BadDeviceToken', pitbox: r.verdict}};
    return {status: 200, headers: {'apns-id': r.id, ...verdictHeader(r)}};
  }

  const v1 = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(path);
  const legacy = path === '/fcm/send';
  if (v1 || legacy) {
    let body: Record<string, unknown>;
    try {
      body = json(req.body);
    } catch (e) {
      return {status: 400, body: {error: {code: 400, message: (e as Error).message, status: 'INVALID_ARGUMENT'}}};
    }
    const message = (v1 ? body.message : body) as Record<string, unknown> | undefined;
    if (!message || typeof message !== 'object') return {status: 400, body: {error: {code: 400, message: 'no message', status: 'INVALID_ARGUMENT'}}};
    const {token: _t, to: _to, registration_ids: _r, ...content} = message;
    if (Buffer.byteLength(JSON.stringify(content)) > MAX_PAYLOAD) return {status: 400, body: {error: {code: 400, message: 'Request contains an invalid argument: the message is too big (4 KB at most)', status: 'INVALID_ARGUMENT'}}};
    const tokens = legacy ? (Array.isArray(message.registration_ids) ? (message.registration_ids as string[]) : [String(message.to ?? '')]) : [String(message.token ?? '')];
    const sent: Sent[] = [];
    for (const token of tokens) {
      const routed = await center.route('fcm', token || undefined);
      if (!routed.device) return {status: 503, body: {error: {code: 503, message: 'pitbox: no emulator or simulator of this session online', status: 'UNAVAILABLE'}}};
      sent.push(await deliver(center, {device: routed.device, app: undefined, fcm: message, wait: 2000, fromGateway: true, routeNote: routed.note}, v1 ? 'gateway fcm' : 'gateway fcm legacy', token || undefined));
    }
    const dead = (s: Sent) => ('error' in s ? s.unregistered : unregistered(s.result));
    const failed = (s: Sent) => 'error' in s && !s.unregistered;
    if (legacy) {
      const results = sent.map(s => (dead(s) ? {error: 'NotRegistered'} : failed(s) ? {error: 'Unavailable'} : {message_id: (s as {result: PushResult}).result.id}));
      const last = sent[sent.length - 1]!;
      return {status: 200, headers: 'result' in last ? verdictHeader(last.result) : undefined, body: {multicast_id: Date.now(), success: results.filter(r => 'message_id' in r).length, failure: results.filter(r => 'error' in r).length, results}};
    }
    const s = sent[0]!;
    const verdict = 'error' in s ? s.error : s.result.verdict;
    if (dead(s)) return {status: 404, headers: {'x-pitbox-verdict': plain(verdict)}, body: {error: {code: 404, message: verdict, status: 'NOT_FOUND', details: [{'@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED'}]}}};
    if ('error' in s) return {status: 500, body: {error: {code: 500, message: s.error, status: 'INTERNAL'}}};
    return {status: 200, headers: verdictHeader(s.result), body: {name: `projects/${v1![1]}/messages/${s.result.id}`}};
  }

  if (path === '/push') {
    let body: Record<string, unknown>;
    try {
      body = json(req.body);
    } catch (e) {
      return {status: 400, body: {ok: false, verdict: (e as Error).message}};
    }
    const token = typeof body.token === 'string' ? body.token : undefined;
    const kind = body.apns || body.platform === 'ios' || body.platform === 'apple' ? 'apns' : 'fcm';
    const given = typeof body.device === 'string' ? body.device : undefined;
    const routed = given ? {device: given} : await center.route(kind, token);
    if (!routed.device) return {status: 503, body: {ok: false, verdict: 'no emulator or simulator of this session online'}};
    const {token: _t, platform: _p, headers, device: _d, ...rest} = body;
    const opts = {...rest, device: routed.device, fromGateway: true, routeNote: 'note' in routed ? routed.note : undefined} as PushOptions;
    if (headers && typeof headers === 'object') opts.apnsHeaders = apnsHeaders(headers as Record<string, unknown>);
    const s = await deliver(center, opts, 'gateway', token);
    if ('error' in s) return {status: s.unregistered ? 404 : 400, body: {ok: false, verdict: s.error}};
    // A token sent with its device binds the two, so later requests with only the token find it.
    if (token && given) center.bind(token, s.result.device);
    return {status: unregistered(s.result) ? 404 : 200, headers: verdictHeader(s.result), body: s.result};
  }
  return {status: 404, body: {reason: 'NotFound'}};
};

/** The APNs headers that shape a push (collapse id, priority, push type). */
const apnsHeaders = (headers: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([k, v]) => k.startsWith('apns-') && typeof v === 'string')) as Record<string, string>;

/** The body, or undefined when it is larger than MAX_BODY (the rest is not read). */
const readBody = async (stream: AsyncIterable<unknown>): Promise<string | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream) {
    const b = Buffer.from(c as Buffer);
    size += b.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const lower = (h: Record<string, unknown>) => Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith(':')).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : v === undefined ? undefined : String(v)]));

export class PushGateway {
  readonly port: number;
  readonly host: string;
  requests = 0;
  #server?: net.Server;
  #h1?: http.Server;
  readonly #sockets = new Set<net.Socket>();
  readonly #sessions = new Set<http2.ServerHttp2Session>();
  readonly #center: Center;
  readonly #apps: () => {android?: string; apple?: string};

  constructor(center: Center, port: number, apps: () => {android?: string; apple?: string}, host = '127.0.0.1') {
    this.#center = center;
    this.port = port;
    this.host = host;
    this.#apps = apps;
  }

  get running() {
    return this.#server?.listening ?? false;
  }

  async #answer(req: GatewayRequest, h2: boolean): Promise<GatewayAnswer> {
    this.requests++;
    // Only a server on this machine sends here, never a web page: a browser's request carries an Origin, and a
    // page's cross-site POST over HTTP/1.1 cannot set a JSON content type without a preflight nobody answers.
    // (Browsers do not speak cleartext HTTP/2, which APNs clients use, often with no content type at all.)
    if (req.headers.origin !== undefined) return {status: 403, body: {reason: 'Forbidden', pitbox: 'requests from a browser are refused'}};
    if (req.method === 'POST' && !h2 && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return {status: 415, body: {reason: 'UnsupportedMediaType', pitbox: 'send content-type: application/json'}};
    }
    try {
      return await handlePush(this.#center, req, this.#apps());
    } catch (e) {
      return {status: 500, body: {reason: 'InternalServerError', pitbox: (e as Error).message}};
    }
  }

  /**
   * One port for both protocols: APNs clients speak HTTP/2 (cleartext here, with prior knowledge), FCM clients
   * HTTP/1.1. The first bytes of a connection tell them apart.
   */
  async start() {
    if (this.running) return;
    const send = (a: GatewayAnswer) => ({head: {...(a.body === undefined ? {} : {'content-type': 'application/json'}), ...a.headers}, body: a.body === undefined ? undefined : JSON.stringify(a.body)});
    const h1 = http.createServer((req, res) => {
      void (async () => {
        const body = await readBody(req);
        const a = body === undefined ? {status: 413, body: {reason: 'PayloadTooLarge'}} : await this.#answer({method: req.method ?? 'GET', path: req.url ?? '/', headers: lower(req.headers), body}, false);
        const out = send(a);
        res.writeHead(a.status, out.head);
        res.end(out.body);
      })().catch(() => res.destroy());
    });
    const h2 = http2.createServer();
    h2.on('session', session => {
      this.#sessions.add(session);
      session.on('close', () => this.#sessions.delete(session));
    });
    h2.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
      void (async () => {
        const body = await readBody(stream);
        const a = body === undefined ? {status: 413, body: {reason: 'PayloadTooLarge'}} : await this.#answer({method: String(headers[':method'] ?? 'GET'), path: String(headers[':path'] ?? '/'), headers: lower(headers), body}, true);
        const out = send(a);
        stream.respond({':status': a.status, ...out.head});
        stream.end(out.body);
      })().catch(() => stream.close());
    });
    this.#h1 = h1;
    this.#server = net.createServer(socket => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
      socket.once('readable', () => {
        const head = (socket.read(3) ?? socket.read()) as Buffer | null;
        if (head) socket.unshift(head);
        // The HTTP/2 preface starts with `PRI`, which is no HTTP/1 method.
        (head?.toString('latin1').startsWith('PRI') ? h2 : h1).emit('connection', socket);
      });
    });
    const server = this.#server;
    await assertPortFree(this.port).catch(e => {
      this.#server = undefined;
      throw e;
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', e => {
        this.#server = undefined;
        reject(e);
      });
      server.listen(this.port, this.host, () => resolve());
    });
  }

  /**
   * Stops at once: APNs clients keep their HTTP/2 session open for good and HTTP/1.1 clients keep alive, and a
   * server that waited for them would hold `down` and the daemon's exit.
   */
  async stop() {
    const s = this.#server;
    this.#server = undefined;
    if (!s) return;
    const closed = new Promise<void>(resolve => s.close(() => resolve()));
    for (const session of this.#sessions) session.destroy();
    this.#h1?.closeAllConnections();
    for (const socket of this.#sockets) socket.destroy();
    this.#sessions.clear();
    this.#sockets.clear();
    await closed;
  }
}
