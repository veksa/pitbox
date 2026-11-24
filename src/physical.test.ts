import {describe, expect, it} from 'vitest';
import {crashFiles, deviceHint, devicePid, isPhysical, muxDeviceId, muxPacket, parseDeviceApps, parsePhysicalDevices, physicalUdid, pickTeam, signingIdentities} from './drivers/apple/physical.ts';
import {runnerBundleId, signingArgs} from './drivers/apple/runner.ts';
import {formatLog, parseSyslog} from './drivers/apple/syslog.ts';
import {builtinRules} from './doctor/rules.ts';
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
});
