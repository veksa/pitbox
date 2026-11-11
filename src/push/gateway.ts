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
import type {PushCenter, PushOptions, PushResult} from './push.ts';

export type GatewayRequest = {method: string; path: string; headers: Record<string, string | undefined>; body: string};
export type GatewayAnswer = {status: number; headers?: Record<string, string>; body?: unknown};

type Center = Pick<PushCenter, 'send' | 'route'>;

const json = (body: string): Record<string, unknown> => {
  if (!body.trim()) return {};
  const v = JSON.parse(body) as unknown;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('the body is not a JSON object');
  return v as Record<string, unknown>;
};

// Header values are Latin-1: the verdict's typography goes plain.
const verdictHeader = (r: PushResult) => ({'x-pitbox-verdict': r.verdict.replace(/[^\x20-\x7e]/g, c => ({'—': '-', '·': '|', '…': '...', '×': 'x'})[c] ?? '?').slice(0, 500)});

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
    let payload: Record<string, unknown>;
    try {
      payload = json(req.body);
    } catch {
      return {status: 400, body: {reason: 'PayloadEmpty'}};
    }
    const device = await center.route('apns', token);
    if (!device) return {status: 503, body: {reason: 'ServiceUnavailable', pitbox: 'no simulator booted'}};
    const r = await center.send({device, app: topic ?? apps.apple, apns: payload, apnsHeaders: apnsHeaders(req.headers), wait: 2000}, 'gateway apns', token);
    // APNs answers 200 with an apns-id and no body.
    return {status: r.ok ? 200 : 400, headers: {'apns-id': r.id, ...verdictHeader(r)}, body: r.ok ? undefined : {reason: 'BadDeviceToken', pitbox: r.verdict}};
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
    const tokens = legacy ? (Array.isArray(message.registration_ids) ? (message.registration_ids as string[]) : [String(message.to ?? '')]) : [String(message.token ?? '')];
    const results: PushResult[] = [];
    for (const token of tokens) {
      const device = await center.route('fcm', token || undefined);
      if (!device) return {status: 503, body: {error: {code: 503, message: 'pitbox: no emulator or simulator online', status: 'UNAVAILABLE'}}};
      results.push(await center.send({device, app: undefined, fcm: message, wait: 2000}, v1 ? 'gateway fcm' : 'gateway fcm legacy', token || undefined));
    }
    const last = results[results.length - 1]!;
    if (legacy) {
      return {status: 200, headers: verdictHeader(last), body: {multicast_id: Date.now(), success: results.filter(r => r.ok).length, failure: results.filter(r => !r.ok).length, results: results.map(r => (r.ok ? {message_id: r.id} : {error: 'Unavailable', pitbox: r.verdict}))}};
    }
    if (!last.ok) return {status: 404, headers: verdictHeader(last), body: {error: {code: 404, message: last.verdict, status: 'NOT_FOUND', details: [{'@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED'}]}}};
    return {status: 200, headers: verdictHeader(last), body: {name: `projects/${v1![1]}/messages/${last.id}`}};
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
    const device = typeof body.device === 'string' ? body.device : await center.route(kind, token);
    if (!device) return {status: 503, body: {ok: false, verdict: 'no emulator or simulator online'}};
    const {token: _t, platform: _p, headers, ...rest} = body;
    const opts = {...rest, device} as PushOptions;
    if (headers && typeof headers === 'object') opts.apnsHeaders = apnsHeaders(headers as Record<string, unknown>);
    try {
      const r = await center.send(opts, 'gateway', token);
      return {status: 200, headers: verdictHeader(r), body: r};
    } catch (e) {
      return {status: 400, body: {ok: false, verdict: (e as Error).message}};
    }
  }
  return {status: 404, body: {reason: 'NotFound'}};
};

/** The APNs headers that shape a push (collapse id, priority, push type). */
const apnsHeaders = (headers: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([k, v]) => k.startsWith('apns-') && typeof v === 'string')) as Record<string, string>;

const readBody = async (stream: AsyncIterable<unknown>): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

const lower = (h: Record<string, unknown>) => Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith(':')).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : v === undefined ? undefined : String(v)]));

export class PushGateway {
  readonly port: number;
  readonly host: string;
  requests = 0;
  #server?: net.Server;
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

  async #answer(req: GatewayRequest): Promise<GatewayAnswer> {
    this.requests++;
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
    const h1 = http.createServer((req, res) => {
      void (async () => {
        const body = await readBody(req);
        const a = await this.#answer({method: req.method ?? 'GET', path: req.url ?? '/', headers: lower(req.headers), body});
        res.writeHead(a.status, {...(a.body === undefined ? {} : {'content-type': 'application/json'}), ...a.headers});
        res.end(a.body === undefined ? undefined : JSON.stringify(a.body));
      })();
    });
    const h2 = http2.createServer();
    h2.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
      void (async () => {
        const body = await readBody(stream);
        const a = await this.#answer({method: String(headers[':method'] ?? 'GET'), path: String(headers[':path'] ?? '/'), headers: lower(headers), body});
        stream.respond({':status': a.status, ...(a.body === undefined ? {} : {'content-type': 'application/json'}), ...a.headers});
        stream.end(a.body === undefined ? undefined : JSON.stringify(a.body));
      })().catch(() => stream.close());
    });
    this.#server = net.createServer(socket => {
      socket.once('readable', () => {
        const head = (socket.read(3) ?? socket.read()) as Buffer | null;
        if (head) socket.unshift(head);
        // The HTTP/2 preface starts with `PRI`, which is no HTTP/1 method.
        (head?.toString('latin1').startsWith('PRI') ? h2 : h1).emit('connection', socket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(this.port, this.host, () => resolve());
    });
  }

  async stop() {
    const s = this.#server;
    this.#server = undefined;
    if (s) await new Promise<void>(resolve => s.close(() => resolve()));
  }
}
