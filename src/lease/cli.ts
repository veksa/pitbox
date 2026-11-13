// `pitbox lease …`: device leases from a shell, with no daemon — for scripts and skills that drive a device with
// raw simctl or adb and must not collide with pitbox sessions (or with each other).
//
//   pitbox lease acquire <device> --as "<label>" [--ttl 30m] [--purpose text] [--pid n] [--wait 5m]
//   pitbox lease release <device> --as "<label>" [--force]
//   pitbox lease list            (ends the leases nobody released first: reap.ts)
//
// A shell lease has no process behind it unless --pid names one: it lives for its ttl, and acquiring again renews
// it. Taken inside a project, it counts as that project's daemon's own, so the skill and pitbox share the device —
// and the other way round: a device that project's live daemon holds is shared with the shell, not refused.

import path from 'node:path';
import {findConfig} from '../config/load.ts';
import {acquire, describeHolder, listLeases, parseDuration, processStart, readLease, release, staleReason, type Holder, type Lease, type Platform} from './lease.ts';
import {describeReaped, leaseWarnings, reapLeases, type Reaped, type Running} from './reap.ts';

export type LeaseFlags = Record<string, string | boolean>;

type Resolved = {platform: Platform; id: string; name?: string; instance?: string};

/** `apple:<udid>`, `android:<serial>`, or a udid, serial, simulator name or AVD looked up on this machine. */
export const resolveDevice = async (selector: string): Promise<Resolved> => {
  const m = /^(apple|android):(.+)$/.exec(selector);
  if (m) return {platform: m[1] as Platform, id: m[2]!};
  const errors: string[] = [];
  if (process.platform === 'darwin') {
    try {
      const {AppleDriver, pickSimulator} = await import('../drivers/apple/driver.ts');
      const sim = pickSimulator(await new AppleDriver().simulators(), selector);
      if (sim) return {platform: 'apple', id: sim.udid, name: sim.name};
    } catch (e) {
      errors.push((e as Error).message.split('\n')[0]!);
    }
  }
  try {
    const {AndroidDriver} = await import('../drivers/android/driver.ts');
    const online = (await new AndroidDriver().devices()).filter(d => d.state === 'device');
    const hit = online.find(d => d.serial === selector || d.avd === selector || d.model === selector);
    if (hit) return {platform: 'android', id: hit.serial, name: hit.avd ?? hit.model, instance: hit.instance};
  } catch (e) {
    errors.push((e as Error).message.split('\n')[0]!);
  }
  throw new Error(`no simulator or online Android device matches "${selector}"${errors.length ? ` (${errors.join('; ')})` : ''}\nhint: name it apple:<udid> or android:<serial>`);
};

/** The reaper (reap.ts) with this machine's drivers; a platform whose devices cannot be listed is left alone. */
const reap = async (): Promise<Reaped> => {
  const running: Running[] = [];
  const unread = new Set<Platform>();
  let apple: {shutdown: (udid: string) => Promise<unknown>} | undefined;
  let android: {shutdown: (serial: string) => Promise<unknown>} | undefined;
  if (process.platform === 'darwin') {
    try {
      const {AppleDriver} = await import('../drivers/apple/driver.ts');
      const d = new AppleDriver();
      running.push(...(await d.simulators()).filter(x => x.state !== 'Shutdown').map(x => ({platform: 'apple' as const, id: x.udid, name: x.name})));
      apple = d;
    } catch {
      unread.add('apple');
    }
  } else unread.add('apple');
  try {
    const {AndroidDriver} = await import('../drivers/android/driver.ts');
    const d = new AndroidDriver();
    running.push(...(await d.devices()).map(x => ({platform: 'android' as const, id: x.serial, name: x.avd, instance: x.instance})));
    android = d;
  } catch {
    unread.add('android');
  }
  return reapLeases({running, unread, shutdown: (platform, id) => (platform === 'apple' ? apple!.shutdown(id) : android!.shutdown(id))});
};

/** What `lease list` runs before listing; tests stand in for it (it lists and may shut down this machine's devices). */
export const leaseCli = {reap};

/** The project a shell lease belongs to: the nearest pitbox config's folder, else the working folder. */
const projectRoot = (cwd: string) => {
  const file = findConfig(cwd);
  return file ? path.dirname(file) : cwd;
};

const shellHolder = (flags: LeaseFlags, cwd: string): Holder => {
  const root = projectRoot(cwd);
  const session = typeof flags.as === 'string' ? flags.as : process.env.PITBOX_SESSION?.trim() || undefined;
  const label = session ?? path.basename(root);
  const pid = typeof flags.pid === 'string' ? Number(flags.pid) : undefined;
  if (pid !== undefined && !(Number.isInteger(pid) && pid > 0)) throw new Error(`--pid takes a process id, got "${flags.pid}"`);
  // The label and the project together: two worktrees running the same skill under one label are two holders.
  return {owner: `as:${label}@${root}`, label, root, ...(session ? {session} : {}), ...(pid ? {pid, pidStart: processStart(pid)} : {})};
};

/** A lease of the pitbox daemon of the shell's project, still live: the device is shared with it, never taken over. */
const projectDaemon = (l: Lease, holder: Holder, instance?: string) => !!holder.root && l.owner === `daemon:${holder.root}` && !staleReason(l, Date.now(), instance);

/** Runs a lease subcommand; returns the text to print and whether it failed. */
export const leaseCommand = async (rest: string[], flags: LeaseFlags, cwd = process.cwd()): Promise<{text: string; failed: boolean}> => {
  const [sub, selector] = rest;
  if (sub === 'list' || !sub) {
    // Leases nobody released are ended first, as every daemon does on its beat: this works with no daemon running.
    const reaped = describeReaped(await leaseCli.reap());
    const leases = listLeases();
    const now = Date.now();
    const rows = leases.map(l => `${l.stale ? '✗' : '●'} ${l.platform} ${l.name ? `${l.name}  ` : ''}${l.device}  ${describeHolder(l, now)}${l.booted ? ' · booted by it' : ''}${l.stale ? ` · stale: ${l.stale}` : ''}`);
    const lines = [...reaped, ...(rows.length ? rows : ['no device leases']), ...leaseWarnings(leases, now).map(w => `warning: ${w}`)];
    return {text: lines.join('\n'), failed: false};
  }
  if (!selector) throw new Error('lease acquire|release <device> --as "<label>" · lease list');
  const device = await resolveDevice(selector);
  const holder = shellHolder(flags, cwd);
  const what = device.name ? `${device.name} (${device.id})` : device.id;
  if (sub === 'acquire' || sub === 'renew') {
    const ttlMs = parseDuration(typeof flags.ttl === 'string' ? flags.ttl : '30m');
    const waitMs = typeof flags.wait === 'string' ? parseDuration(flags.wait) : 0;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const same = (l: Lease) => l.owner === holder.owner || projectDaemon(l, holder, device.instance);
      const r = acquire(device.platform, device.id, holder, {name: device.name, instance: device.instance, purpose: typeof flags.purpose === 'string' ? flags.purpose : undefined, ttlMs}, same);
      if (r.ok && r.lease.owner !== holder.owner) {
        return {text: `${what} is held by this project's pitbox daemon ${describeHolder(r.lease)}: shared with it while it holds the device`, failed: false};
      }
      if (r.ok) {
        const until = new Date(r.lease.heartbeat + r.lease.ttlMs).toTimeString().slice(0, 5);
        const took = r.replaced ? `\nnote: took over a stale lease of "${r.replaced.lease.label}" (${r.replaced.why})${r.replaced.adopted ? ': the same session, so pitbox still shuts the device down when this lease ends' : ''}` : '';
        return {text: `${r.renewed ? 'renewed' : 'acquired'} ${what} as "${holder.label}" until ${until}${holder.pid ? ` or until pid ${holder.pid} ends` : ''}; acquire again to renew${took}`, failed: false};
      }
      if (Date.now() >= deadline) return {text: `${what} is held by ${describeHolder(r.lease)}\nhint: use another device (pitbox boot gives a session its own), or --wait 5m`, failed: true};
      await new Promise(res => setTimeout(res, 2000));
    }
  }
  if (sub === 'release') {
    // The project's daemon keeps a device it shared: a script that releases at the end does not take it from pitbox.
    const daemons = readLease(device.platform, device.id);
    if (daemons && !flags.force && projectDaemon(daemons, holder, device.instance)) return {text: `${what} stays with this project's pitbox daemon ${describeHolder(daemons)}`, failed: false};
    try {
      const mine = (l: Lease) => l.owner === holder.owner || (!!l.root && l.root === holder.root && !l.owner.startsWith('daemon:'));
      const r = release(device.platform, device.id, mine, {force: !!flags.force, instance: device.instance});
      if (!r.released) return {text: `${what} had no lease`, failed: false};
      const theirs = r.lease && r.lease.owner !== holder.owner ? ` (it was ${describeHolder(r.lease)})` : '';
      return {text: `released ${what}${theirs}`, failed: false};
    } catch (e) {
      return {text: `${(e as Error).message}\nhint: --force releases it anyway`, failed: true};
    }
  }
  throw new Error(`lease ${sub}: expected acquire, release or list`);
};
