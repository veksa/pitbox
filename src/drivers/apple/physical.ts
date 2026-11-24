// Physical Apple devices (an iPhone or iPad on a cable or paired over the network): listed and driven through
// devicectl, signed with the Mac's Apple Development certificate, and reached through usbmuxd — the device's own
// loopback, where the runner listens, is not the Mac's.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {run} from '../../util/proc.ts';
import {AppleError, type SimKind, type Simulator} from './driver.ts';
import {DeviceLog, formatLog} from './syslog.ts';

/** The runtime a physical device is listed with: tells it from a simulator everywhere a Simulator is passed. */
export const PHYSICAL_RUNTIME = 'device';

export const isPhysical = (d: {runtime?: string} | undefined): boolean => d?.runtime === PHYSICAL_RUNTIME;

/** A udid of a physical device: `00008150-0016…` (iPhone XS on) or 40 hex digits (older ones); a simulator's is a UUID. */
export const physicalUdid = (udid: string): boolean => /^[0-9A-F]{8}-[0-9A-F]{16}$/i.test(udid) || /^[0-9a-f]{40}$/i.test(udid);

const KINDS: Record<string, SimKind> = {iPhone: 'phone', iPad: 'tablet', appleTV: 'tv', realityDevice: 'xr', appleWatch: 'watch'};

type DevicectlDevice = {
  identifier?: string;
  visibilityClass?: string;
  hardwareProperties?: {udid?: string; reality?: string; platform?: string; deviceType?: string; marketingName?: string; productType?: string};
  deviceProperties?: {name?: string; osVersionNumber?: string; bootState?: string; developerModeStatus?: string; ddiServicesAvailable?: boolean};
  connectionProperties?: {pairingState?: string; tunnelState?: string; transportType?: string};
};

/**
 * `devicectl list devices -j` (the document or its `result`) → the physical devices paired with this Mac, as Simulators (runtime `device`). One
 * that is on and connected (cable or network) is `Booted`; one that is paired but away is `Disconnected`.
 */
export const parsePhysicalDevices = (json: unknown): Simulator[] => {
  // The whole document or its `result` (what devicectlJson answers).
  const doc = json as {result?: {devices?: DevicectlDevice[]}; devices?: DevicectlDevice[]} | undefined;
  const list = (doc?.result?.devices ?? doc?.devices ?? []) as DevicectlDevice[];
  return list
    .filter(d => d.hardwareProperties?.reality === 'physical' && d.hardwareProperties.udid && d.connectionProperties?.pairingState === 'paired' && d.visibilityClass !== 'hidden')
    .map(d => {
      const hw = d.hardwareProperties!;
      const dp = d.deviceProperties ?? {};
      const cp = d.connectionProperties ?? {};
      const online = !!cp.transportType && cp.tunnelState !== 'unavailable' && (dp.bootState ?? 'booted') === 'booted';
      return {
        udid: hw.udid!,
        name: dp.name ?? hw.marketingName ?? hw.udid!,
        state: online ? 'Booted' : 'Disconnected',
        runtime: PHYSICAL_RUNTIME,
        os: `${hw.platform ?? 'iOS'} ${dp.osVersionNumber ?? ''}`.trim(),
        kind: KINDS[hw.deviceType ?? ''] ?? 'phone',
        available: true,
        ...(hw.marketingName ? {deviceType: hw.marketingName} : {}),
        ...(dp.developerModeStatus && dp.developerModeStatus !== 'enabled' ? {note: 'Developer Mode is off'} : {}),
      } as Simulator;
    });
};

/** What devicectl's (or xcodebuild's) failure on a device means, and what the person at the device does about it. */
export const deviceHint = (text: string): string | undefined => {
  if (/not (been )?explicitly trusted|Developer App Certificate is not trusted|untrusted developer|invalid code signature, inadequate entitlements/i.test(text)) {
    return 'trust the developer on the device: Settings › General › VPN & Device Management › the Apple Development certificate › Trust, then Verify App (the device needs the internet for it)';
  }
  if (/Unlock .* to Continue|device is locked|passcode.*(required|locked)|kAMDMobileImageMounterDeviceLocked/i.test(text)) {
    return 'unlock the device and keep it unlocked while it runs tests (Settings › Display & Brightness › Auto-Lock › Never)';
  }
  if (/Developer Mode/i.test(text)) return 'turn Developer Mode on: Settings › Privacy & Security › Developer Mode, then restart the device';
  if (/No Account for Team|requires a development team|No signing certificate|no valid .*signing identit|No profiles for/i.test(text)) {
    return 'sign in to Xcode › Settings › Accounts with an Apple ID and create an Apple Development certificate (Manage Certificates › + ); a free Personal Team is enough';
  }
  if (/Maximum number of apps|maximum number of installed apps|three apps/i.test(text)) {
    return 'a free Personal Team signs at most 3 apps on a device at a time: delete another app built from this Mac, or use a paid team (apple.team)';
  }
  if (/not paired|pairing|Trust This Computer/i.test(text)) return 'unlock the device and answer Trust on "Trust This Computer?", or pair it in Xcode › Window › Devices and Simulators';
  return undefined;
};

/** An AppleError for a failed device command: its last lines, and the hint for what is known. */
export const deviceError = (what: string, text: string): AppleError => {
  const lines = text
    .trim()
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  const reason = lines.find(l => /^(Failure Reason|Recovery Suggestion|ERROR|error):/i.test(l)) ?? lines.filter(l => !/^\s*[A-Za-z]+ = /.test(l)).slice(-1)[0] ?? 'failed';
  return new AppleError(`${what}: ${reason.replace(/^(ERROR|error):\s*/, '').slice(0, 300)}`, deviceHint(text));
};

export type DevicectlResult = {code: number | null; stdout: string; stderr: string; timedOut: boolean};

/** Runs devicectl with its JSON on stdout (`-q -j -`) and answers the JSON's `result`; throws with a hint on failure. */
export const devicectlJson = async <T = Record<string, unknown>>(xcrun: string, args: string[], what: string, timeoutMs = 60_000): Promise<T> => {
  const r = await run(xcrun, ['devicectl', ...args, '-q', '-j', '-'], {timeoutMs});
  let doc: {result?: T; error?: {userInfo?: Record<string, {string?: string}>}} | undefined;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    doc = undefined;
  }
  if (r.code !== 0 || !doc || r.timedOut) {
    if (r.timedOut) throw new AppleError(`${what}: devicectl did not answer in ${Math.round(timeoutMs / 1000)}s`, 'is the device unlocked and on its cable (or on the same network)?');
    const info = Object.values(doc?.error?.userInfo ?? {})
      .map(v => v?.string)
      .filter(Boolean)
      .join('\n');
    throw deviceError(what, `${info}\n${r.stderr}`);
  }
  return doc.result as T;
};

/** `devicectl device info apps` → bundle id and the app's folder on the device. */
export const parseDeviceApps = (result: unknown): {bundleId: string; name?: string; url?: string; developer: boolean}[] =>
  (((result as {apps?: Record<string, unknown>[]})?.apps ?? []) as Record<string, unknown>[]).map(a => ({
    bundleId: String(a.bundleIdentifier),
    ...(a.name ? {name: String(a.name)} : {}),
    ...(a.url ? {url: String(a.url)} : {}),
    developer: a.builtByDeveloper === true,
  }));

/**
 * The pid of an app among `devicectl device info processes`: its main executable inside the app's folder
 * (`…/Bundle/Application/<id>/MyApp.app/MyApp`), not an extension of it (`…/PlugIns/…appex/…`).
 */
export const devicePid = (result: unknown, appUrl: string): number | undefined => {
  const base = appUrl.replace(/\/+$/, '').replace(/^file:\/\/(\/private)?/, '');
  const procs = ((result as {runningProcesses?: {executable?: string; processIdentifier?: number}[]})?.runningProcesses ?? []) as {executable?: string; processIdentifier?: number}[];
  const hit = procs.find(p => {
    const exe = (p.executable ?? '').replace(/^file:\/\/(\/private)?/, '');
    return exe.startsWith(`${base}/`) && !exe.slice(base.length + 1).includes('/');
  });
  return hit?.processIdentifier;
};

/**
 * Of a device's crash report names (`MyApp-2026-01-02-100000.ips`, local time), the top-level ones of the process
 * `exe` (any process when unknown) written within `windowMs` of `now`.
 */
export const crashFiles = (names: string[], exe: string | undefined, now: number, windowMs: number): string[] =>
  names.filter(n => {
    const m = /^([^/]+)-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.ips$/.exec(n);
    if (!m || (exe && m[1] !== exe)) return false;
    const at = new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])).getTime();
    return at >= now - windowMs && at <= now + 60_000;
  });

/** One Apple Development identity on this Mac: its team and when it runs out. */
export type SigningIdentity = {team: string; name: string; expires: number; sha1: string};

/**
 * The Apple Development identities among the Mac's certificates (`security find-certificate -a -p` PEMs) that have
 * their private key here (`security find-identity -v -p codesigning`: the valid ones, by SHA-1), unexpired. The
 * team is the certificate subject's OU.
 */
export const signingIdentities = (pems: string, validIdentities: string, now = Date.now()): SigningIdentity[] => {
  const valid = new Set([...validIdentities.matchAll(/\b([0-9A-F]{40})\b/g)].map(m => m[1]!));
  const out: SigningIdentity[] = [];
  for (const pem of pems.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    let cert: crypto.X509Certificate;
    try {
      cert = new crypto.X509Certificate(pem);
    } catch {
      continue;
    }
    const sha1 = cert.fingerprint.replace(/:/g, '').toUpperCase();
    const subject = Object.fromEntries(cert.subject.split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const expires = Date.parse(cert.validTo);
    if (!valid.has(sha1) || !subject.OU || !/^Apple Development:/.test(subject.CN ?? '') || !(expires > now)) continue;
    out.push({team: subject.OU, name: subject.CN!, expires, sha1});
  }
  return out;
};

/** The team that signs for devices: `apple.team` when set, else the only team with an identity here. */
export const pickTeam = (ids: SigningIdentity[], configured?: string): string => {
  if (configured) {
    if (!ids.some(i => i.team === configured)) throw new AppleError(`no Apple Development certificate of team ${configured} on this Mac`, `create one in Xcode › Settings › Accounts › Manage Certificates (teams here: ${[...new Set(ids.map(i => i.team))].join(', ') || 'none'})`);
    return configured;
  }
  const teams = [...new Set(ids.map(i => i.team))];
  if (teams.length === 1) return teams[0]!;
  if (!teams.length) throw new AppleError('no Apple Development certificate on this Mac: apps for a device cannot be signed', deviceHint('No signing certificate'));
  throw new AppleError(`several teams can sign for devices: ${teams.join(', ')}`, 'name one in the config: apple: {team: "<team id>"}');
};

/** Reads the identities from the login keychain. */
export const readSigningIdentities = async (): Promise<SigningIdentity[]> => {
  const [pems, valid] = await Promise.all([
    run('security', ['find-certificate', '-a', '-c', 'Apple Development', '-p'], {timeoutMs: 20_000}),
    run('security', ['find-identity', '-v', '-p', 'codesigning'], {timeoutMs: 20_000}),
  ]);
  return signingIdentities(pems.stdout, valid.stdout);
};

/**
 * What goes after a bundle id signed by a team: a free Personal Team cannot register an id another team has, so the
 * runner's ids are made the team's own (`dev.pitbox.runner.t<team>`).
 */
export const teamSuffix = (team: string) => `.t${team}`;

/** When the provisioning profile embedded in a built app runs out (epoch ms); undefined when it cannot be read. */
export const profileExpiry = async (app: string): Promise<number | undefined> => {
  const file = path.join(app, 'embedded.mobileprovision');
  if (!fs.existsSync(file)) return undefined;
  const r = await run('security', ['cms', '-D', '-i', file], {timeoutMs: 20_000});
  const m = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(r.stdout);
  return m ? Date.parse(m[1]!) : undefined;
};

// usbmuxd: the Mac's daemon that carries TCP connections to a port on a device, over the cable or the network.

const USBMUXD = process.env.PITBOX_USBMUXD ?? '/var/run/usbmuxd';

const plistOf = (obj: Record<string, string | number>) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${Object.entries(obj)
    .map(([k, v]) => `<key>${k}</key>${typeof v === 'number' ? `<integer>${v}</integer>` : `<string>${v}</string>`}`)
    .join('')}</dict></plist>`;

/** One usbmuxd message: a 16-byte header (length, version 1 = plist, type 8 = plist, tag) and the plist. */
export const muxPacket = (msg: Record<string, string | number>, tag: number): Buffer => {
  const body = Buffer.from(plistOf({ClientVersionString: 'pitbox', ProgName: 'pitbox', ...msg}));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0);
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(8, 8);
  head.writeUInt32LE(tag, 12);
  return Buffer.concat([head, body]);
};

/** usbmuxd's device list → its DeviceID for a udid (the plist carries the udid without dashes on newer devices too). */
export const muxDeviceId = (plist: string, udid: string): {id: number; network: boolean}[] => {
  const want = udid.replace(/-/g, '').toUpperCase();
  // Each attached device's facts are in its Properties dict (flat: no nested dict inside).
  return plist
    .split('<key>Properties</key>')
    .slice(1)
    .map(e => e.slice(0, e.indexOf('</dict>')))
    .filter(e => {
      const serial = /<key>SerialNumber<\/key>\s*<string>([^<]+)<\/string>/.exec(e)?.[1] ?? '';
      return serial.replace(/-/g, '').toUpperCase() === want;
    })
    .map(e => ({id: Number(/<key>DeviceID<\/key>\s*<integer>(\d+)<\/integer>/.exec(e)?.[1]), network: /<key>ConnectionType<\/key>\s*<string>Network<\/string>/.test(e)}))
    .filter(d => Number.isInteger(d.id));
};

const readPacket = (sock: net.Socket, timeoutMs: number) =>
  new Promise<{body: string; rest: Buffer}>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (err?: Error, v?: {body: string; rest: Buffer}) => {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onError);
      sock.off('close', onClose);
      if (err) reject(err);
      else resolve(v!);
    };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 16 && buf.length >= buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0);
        done(undefined, {body: buf.subarray(16, len).toString(), rest: buf.subarray(len)});
      }
    };
    const onError = (e: Error) => done(e);
    const onClose = () => done(new Error('usbmuxd closed the connection'));
    const timer = setTimeout(() => done(new Error('usbmuxd did not answer')), timeoutMs);
    sock.on('data', onData);
    sock.once('error', onError);
    sock.once('close', onClose);
  });

const muxSocket = () =>
  new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(USBMUXD, () => resolve(s));
    s.once('error', reject);
  });

/** One request to usbmuxd itself (`ReadPairRecord`), its answer's plist. */
export const muxRequest = async (msg: Record<string, string | number>, timeoutMs = 5000): Promise<string> => {
  const s = await muxSocket();
  try {
    s.write(muxPacket(msg, 3));
    return (await readPacket(s, timeoutMs)).body;
  } finally {
    s.destroy();
  }
};

/**
 * A TCP connection to `port` on the device's loopback, through usbmuxd. A cable connection is preferred over the
 * network. Rejects with usbmuxd's answer when nothing listens there (yet). Bytes the device sent with the answer are
 * pushed back into the socket, so a reader attached afterwards sees them.
 */
export const muxConnect = async (udid: string, port: number, timeoutMs = 5000): Promise<net.Socket> => {
  const list = await muxSocket();
  let devices: {id: number; network: boolean}[];
  try {
    list.write(muxPacket({MessageType: 'ListDevices'}, 1));
    devices = muxDeviceId((await readPacket(list, timeoutMs)).body, udid);
  } finally {
    list.destroy();
  }
  const device = devices.find(d => !d.network) ?? devices[0];
  if (!device) throw new AppleError(`usbmuxd does not see ${udid}`, 'is the device on its cable (or paired over the network) and unlocked?');
  const s = await muxSocket();
  // usbmuxd takes the port in network byte order.
  s.write(muxPacket({MessageType: 'Connect', DeviceID: device.id, PortNumber: ((port & 0xff) << 8) | (port >> 8)}, 2));
  let answer: {body: string; rest: Buffer};
  try {
    answer = await readPacket(s, timeoutMs);
  } catch (e) {
    s.destroy();
    throw e;
  }
  const code = /<key>Number<\/key>\s*<integer>(\d+)<\/integer>/.exec(answer.body)?.[1];
  if (code !== '0') {
    s.destroy();
    throw new Error(`usbmuxd: port ${port} on the device refused (${code ?? '?'})`);
  }
  if (answer.rest.length) s.unshift(answer.rest);
  return s;
};

/** A scratch file for one devicectl transfer; the caller removes it. */
export const scratchFile = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-device-')), name);

/** Android-style font scale → the text size devicectl takes (the same Dynamic Type categories as a simulator's). */
type Settings = {fontScale?: number; dark?: boolean; animations?: boolean; size?: string; density?: string; locale?: string; grant?: unknown; revoke?: unknown; reset?: unknown};

/**
 * What the Apple driver does on a physical device, through devicectl. Gaps of the device tooling are reported as
 * unsupported with what to do instead, never emulated silently.
 */
/** Where pitbox installed each app on each device from (`<udid> <bundle id>` → path), kept across daemons. */
const sourcesFile = () => path.join(os.homedir(), 'Library', 'Caches', 'pitbox', 'device-installs.json');
const installSources = (): Record<string, string> => {
  try {
    return JSON.parse(fs.readFileSync(sourcesFile(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
};
const rememberSource = (udid: string, bundleId: string, from: string) => {
  const all = {...installSources(), [`${udid} ${bundleId}`]: from};
  fs.mkdirSync(path.dirname(sourcesFile()), {recursive: true});
  fs.writeFileSync(sourcesFile(), JSON.stringify(all, null, 1));
};

export class PhysicalDevices {
  readonly #xcrun: string;
  #kept?: {at: number; list: Promise<Simulator[]>};
  /** The app's folder on the device by `udid bundleId`, for telling its process among the device's. */
  readonly #urls = new Map<string, string>();

  constructor(xcrun: string) {
    this.#xcrun = xcrun;
  }

  #json<T = Record<string, unknown>>(args: string[], what: string, timeoutMs?: number) {
    return devicectlJson<T>(this.#xcrun, args, what, timeoutMs);
  }

  /** The paired physical devices; kept for a moment (one command resolves its device several times). Empty when devicectl cannot answer. */
  list(): Promise<Simulator[]> {
    if (this.#kept && Date.now() - this.#kept.at < 2000) return this.#kept.list;
    const list = this.#json(['list', 'devices'], 'list devices', 30_000).then(parsePhysicalDevices, () => [] as Simulator[]);
    this.#kept = {at: Date.now(), list};
    return list;
  }

  forget() {
    this.#kept = undefined;
  }

  async device(udid: string): Promise<Simulator> {
    const d = (await this.list()).find(x => x.udid.toLowerCase() === udid.toLowerCase());
    if (!d) throw new AppleError(`device ${udid} is not paired with this Mac`, deviceHint('not paired'));
    if (d.state !== 'Booted') throw new AppleError(`${d.name} is not connected`, 'plug it in (or bring it onto the same network) and unlock it');
    return d;
  }

  async install(udid: string, bundle: string): Promise<{ms: number; replaced: boolean; bundleId?: string}> {
    if (/\.app\/?$/.test(bundle) && /-iphonesimulator|-appletvsimulator|-xrsimulator|-watchsimulator/.test(bundle)) {
      throw new AppleError('a simulator build does not run on a device', 'build for the device: Products/Debug-iphoneos/MyApp.app (or an .ipa), signed with your team');
    }
    const t0 = Date.now();
    const r = await this.#json<{installedApplications?: {bundleID?: string; installationURL?: string}[]}>(['device', 'install', 'app', '--device', udid, bundle], 'install', 600_000);
    const app = r.installedApplications?.[0];
    if (app?.bundleID && app.installationURL) this.#urls.set(`${udid} ${app.bundleID}`, app.installationURL);
    if (app?.bundleID) rememberSource(udid, app.bundleID, path.resolve(bundle));
    return {ms: Date.now() - t0, replaced: false, ...(app?.bundleID ? {bundleId: app.bundleID} : {})};
  }

  /**
   * Installs the app again from where pitbox last installed it from, so it gets a new data container. iOS keeps an
   * app's UserDefaults in memory (cfprefsd) by the container's path and does not notice a plist copied over the one
   * it read: only a new container makes the app read what is restored. The app's permissions are asked again.
   */
  async reinstall(udid: string, bundleId: string) {
    const from = installSources()[`${udid} ${bundleId}`];
    if (!from || !fs.existsSync(from)) {
      throw new AppleError(
        `restoring ${bundleId}'s data on a device installs the app again, and pitbox does not know where it came from${from ? ` (${from} is gone)` : ''}`,
        'install it once with `pitbox install <path to MyApp.app or .ipa>`: iOS keeps the app\'s UserDefaults cached until it gets a new container',
      );
    }
    await this.uninstall(udid, bundleId);
    await this.install(udid, from);
  }

  async uninstall(udid: string, bundleId: string) {
    await this.#json(['device', 'uninstall', 'app', '--device', udid, bundleId], 'uninstall', 120_000);
    this.#urls.delete(`${udid} ${bundleId}`);
  }

  async apps(udid: string) {
    return parseDeviceApps(await this.#json(['device', 'info', 'apps', '--device', udid], 'list apps'));
  }

  /** Apps someone installed (built by a developer or from the store), not the system's. */
  async packages(udid: string, filter?: string): Promise<string[]> {
    const apps = await this.apps(udid);
    return apps
      .map(a => a.bundleId)
      .filter(id => !id.startsWith('com.apple.') && (!filter || id.includes(filter)))
      .sort();
  }

  /**
   * Copies the app's crash reports written on the device in the last `windowMs` into `dir`, each once. A device keeps
   * its reports itself (`systemCrashLogs`); they are named after the process (the app's executable) and the time.
   */
  async pullCrashes(udid: string, bundleId: string, dir: string, now = Date.now(), windowMs = 10 * 60_000): Promise<number> {
    const exe = await this.#exe(udid, bundleId);
    const r = await this.#json<{files?: {relativePath?: string}[]}>(['device', 'info', 'files', '--device', udid, '--domain-type', 'systemCrashLogs'], 'list crash reports', 20_000);
    const want = crashFiles((r.files ?? []).map(f => f.relativePath ?? ''), exe, now, windowMs).filter(f => !fs.existsSync(path.join(dir, f)));
    fs.mkdirSync(dir, {recursive: true});
    for (const f of want) {
      await this.#json(['device', 'copy', 'from', '--device', udid, '--domain-type', 'systemCrashLogs', '--source', f, '--destination', path.join(dir, f)], 'copy a crash report', 20_000).catch(() => undefined);
    }
    return want.length;
  }

  async #appUrl(udid: string, bundleId: string): Promise<string | undefined> {
    const key = `${udid} ${bundleId}`;
    const known = this.#urls.get(key);
    if (known) return known;
    const url = (await this.apps(udid)).find(a => a.bundleId === bundleId)?.url;
    if (url) this.#urls.set(key, url);
    return url;
  }

  /** The executable of an app (its process name in the log and in crash reports): the app folder's name. */
  async #exe(udid: string, bundleId: string): Promise<string | undefined> {
    const url = await this.#appUrl(udid, bundleId);
    return url ? path.basename(url.replace(/\/+$/, ''), '.app') : undefined;
  }

  readonly #logs = new Map<string, Promise<DeviceLog>>();

  /** Starts keeping the device's log (once; again after its stream ended). */
  async watchLog(udid: string): Promise<DeviceLog> {
    const running = this.#logs.get(udid);
    const log = running ? await running.catch(() => undefined) : undefined;
    if (log && !log.closed) return log;
    const started = DeviceLog.open(udid);
    this.#logs.set(udid, started);
    started.catch(() => this.#logs.delete(udid));
    return started;
  }

  closeLog(udid: string) {
    const log = this.#logs.get(udid);
    this.#logs.delete(udid);
    void log?.then(l => l.close(), () => undefined);
  }

  /**
   * The device's log as a simulator's `log show` gives it: the app's process (all with no `bundleId`), the last
   * `lines`. The device only streams what is logged from now on: the first call starts the stream and reads a moment
   * of it, and the lines go back to when it started (the app's launch by pitbox, or that first call).
   */
  async logs(udid: string, opts: {bundleId?: string; lines?: number; grep?: string; level?: string} = {}): Promise<string[]> {
    const fresh = !this.#logs.has(udid);
    const log = await this.watchLog(udid);
    if (fresh) await new Promise(r => setTimeout(r, 1500));
    let exe: string | undefined;
    if (opts.bundleId) {
      exe = await this.#exe(udid, opts.bundleId);
      if (!exe) return [`(${opts.bundleId} is not installed)`];
    }
    const lines = formatLog(log.entries, {...opts, exe});
    const t = new Date(log.since);
    const since = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
    if (!lines.length) return [`(no lines${exe ? ` from ${exe}` : ''} since ${since}, when pitbox began reading the device's log)`];
    return fresh ? [`(the device's log as read from ${since}: earlier lines are not kept on the device for pitbox)`, ...lines] : lines;
  }

  /**
   * The app's data container on the device, through devicectl's file service: copied out to `dir` whole, or
   * replaced by `dir`'s contents (an empty folder wipes it; the system makes Documents, Library and tmp again).
   */
  async containerOut(udid: string, bundleId: string, dir: string) {
    fs.rmSync(dir, {recursive: true, force: true});
    fs.mkdirSync(path.dirname(dir), {recursive: true});
    await this.#json(['device', 'copy', 'from', '--device', udid, '--domain-type', 'appDataContainer', '--domain-identifier', bundleId, '--source', '.', '--destination', dir], 'copy the app\'s data', 120_000).catch(e => {
      throw this.#containerError(e as AppleError, bundleId);
    });
  }

  async containerIn(udid: string, bundleId: string, dir: string) {
    await this.#json(['device', 'copy', 'to', '--device', udid, '--domain-type', 'appDataContainer', '--domain-identifier', bundleId, '--source', dir, '--destination', '.', '--remove-existing-content', 'true'], 'replace the app\'s data', 120_000).catch(e => {
      throw this.#containerError(e as AppleError, bundleId);
    });
  }

  #containerError(e: AppleError, bundleId: string) {
    // The file service serves the containers of apps built for development (signed with get-task-allow) only.
    return /not (be )?found|no such|unknown|not installed|doesn.t exist/i.test(e.message)
      ? new AppleError(`no data container for ${bundleId} on the device`, 'is the app installed, and a development build? `apps` lists bundle ids')
      : e;
  }

  /** Wipes what the app wrote, with the app stopped: its next launch is a first one (its permissions stay). */
  async clear(udid: string, bundleId: string) {
    await this.stop(udid, bundleId);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-empty-'));
    try {
      await this.containerIn(udid, bundleId, empty);
    } finally {
      fs.rmSync(empty, {recursive: true, force: true});
    }
  }

  async pid(udid: string, bundleId: string): Promise<number | undefined> {
    const url = await this.#appUrl(udid, bundleId);
    if (!url) return undefined;
    return devicePid(await this.#json(['device', 'info', 'processes', '--device', udid], 'list processes'), url);
  }

  async appRunning(udid: string, bundleId: string): Promise<boolean | undefined> {
    if (!(await this.#appUrl(udid, bundleId))) return undefined;
    return (await this.pid(udid, bundleId)) !== undefined;
  }

  async open(udid: string, target: string, opts: {relaunch?: boolean; bundleId?: string; args?: string[]} = {}): Promise<{totalMs?: number; pid?: number}> {
    const t0 = Date.now();
    // The app's launch is in its log only when the stream is up before it: the log is read live.
    await this.watchLog(udid).catch(() => undefined);
    if (target.includes('://')) {
      if (opts.relaunch && opts.bundleId) await this.stop(udid, opts.bundleId);
      await this.#json(['device', 'process', 'openURL', '--device', udid, target], 'open url', 60_000);
      return {totalMs: Date.now() - t0};
    }
    const r = await this.#json<{process?: {processIdentifier?: number}}>(['device', 'process', 'launch', '--device', udid, ...(opts.relaunch ? ['--terminate-existing'] : []), target, ...(opts.args ?? [])], 'launch', 90_000).catch((e: AppleError) => {
      throw /not (be )?found|no such app|unknown application|is not installed/i.test(e.message) ? new AppleError(e.message.split('\n')[0]!, 'is the app installed on the device? `apps` lists bundle ids') : e;
    });
    return {totalMs: Date.now() - t0, ...(r.process?.processIdentifier ? {pid: r.process.processIdentifier} : {})};
  }

  async stop(udid: string, bundleId: string) {
    const pid = await this.pid(udid, bundleId).catch(() => undefined);
    // Terminating an app that does not run is fine.
    if (pid === undefined) return;
    await this.#json(['device', 'process', 'terminate', '--device', udid, '--pid', String(pid), '--kill'], 'terminate', 30_000).catch(e => {
      if (!/no such process|not running|not found/i.test((e as Error).message)) throw e;
    });
  }

  async screenshot(udid: string, file: string): Promise<{file: string; bytes: number}> {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    await this.#json(['device', 'capture', 'screenshot', '--device', udid, '--destination', file], 'screenshot', 30_000);
    if (!fs.existsSync(file)) throw new AppleError('screenshot failed: devicectl wrote no file');
    return {file, bytes: fs.statSync(file).size};
  }

  async notify(udid: string, name: string) {
    await this.#json(['device', 'notification', 'post', '--device', udid, '--name', name], 'notification post');
  }

  async settings(udid: string, s: Settings, contentSize: (scale: number) => string): Promise<string[]> {
    const done: string[] = [];
    if (s.size || s.density) throw new AppleError('a device has a fixed screen size', 'use another device or a simulator of that size');
    if (s.animations !== undefined) throw new AppleError('devicectl cannot switch animations off', 'leave animations on; the runner waits for them (or turn on Reduce Motion on the device)');
    if (s.locale !== undefined) throw new AppleError("a device's language is not set from the Mac", 'pass the app its language at launch: open with args -AppleLanguages "(fr)" -AppleLocale fr_FR, or change it in Settings › General › Language & Region');
    if (s.grant || s.revoke || s.reset) throw new AppleError("a device's privacy permissions are not set from the Mac", 'answer the system permission dialog in the flow (press "Allow"), or reset it by reinstalling the app');
    const args: string[] = [];
    if (s.fontScale !== undefined) {
      const category = contentSize(s.fontScale);
      args.push('--text-size', category);
      done.push(`content size ${category}`);
    }
    if (s.dark !== undefined) {
      args.push('--mode', s.dark ? 'dark' : 'light');
      done.push(`dark ${s.dark ? 'on' : 'off'}`);
    }
    if (args.length) await this.#json(['device', 'settings', 'appearance', '--device', udid, ...args], 'appearance');
    return done;
  }

  async info(udid: string): Promise<Record<string, string>> {
    const d = await this.device(udid);
    const out: Record<string, string> = {model: d.deviceType ?? d.name, name: d.name, os: d.os, kind: d.kind, state: d.state, physical: 'yes'};
    const look = await this.#json<{userInterfaceStyle?: string; textSize?: string}>(['device', 'info', 'appearance', '--device', udid], 'appearance').catch(() => undefined);
    if (look?.userInterfaceStyle) out.appearance = look.userInterfaceStyle;
    if (look?.textSize) out.contentSize = look.textSize;
    const lock = await this.lockState(udid).catch(() => undefined);
    if (lock) out.lock = lock;
    return out;
  }

  /** `unlocked`, or what stands between the Mac and the device's apps. */
  async lockState(udid: string): Promise<string> {
    const r = await this.#json<{passcodeRequired?: boolean; unlockedSinceBoot?: boolean}>(['device', 'info', 'lockState', '--device', udid], 'lock state', 20_000);
    if (r.unlockedSinceBoot === false) return 'locked since boot: enter the passcode once';
    return r.passcodeRequired ? 'locked' : 'unlocked';
  }
}
