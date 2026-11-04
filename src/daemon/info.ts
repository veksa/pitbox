// What a client needs to know about the daemon — kept apart from the server so that the CLI does not load the
// whole engine (drivers, dev server, compilers) just to send one request.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export type DaemonInfo = {pid: number; port: number; token: string; config: string; root: string; startedAt: number; version: string};

export const daemonFile = (stateDir: string) => path.join(stateDir, 'daemon.json');

// The package's own version: package.json sits two levels above this module, in the sources and in the build.
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version;

/** RPC that stops the daemon itself — named so it cannot collide with an engine method such as `shutdown`. */
export const DAEMON_STOP = '__stopDaemon';
