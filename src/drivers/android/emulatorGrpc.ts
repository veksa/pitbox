// The emulator's own control channel (gRPC on a local port, JWT-free bearer token from its discovery file), for
// what adb cannot reach: an XR headset's surroundings, passthrough, head pose and hand input. Spoken with Node's
// http2 and a few hand-encoded protobuf messages from emulator_controller.proto — no gRPC dependency.

import fs from 'node:fs';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import {AndroidError} from './driver.ts';

const SERVICE = 'android.emulation.control.EmulatorController';

/** Where running emulators describe themselves (`pid_<n>.ini`). */
const discoveryDirs = () => {
  const dirs: string[] = [];
  if (process.platform === 'win32') dirs.push(path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Temp', 'avd', 'running'));
  else if (process.platform === 'darwin') dirs.push(path.join(os.homedir(), 'Library', 'Caches', 'TemporaryItems', 'avd', 'running'));
  else dirs.push(path.join(process.env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `android-${os.userInfo().username}`), 'avd', 'running'));
  return dirs;
};

export type EmulatorEndpoint = {port: number; token?: string; avd: string};

/** The gRPC endpoint of the emulator with console port `consolePort` (5554 for emulator-5554). */
export const findEndpoint = (consolePort: number): EmulatorEndpoint | undefined => {
  for (const dir of discoveryDirs()) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter(f => /^pid_\d+\.ini$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const ini = fs.readFileSync(path.join(dir, f), 'utf8');
      const get = (k: string) => new RegExp(`^${k.replace('.', '\\.')}=(.*)$`, 'm').exec(ini)?.[1]?.trim();
      if (Number(get('port.serial')) !== consolePort) continue;
      const port = Number(get('grpc.port'));
      if (port) return {port, token: get('grpc.token'), avd: get('avd.name') ?? ''};
    }
  }
  return undefined;
};

// ---- protobuf, just what these messages need ----------------------------------------------------------------

const varint = (n: number) => {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
};
const fieldVarint = (field: number, n: number) => (n === 0 ? Buffer.alloc(0) : Buffer.concat([varint(field << 3), varint(n)]));
const fieldFloat = (field: number, f: number) => {
  if (f === 0) return Buffer.alloc(0);
  const b = Buffer.alloc(4);
  b.writeFloatLE(f);
  return Buffer.concat([varint((field << 3) | 5), b]);
};
const fieldMessage = (field: number, body: Buffer) => Buffer.concat([varint((field << 3) | 2), varint(body.length), body]);

export const encode = {
  xrOptions: (o: XrOptions) => Buffer.concat([fieldVarint(1, o.environment), fieldFloat(2, o.passthrough), fieldFloat(4, o.dimming)]),
  mouse: (x: number, y: number, buttons: number) => Buffer.concat([fieldVarint(1, x), fieldVarint(2, y), fieldVarint(3, buttons)]),
  vec3: (x: number, y: number, z: number) => Buffer.concat([fieldFloat(1, x), fieldFloat(2, y), fieldFloat(3, z)]),
  /** InputEvent with one of its fields: 7 hand, 8 eye, 9 command, 10 head rotation, 11 head movement, 12 head angular velocity, 13 head velocity. */
  input: (field: number, body: Buffer) => fieldMessage(field, body),
};

/** An XR emulator's surroundings: environment 0 a living room by day, 1 by night; passthrough and dimming 0…1. */
export type XrOptions = {environment: number; passthrough: number; dimming: number};

/** Reads an XrOptions message: field 1 a varint, fields 2 and 4 floats; absent fields are 0. */
export const decodeXrOptions = (b: Buffer): XrOptions => {
  const o: XrOptions = {environment: 0, passthrough: 0, dimming: 0};
  let i = 0;
  const readVarint = () => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const byte = b[i++]!;
      v |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return v >>> 0;
      shift += 7;
    }
  };
  while (i < b.length) {
    const key = readVarint();
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      const v = readVarint();
      if (field === 1) o.environment = v;
    } else if (wire === 5) {
      const f = b.readFloatLE(i);
      i += 4;
      if (field === 2) o.passthrough = f;
      if (field === 4) o.dimming = f;
    } else if (wire === 1) i += 8;
    else if (wire === 2) i += readVarint();
    else break;
  }
  return o;
};

const frame = (msg: Buffer) => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(msg.length, 1);
  return Buffer.concat([head, msg]);
};

/** One call: a unary request, or a client stream of `messages` (each already encoded). */
export const call = (ep: EmulatorEndpoint, method: string, messages: Buffer[], timeoutMs = 10_000): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const client = http2.connect(`http://127.0.0.1:${ep.port}`);
    const fail = (e: Error) => {
      client.close();
      reject(new AndroidError(`emulator control: ${method} failed: ${e.message}`, 'the emulator must have been started with its gRPC endpoint (the default for recent emulators)'));
    };
    client.on('error', fail);
    const req = client.request({
      ':method': 'POST',
      ':path': `/${SERVICE}/${method}`,
      'content-type': 'application/grpc',
      te: 'trailers',
      ...(ep.token ? {authorization: `Bearer ${ep.token}`} : {}),
    });
    const timer = setTimeout(() => {
      req.close();
      fail(new Error('timed out'));
    }, timeoutMs);
    const chunks: Buffer[] = [];
    let status: string | undefined;
    let message: string | undefined;
    req.on('response', h => {
      if (h['grpc-status'] !== undefined) status = String(h['grpc-status']);
    });
    req.on('trailers', h => {
      status = String(h['grpc-status'] ?? status ?? '0');
      message = h['grpc-message'] ? decodeURIComponent(String(h['grpc-message'])) : undefined;
    });
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      clearTimeout(timer);
      client.close();
      if (status && status !== '0') return reject(new AndroidError(`emulator control: ${method}: ${message ?? `status ${status}`}`));
      const body = Buffer.concat(chunks);
      resolve(body.length >= 5 ? body.subarray(5) : body);
    });
    req.on('error', e => {
      clearTimeout(timer);
      fail(e);
    });
    for (const m of messages) req.write(frame(m));
    req.end();
  });
