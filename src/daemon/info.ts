// What a client needs to know about the daemon — kept apart from the server so that the CLI does not load the
// whole engine (drivers, dev server, compilers) just to send one request.

import path from 'node:path';

export type DaemonInfo = {pid: number; port: number; token: string; config: string; root: string; startedAt: number; version: string};

export const daemonFile = (stateDir: string) => path.join(stateDir, 'daemon.json');

export const VERSION = '0.0.0';

/** RPC that stops the daemon itself — named so it cannot collide with an engine method such as `shutdown`. */
export const DAEMON_STOP = '__stopDaemon';
