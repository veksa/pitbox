import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {crashFiles, devicectlJson, deviceHint, devicePid, isPhysical, muxDeviceId, muxPacket, parseDeviceApps, parseProcessLive, PhysicalDevices, parsePhysicalDevices, physicalUdid, pickTeam, signingIdentities} from './drivers/apple/physical.ts';
import {runnerBundleId, signingArgs} from './drivers/apple/runner.ts';
import {formatLog, parseSyslog} from './drivers/apple/syslog.ts';
import {builtinRules, displayLeftovers} from './doctor/rules.ts';
import type {DoctorContext} from './doctor/types.ts';

const UDID = '00008150-0000000000000000';

/** A self-signed stand-in for an Apple Development certificate (CN and OU as Apple writes them), valid until 2126. */
const PEM = `-----BEGIN CERTIFICATE-----
MIICuzCCAiSgAwIBAgIUbRdKLII+w1HtImeJNCHDwmlJbCgwDQYJKoZIhvcNAQEL
BQAwfzETMBEGCgmSJomT8ixkAQEMA1hZWjEyMDAGA1UEAwwpQXBwbGUgRGV2ZWxv
cG1lbnQ6IFRlc3QgVXNlciAoQUJDREUxMjM0NSkxEzARBgNVBAsMClRFQU0xMjM0
NTYxEjAQBgNVBAoMCVRlc3QgVXNlcjELMAkGA1UEBhMCVVMwIBcNMjYxMTI0MDgy
MTI0WhgPMjEyNjEwMzEwODIxMjRaMH8xEzARBgoJkiaJk/IsZAEBDANYWVoxMjAw
BgNVBAMMKUFwcGxlIERldmVsb3BtZW50OiBUZXN0IFVzZXIgKEFCQ0RFMTIzNDUp
MRMwEQYDVQQLDApURUFNMTIzNDU2MRIwEAYDVQQKDAlUZXN0IFVzZXIxCzAJBgNV
BAYTAlVTMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCjW/Sbi+T5v4f09NzL
qI3dSSzjuUCXv4C5Ur0Akq0FG4bCIc+zkCatsh3MP89WshYnrUD560F8fi+tvNM4
vrBZKmTyaAWc1TQjl1kOZk3eg1tCuKE+9EI8dgov5DTGtzmMYwRLt/x2ApfMqHXB
JKEuRFK8RiNUIt7SW+baKuswWQIDAQABozIwMDAdBgNVHQ4EFgQUQGVT8p2s0taY
//8thzB4nNQx9uQwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOBgQA7
c/IuBO2yEdddnM47WGBSl2detVmyLICKWIzqHSEzTOap/jlcP9YNx8BeiVTphwkZ
ueqeChllWH//FX7Pe8EoTxzCSYNcg3quSYABXN/pG3Au1NeOuTGdGtIy4NiSGOVm
Cg/K/nvy/BXsvOqmL+UAd+540JRShh57RpgFVNII4w==
-----END CERTIFICATE-----`;
const SHA1 = 'F9B536892FBFD5E48B749BF2B99B3B317B2DC2FD';

const device = (over: Record<string, unknown> = {}) => ({
  identifier: 'AAAAAAAA-0000-0000-0000-000000000000',
  visibilityClass: 'default',
  hardwareProperties: {udid: UDID, reality: 'physical', platform: 'iOS', deviceType: 'iPhone', marketingName: 'iPhone 18 Pro'},
  deviceProperties: {name: 'My iPhone', osVersionNumber: '27.2', bootState: 'booted', developerModeStatus: 'enabled'},
  connectionProperties: {pairingState: 'paired', tunnelState: 'connected', transportType: 'wired'},
  ...over,
});

describe('physical apple devices', () => {
  it('lists paired physical devices as booted when connected and disconnected otherwise', () => {
    const away = device({hardwareProperties: {...device().hardwareProperties, udid: '00008150-0000000000000001', deviceType: 'iPad'}, connectionProperties: {pairingState: 'paired', tunnelState: 'unavailable'}});
    const sim = device({hardwareProperties: {...device().hardwareProperties, reality: 'virtual'}});
    const unpaired = device({connectionProperties: {pairingState: 'unpaired', transportType: 'wired'}});
    const list = parsePhysicalDevices({result: {devices: [device(), away, sim, unpaired]}});
    expect(list).toEqual([
      expect.objectContaining({udid: UDID, name: 'My iPhone', state: 'Booted', runtime: 'device', os: 'iOS 27.2', kind: 'phone', deviceType: 'iPhone 18 Pro'}),
      expect.objectContaining({udid: '00008150-0000000000000001', state: 'Disconnected', kind: 'tablet'}),
    ]);
    expect(parsePhysicalDevices({devices: [device()]})).toEqual([list[0]]);
    expect(isPhysical(list[0])).toBe(true);
    expect(isPhysical({runtime: 'iOS 27.2'})).toBe(false);
    expect(parsePhysicalDevices({result: {devices: [device({deviceProperties: {name: 'My iPhone', developerModeStatus: 'disabled'}})]}})[0]).toMatchObject({note: 'Developer Mode is off'});
  });

  it('tells a device udid from a simulator udid', () => {
    expect(physicalUdid(UDID)).toBe(true);
    expect(physicalUdid('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(physicalUdid('6F1C2A4E-1B2C-4D5E-8F90-0123456789AB')).toBe(false);
  });

  it('says what the person at the device does about a known failure', () => {
    expect(deviceHint('The application could not be verified. ... has not been explicitly trusted by the user')).toMatch(/VPN & Device Management/);
    expect(deviceHint('Unlock My iPhone to Continue')).toMatch(/Auto-Lock/);
    expect(deviceHint('Developer Mode disabled')).toMatch(/Developer Mode on/);
    expect(deviceHint('error: No Account for Team "ABCDE12345"')).toMatch(/Personal Team/);
    expect(deviceHint('The maximum number of apps for free development profiles has been reached.')).toMatch(/at most 3 apps/);
    expect(deviceHint('something else')).toBeUndefined();
  });

  it('finds an app and its main process, not its extensions', () => {
    const apps = parseDeviceApps({apps: [{bundleIdentifier: 'com.example.app', name: 'MyApp', url: 'file:///private/var/containers/Bundle/Application/X/MyApp.app/', builtByDeveloper: true}]});
    expect(apps).toEqual([{bundleId: 'com.example.app', name: 'MyApp', url: 'file:///private/var/containers/Bundle/Application/X/MyApp.app/', developer: true}]);
    const procs = {
      runningProcesses: [
        {executable: 'file:///private/var/containers/Bundle/Application/X/MyApp.app/PlugIns/Widgets.appex/Widgets', processIdentifier: 11},
        {executable: 'file:///private/var/containers/Bundle/Application/X/MyApp.app/MyApp', processIdentifier: 12},
      ],
    };
    expect(devicePid(procs, apps[0]!.url!)).toBe(12);
    expect(devicePid(procs, 'file:///private/var/containers/Bundle/Application/Y/Other.app/')).toBeUndefined();
  });

  it('reads the signing teams from the keychain\'s identities and picks one', () => {
    const ids = signingIdentities(PEM, `  1) ${SHA1} "Apple Development: Test User (ABCDE12345)"\n     1 valid identities found`, Date.parse('2027-01-01'));
    expect(ids).toEqual([expect.objectContaining({team: 'TEAM123456', name: 'Apple Development: Test User (ABCDE12345)', sha1: SHA1})]);
    // Without its private key here (not among the valid identities), a certificate signs nothing.
    expect(signingIdentities(PEM, '     0 valid identities found')).toEqual([]);
    expect(pickTeam(ids)).toBe('TEAM123456');
    expect(pickTeam(ids, 'TEAM123456')).toBe('TEAM123456');
    expect(() => pickTeam(ids, 'OTHER12345')).toThrow(/no Apple Development certificate of team OTHER12345/);
    expect(() => pickTeam([])).toThrow(/no Apple Development certificate/);
    expect(() => pickTeam([...ids, {...ids[0]!, team: 'OTHER12345'}])).toThrow(/several teams/);
  });

  it('signs the runner for a device with the team and makes its ids the team\'s own', () => {
    expect(signingArgs()).toEqual(['CODE_SIGN_IDENTITY=-']);
    expect(signingArgs({team: 'TEAM123456', udid: UDID})).toEqual(expect.arrayContaining(['-destination', `id=${UDID}`, '-allowProvisioningUpdates', 'DEVELOPMENT_TEAM=TEAM123456', 'PITBOX_ID_SUFFIX=.tTEAM123456']));
    expect(runnerBundleId()).toBe('dev.pitbox.runner.xctrunner');
    expect(runnerBundleId('TEAM123456')).toBe('dev.pitbox.runner.tTEAM123456.xctrunner');
  });

  it('finds the usbmuxd device ids of a udid and tells the network from the cable', () => {
    const entry = (id: number, serial: string, type: string) =>
      `<dict><key>DeviceID</key><integer>${id}</integer><key>MessageType</key><string>Attached</string><key>Properties</key><dict><key>ConnectionType</key><string>${type}</string><key>DeviceID</key><integer>${id}</integer><key>SerialNumber</key><string>${serial}</string></dict></dict>`;
    const plist = `<plist><dict><key>DeviceList</key><array>${entry(3, UDID.replace('-', ''), 'Network')}${entry(5, UDID, 'USB')}${entry(7, '00008150-0000000000000009', 'USB')}</array></dict></plist>`;
    expect(muxDeviceId(plist, UDID)).toEqual([
      {id: 3, network: true},
      {id: 5, network: false},
    ]);
    const p = muxPacket({MessageType: 'Connect', DeviceID: 5, PortNumber: 0x5c1f}, 2);
    expect(p.readUInt32LE(0)).toBe(p.length);
    expect([p.readUInt32LE(4), p.readUInt32LE(8), p.readUInt32LE(12)]).toEqual([1, 8, 2]);
    expect(p.subarray(16).toString()).toContain('<key>DeviceID</key><integer>5</integer>');
  });

  it('picks the app\'s recent crash reports among the device\'s', () => {
    const now = new Date(2026, 0, 2, 10, 5, 0).getTime();
    const names = ['MyApp-2026-01-02-100000.ips', 'MyApp-2026-01-01-100000.ips', 'Other-2026-01-02-100100.ips', 'Retired/MyApp-2026-01-02-100200.ips', 'MyApp.diskwrites_resource-2026-01-02-100300.ips', 'ota_patch.txt'];
    expect(crashFiles(names, 'MyApp', now, 10 * 60_000)).toEqual(['MyApp-2026-01-02-100000.ips']);
    expect(crashFiles(names, undefined, now, 10 * 60_000)).toEqual(['MyApp-2026-01-02-100000.ips', 'Other-2026-01-02-100100.ips', 'MyApp.diskwrites_resource-2026-01-02-100300.ips']);
  });

  it('doctor names what keeps a connected device from running tests', async () => {
    const rule = builtinRules.find(r => r.id === 'physical-apple')!;
    const ctx = (r: Awaited<ReturnType<NonNullable<DoctorContext['physicalApple']>>>) => ({physicalApple: async () => r}) as unknown as DoctorContext;
    const phone = {udid: UDID, name: 'My iPhone', connected: true};
    expect(await rule.check(ctx({devices: [{...phone, lock: 'unlocked'}], teams: ['TEAM123456']}))).toEqual([]);
    // Nothing connected: nothing to say, even without a certificate.
    expect(await rule.check(ctx({devices: [{...phone, connected: false}], teams: []}))).toEqual([]);
    const found = await rule.check(ctx({devices: [{...phone, lock: 'locked', note: 'Developer Mode is off'}], teams: []}));
    expect(found.map(f => [f.severity, f.message])).toEqual([
      ['error', 'My iPhone: Developer Mode is off'],
      ['warn', 'My iPhone: locked — no app or runner starts on it'],
      ['error', 'no Apple Development certificate on this Mac: the runner cannot be signed for a device'],
    ]);
    expect((await rule.check(ctx({devices: [phone], teams: ['TEAM123456', 'OTHER12345']})))[0]?.message).toMatch(/several teams/);
    expect((await rule.check(ctx({devices: [phone], teams: ['TEAM123456'], team: 'OTHER12345'})))[0]?.message).toMatch(/apple.team OTHER12345/);
  });

  it('reads the device log relay\'s records and filters them as log show does', () => {
    const now = new Date(2026, 10, 24, 10, 40, 0).getTime();
    const e = parseSyslog('Nov 24 10:38:12 My-iPhone MyApp(CFNetwork)[123] <Error>: request failed\nsecond line\n', now)!;
    expect(e).toEqual({at: new Date(2026, 10, 24, 10, 38, 12).getTime(), proc: 'MyApp', pid: 123, level: 'Error', text: 'request failed\nsecond line'});
    // A December record read in January is last year's.
    expect(new Date(parseSyslog('Dec 31 23:59:59 dev kernel[0] <Notice>: x', new Date(2027, 0, 1, 0, 0, 5).getTime())!.at).getFullYear()).toBe(2026);
    expect(parseSyslog('garbage')).toBeUndefined();
    const entries = [
      parseSyslog('Nov 24 10:38:10 dev MyApp[123] <Debug>: tick', now)!,
      parseSyslog('Nov 24 10:38:11 dev MyApp[123] <Notice>: started', now)!,
      parseSyslog('Nov 24 10:38:11 dev other[9] <Error>: noise', now)!,
      e,
    ];
    expect(formatLog(entries, {exe: 'MyApp'})).toEqual(['10:38:11 N MyApp[123] started', '10:38:12 E MyApp[123] request failed\nsecond line']);
    expect(formatLog(entries, {level: 'error', lines: 1})).toEqual(['10:38:12 E MyApp[123] request failed\nsecond line']);
    expect(formatLog(entries, {exe: 'MyApp', level: 'debug', grep: 'tick'})).toEqual(['10:38:10 D MyApp[123] tick']);
  });
  it('restores app data only by installing the app again, and says how when it cannot', async () => {
    // iOS keeps UserDefaults cached by the container's path: a restore without a new container is a silent no-op.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      await expect(new PhysicalDevices('xcrun').reinstall(UDID, 'com.example.app')).rejects.toThrow(/does not know where it came from/);
      fs.mkdirSync(path.join(home, 'Library', 'Caches', 'pitbox'), {recursive: true});
      fs.writeFileSync(path.join(home, 'Library', 'Caches', 'pitbox', 'device-installs.json'), JSON.stringify({[`${UDID} com.example.app`]: path.join(home, 'MyApp.app')}));
      await expect(new PhysicalDevices('xcrun').reinstall(UDID, 'com.example.app')).rejects.toThrow(/is gone/);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
  // A shell script stands in for xcrun, which is only on a Mac anyway.
  it.skipIf(process.platform === 'win32')('keeps devicectl\'s own flags before the launched app\'s arguments', async () => {
    // `-AppleLanguages (fr)` after the bundle id reads as devicectl's flags unless it follows `--`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-xcrun-'));
    const fake = path.join(dir, 'xcrun');
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '{"result":{"args":"%s"}}' "$*"\n`, {mode: 0o755});
    try {
      const r = await devicectlJson<{args: string}>(fake, ['device', 'process', 'launch', 'com.example.app', '--', '-AppleLanguages', '(fr)'], 'launch');
      expect(r.args).toBe('devicectl device process launch com.example.app -q -j - -- -AppleLanguages (fr)');
      expect((await devicectlJson<{args: string}>(fake, ['list', 'devices'], 'list')).args).toBe('devicectl list devices -q -j -');
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('reads an app\'s memory and CPU from an Activity Monitor export', () => {
    const col = (m: string) => `<col><mnemonic>${m}</mnemonic></col>`;
    const head = `<schema name="activity-monitor-process-live">${['start', 'process', 'pid', 'cpu-percent', 'memory-physical-footprint'].map(col).join('')}</schema>`;
    // The first sample writes its values with ids; the second refers back to the process and pid and has no CPU yet.
    const rows = [
      '<row><start-time id="1" fmt="00:00.1">1</start-time><process id="2" fmt="MyApp (321)"><pid id="3" fmt="321">321</pid><device-session id="4"/></process><pid ref="3"/><system-cpu-percent id="5" fmt="2.5%">2.5</system-cpu-percent><size-in-bytes id="6" fmt="24 MiB">25165824</size-in-bytes></row>',
      '<row><start-time id="7" fmt="00:00.2">2</start-time><process id="8" fmt="Other (9)"><pid id="9" fmt="9">9</pid></process><pid ref="9"/><sentinel/><size-in-bytes id="10" fmt="1 MiB">1048576</size-in-bytes></row>',
      '<row><start-time id="11" fmt="00:01.1">3</start-time><process ref="2"/><pid ref="3"/><sentinel/><size-in-bytes id="12" fmt="30 MiB">31457280</size-in-bytes></row>',
    ];
    const xml = `<?xml version="1.0"?><trace-query-result><node>${head}${rows.join('')}</node></trace-query-result>`;
    expect(parseProcessLive(xml, 321)).toEqual({footprint: 31457280});
    expect(parseProcessLive(xml.replace(rows[2]!, ''), 321)).toEqual({footprint: 25165824, cpu: 2.5});
    expect(parseProcessLive(xml, 9)).toEqual({footprint: 1048576});
    expect(parseProcessLive(xml, 77)).toBeUndefined();
  });
});

describe('display leftovers', () => {
  const display = (size: string, density: string, scale = '1.0') =>
    `${scale}\nPhysical size: 1440x3200\n${size ? `Override size: ${size}\n` : ''}Physical density: 560\n${density ? `Override density: ${density}\n` : ''}`;

  it('leaves a phone at its own lower resolution alone', () => {
    expect(displayLeftovers(display('1080x2400', '420'), false)).toEqual([]);
  });

  it('reports the same override on an emulator, where no user chose it', () => {
    expect(displayLeftovers(display('1080x2400', '420'), true)).toEqual(['display size overridden', 'density overridden']);
  });

  it('reports a size or density a run set on a phone', () => {
    expect(displayLeftovers(display('1080x1920', '420'), false)).toEqual(['display size overridden', 'density overridden']);
    expect(displayLeftovers(display('', '480'), false)).toEqual(['density overridden']);
    expect(displayLeftovers(display('', '', '1.3'), false)).toEqual(['font scale 1.3']);
  });
});
