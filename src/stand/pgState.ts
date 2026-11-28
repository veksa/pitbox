// The backend side of a named state, built in: a Postgres dump of the app's schemas (and the extensions that live in
// them), and on restore those schemas dropped whole and made again from it in one transaction — so tables made since
// the save go too, and a restore that fails leaves the database as it was. Redis, when named, is emptied after it.
// Every tool runs as a process of its own with its input and output piped by node: no shell, no redirection, the
// same on macOS, Linux and Windows.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {killTree} from '../util/proc.ts';

/** Where the database is: a container's own tools (`docker exec`), or a connection string for the machine's tools. */
export type PostgresStateConfig = {
  /** Container that runs Postgres; its pg_dump, pg_restore and psql are used. */
  container?: string;
  /** Instead of `container`: a connection string for the pg_dump, pg_restore and psql on this machine's PATH. */
  url?: string;
  /** Role (`-U`) inside the container. Default: the tools' own default. */
  user?: string;
  /** Database inside the container. */
  database?: string;
  /** The app's schemas: the only ones dumped, and dropped whole before a restore. */
  schemas: string[];
  /** Extensions dumped along (`-e`), dropped before a restore when they live outside the schemas. */
  extensions?: string[];
};

export type RedisStateConfig = {container?: string; url?: string};

export type Cmd = {file: string; args: string[]};

/** Runs one command; `stdinFile` is fed to it, its stdout goes to `stdoutFile` (or is collected). */
export type Exec = (cmd: Cmd, io: {stdinFile?: string; stdoutFile?: string; input?: string; timeoutMs: number}) => Promise<{code: number | null; stdout: string; stderr: string}>;

export const exec: Exec = (cmd, io) =>
  new Promise(resolve => {
    const child = spawn(cmd.file, cmd.args, {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let failed: string | undefined;
    const timer = setTimeout(() => {
      failed = `timed out after ${Math.round(io.timeoutMs / 1000)}s`;
      killTree(child);
    }, io.timeoutMs);
    const sink = io.stdoutFile ? fs.createWriteStream(io.stdoutFile) : undefined;
    const sunk = sink ? new Promise<void>(r => sink.on('close', () => r())) : Promise.resolve();
    if (sink) child.stdout.pipe(sink);
    else child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => (failed = e.message));
    // A tool that exits early closes its stdin; what is still being written to it is no error of ours.
    child.stdin.on('error', () => undefined);
    if (io.stdinFile) fs.createReadStream(io.stdinFile).pipe(child.stdin);
    else child.stdin.end(io.input ?? '');
    child.on('close', async code => {
      clearTimeout(timer);
      await sunk;
      const stderr = Buffer.concat(err).toString('utf8');
      resolve({code: failed ? code || -1 : code, stdout: Buffer.concat(out).toString('utf8'), stderr: failed ? `${stderr}\n${failed}`.trim() : stderr});
    });
  });

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A Postgres tool, in the container or on this machine, pointed at the database. */
export const pgCommand = (pg: PostgresStateConfig, tool: 'pg_dump' | 'pg_restore' | 'psql', args: string[], opts: {stdin?: boolean; database?: boolean} = {}): Cmd => {
  const db = opts.database === false ? [] : pg.url ? [`--dbname=${pg.url}`] : pg.database ? [`--dbname=${pg.database}`] : [];
  if (pg.url) return {file: tool, args: [...args, ...db]};
  return {file: 'docker', args: ['exec', ...(opts.stdin ? ['-i'] : []), pg.container!, tool, ...(pg.user ? ['-U', pg.user] : []), ...args, ...db]};
};

/** What a restore runs before the dump's own SQL, in the same transaction. */
export const dropStatements = (pg: PostgresStateConfig) =>
  [...pg.schemas.map(s => `DROP SCHEMA IF EXISTS ${ident(s)} CASCADE;`), ...(pg.extensions ?? []).map(e => `DROP EXTENSION IF EXISTS ${ident(e)} CASCADE;`)].join('\n') + '\n';

const failure = (what: string, r: {code: number | null; stdout: string; stderr: string}) =>
  new Error(`state ${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || 'it said nothing'}`);

export const describeTarget = (pg: PostgresStateConfig) => (pg.url ? 'the database at states.postgres.url' : `${pg.database ?? 'the default database'} in ${pg.container}`);

/** Dumps the schemas to `file`; a failed dump leaves the state saved before it as it was. */
export const pgSave = async (pg: PostgresStateConfig, file: string, run: Exec = exec) => {
  const tmp = `${file}.part`;
  const args = ['-Fc', ...pg.schemas.flatMap(s => ['-n', s]), ...(pg.extensions ?? []).flatMap(e => ['-e', e])];
  try {
    const r = await run(pgCommand(pg, 'pg_dump', args), {stdoutFile: tmp, timeoutMs: 600_000});
    if (r.code !== 0) throw failure(`pg_dump of ${describeTarget(pg)}`, r);
    if (!fs.statSync(tmp).size) throw new Error(`state pg_dump of ${describeTarget(pg)} wrote nothing`);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, {force: true});
  }
};

/**
 * Brings the schemas back from `file`. The archive is read into SQL first (a damaged one fails before anything is
 * dropped); then the drops and that SQL go to psql as one transaction that stops at the first error.
 */
export const pgRestore = async (pg: PostgresStateConfig, file: string, run: Exec = exec) => {
  if (!fs.existsSync(file)) throw new Error(`no database dump ${file}: save the state again`);
  const sql = `${file}.sql`;
  try {
    fs.writeFileSync(sql, dropStatements(pg));
    const tail = `${file}.sql.part`;
    try {
      const r = await run(pgCommand(pg, 'pg_restore', ['-f', '-'], {stdin: true, database: false}), {stdinFile: file, stdoutFile: tail, timeoutMs: 600_000});
      if (r.code !== 0) throw failure(`pg_restore of ${file}`, r);
      await pipeline(fs.createReadStream(tail), fs.createWriteStream(sql, {flags: 'a'}));
    } finally {
      fs.rmSync(tail, {force: true});
    }
    const r = await run(pgCommand(pg, 'psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction'], {stdin: true}), {stdinFile: sql, timeoutMs: 600_000});
    if (r.code !== 0) throw failure(`restore into ${describeTarget(pg)} (nothing was changed)`, r);
  } finally {
    fs.rmSync(sql, {force: true});
  }
};

/** Empties Redis: its keys (locks, limits, sessions) are keyed by row ids, which start over after a restore. */
export const redisFlush = async (redis: RedisStateConfig, run: Exec = exec) => {
  const cmd: Cmd = redis.url ? {file: 'redis-cli', args: ['-u', redis.url, 'FLUSHALL']} : {file: 'docker', args: ['exec', redis.container!, 'redis-cli', 'FLUSHALL']};
  const r = await run(cmd, {timeoutMs: 60_000});
  if (r.code !== 0 || !/OK/.test(r.stdout)) throw failure(`redis FLUSHALL on ${redis.url ? 'states.redis.url' : redis.container}`, r);
};
