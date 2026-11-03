// Runs one stand service on Windows inside the windowless console `launchHidden` gives it: the command through
// the project shell, its output into the service's log, its exit code into a status file the daemon watches.
// The shell and everything it starts (yarn, node, a file watcher) inherit that hidden console, so none of them
// opens a window of its own — which every one of them does under a detached spawn, a process with no console.
//
//   node svcwrap.js <base64 JSON: {file, args, cwd, env, log, status}>

import {spawn} from 'node:child_process';
import fs from 'node:fs';

type Spec = {file: string; args: string[]; cwd: string; env: Record<string, string>; log: string; status: string};

const spec = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8')) as Spec;
const fd = fs.openSync(spec.log, 'a');
const done = (code: number | null, signal: string | null) => {
  fs.writeFileSync(spec.status, JSON.stringify({code, signal}));
  process.exit(code ?? 1);
};
const child = spawn(spec.file, spec.args, {cwd: spec.cwd, env: {...process.env, ...spec.env}, stdio: ['ignore', fd, fd], windowsHide: true});
child.on('exit', (code, signal) => done(code, signal));
child.on('error', e => {
  fs.appendFileSync(spec.log, `--- pitbox: ${e.message}\n`);
  done(127, null);
});
