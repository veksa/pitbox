// Stopping a project's daemon from a client: `pitbox daemon stop|restart`, the MCP `stand action=stop`, and the wait
// after a whole-stand `down`, after which the daemon stops itself.
//
// Only the daemons of this project's config are ever touched: the one its daemon file names, and the others of the
// same config nobody can reach (daemon/siblings.ts). Another project's daemon runs on another config and is never seen.

import {resolveProject, runningDaemon, type DaemonClient} from './client.ts';
import {DAEMON_STOP} from './info.ts';
import {isAlive} from '../util/proc.ts';

export type StopResult = {lines: string[]; failed: boolean; stopped: boolean};

/** How long a stop waits for the daemon to end: devices it booted shut down first. Settable for tests. */
export const stopTiming = {waitMs: 120_000};

/** Waits until the process is gone; false when it is still alive at the deadline. */
export const waitGone = async (pid: number, waitMs = stopTiming.waitMs): Promise<boolean> => {
  const end = Date.now() + waitMs;
  while (isAlive(pid) && Date.now() < end) await new Promise(r => setTimeout(r, 200));
  return !isAlive(pid);
};

const stillStopping = (pid: number) => `still stopping: pid ${pid} is giving its devices back (a device that will not shut down holds it up)`;

/** After a whole-stand `down` answered `daemon: stopping`: waits until the daemon is gone. */
export const waitDaemonGone = async (client: DaemonClient): Promise<StopResult> =>
  (await waitGone(client.info.pid)) ? {lines: [], failed: false, stopped: true} : {lines: [stillStopping(client.info.pid)], failed: true, stopped: false};

/**
 * Stops the project's daemon: a `stop` gives its devices back (shutting down those it booted) and closes the browsers
 * it started; a `restart` keeps the devices for the daemon that follows. Both stop even while a session uses it — a
 * person or an agent asked. Unreachable daemons of the same config are stopped first.
 */
export const stopProjectDaemon = async (opts: {config?: string; cwd?: string}, mode: 'stop' | 'restart'): Promise<StopResult & {stray: string}> => {
  const running = await runningDaemon(opts);
  const {daemonsOf, stopDaemons} = await import('./siblings.ts');
  const strays = daemonsOf(resolveProject(opts).file).filter(pid => pid !== running?.info.pid);
  const lines: string[] = [];
  let failed = false;
  // Unreachable daemons first, by SIGTERM (their leases stay with the project), so the stop below gives their
  // devices back with its own.
  const left = strays.length ? await stopDaemons(strays) : [];
  const stray = strays.length ? `; ${strays.length - left.length} unreachable daemon${strays.length > 1 ? 's' : ''} of this config stopped too (pid ${strays.join(', ')})` : '';
  if (left.length) {
    lines.push(`pid ${left.join(', ')} (a daemon of this config) did not stop on SIGTERM`);
    failed = true;
  }
  // `keepLeases` is what a daemon from before `release` reads; `by` says a person asked, so it stops even in use.
  if (running) await running.call(DAEMON_STOP, mode === 'stop' ? {release: true, by: 'user'} : {keepLeases: true, by: 'user'}).catch(() => undefined);
  // Stopped means gone: devices it booted shut down first, and a script that boots next must not race that.
  if (running && !(await waitGone(running.info.pid))) return {lines: [...lines, stillStopping(running.info.pid)], failed: true, stopped: false, stray};
  if (mode === 'stop') lines.push(running ? `stopped${stray}` : strays.length ? `stopped${stray.replace(/^; /, ': ')}` : 'not running');
  return {lines, failed, stopped: true, stray};
};
