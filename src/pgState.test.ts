import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {configSchema} from './config/schema.ts';
import {type Exec, dropStatements, pgCommand} from './stand/pgState.ts';
import {StateStore} from './stand/states.ts';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-pgstate-'));

/** A stand-in for the tools: records every command and plays a dump, its SQL and psql. */
const fakeTools = (fail: Partial<Record<'pg_dump' | 'pg_restore' | 'psql' | 'redis-cli', boolean>> = {}) => {
  const calls: {cmd: string; stdin?: string}[] = [];
  const run: Exec = async (cmd, io) => {
    const tool = (['pg_dump', 'pg_restore', 'psql', 'redis-cli'] as const).find(t => cmd.file === t || cmd.args.includes(t))!;
    calls.push({cmd: [cmd.file, ...cmd.args].join(' '), ...(io.stdinFile ? {stdin: fs.readFileSync(io.stdinFile, 'utf8')} : {})});
    if (fail[tool]) {
      if (io.stdoutFile) fs.writeFileSync(io.stdoutFile, 'half');
      return {code: 1, stdout: '', stderr: `${tool}: boom`};
    }
    if (tool === 'pg_dump') fs.writeFileSync(io.stdoutFile!, 'ARCHIVE');
    if (tool === 'pg_restore') fs.writeFileSync(io.stdoutFile!, `CREATE SCHEMA app; -- from ${fs.readFileSync(io.stdinFile!, 'utf8')}\n`);
    return {code: 0, stdout: tool === 'redis-cli' ? 'OK\n' : '', stderr: ''};
  };
  return {calls, run};
};

const pg = {container: 'db', user: 'root', database: 'appdb', schemas: ['app'], extensions: ['vector']};

describe('postgres states', () => {
  it('dump only the schemas and extensions named, through the container tools', async () => {
    const root = tmpRoot();
    const tools = fakeTools();
    const store = new StateStore({root, stateDir: path.join(root, '.pitbox')}, {postgres: pg}, tools.run);
    const info = await store.save('signed-in', undefined);
    expect(info.backend).toBe(true);
    expect(tools.calls.map(c => c.cmd)).toEqual(['docker exec db pg_dump -U root -Fc -n app -e vector --dbname=appdb']);
    expect(fs.readFileSync(path.join(root, '.pitbox', 'states', 'signed-in.dump'), 'utf8')).toBe('ARCHIVE');
  });

  it('drop the schemas and make them again in one transaction, then empty redis, run the hook and migrate', async () => {
    const root = tmpRoot();
    const tools = fakeTools();
    const append = (word: string) => `node -e "require('fs').appendFileSync('log', '${word} ')"`;
    const store = new StateStore({root, stateDir: path.join(root, '.pitbox')}, {postgres: pg, redis: {container: 'cache'}, restore: append('restore'), migrate: append('migrate')}, tools.run);
    await store.save('s', undefined);
    tools.calls.length = 0;
    await store.restore('s', undefined);
    expect(tools.calls.map(c => c.cmd)).toEqual([
      'docker exec -i db pg_restore -U root -f -',
      'docker exec -i db psql -U root -X -q -v ON_ERROR_STOP=1 --single-transaction --dbname=appdb',
      'docker exec cache redis-cli FLUSHALL',
    ]);
    expect(tools.calls[0]!.stdin).toBe('ARCHIVE');
    expect(tools.calls[1]!.stdin).toBe('DROP SCHEMA IF EXISTS "app" CASCADE;\nDROP EXTENSION IF EXISTS "vector" CASCADE;\nCREATE SCHEMA app; -- from ARCHIVE\n');
    expect(fs.readFileSync(path.join(root, 'log'), 'utf8')).toBe('restore migrate ');
    // Nothing of the restore is left beside the dump.
    expect(fs.readdirSync(path.join(root, '.pitbox', 'states')).sort()).toEqual(['s.dump', 's.json']);
  });

  it('keep the state saved before when a new dump fails', async () => {
    const root = tmpRoot();
    await new StateStore({root, stateDir: path.join(root, '.pitbox')}, {postgres: pg}, fakeTools().run).save('s', undefined);
    const failing = new StateStore({root, stateDir: path.join(root, '.pitbox')}, {postgres: pg}, fakeTools({pg_dump: true}).run);
    await expect(failing.save('s', undefined)).rejects.toThrow(/pg_dump of appdb in db failed \(exit 1\): pg_dump: boom/);
    const dir = path.join(root, '.pitbox', 'states');
    expect(fs.readFileSync(path.join(dir, 's.dump'), 'utf8')).toBe('ARCHIVE');
    expect(fs.readdirSync(dir).sort()).toEqual(['s.dump', 's.json']);
  });

  it('drop nothing when the archive cannot be read, and stop before migrating when psql fails', async () => {
    const root = tmpRoot();
    const ctx = {root, stateDir: path.join(root, '.pitbox')};
    await new StateStore(ctx, {postgres: pg}, fakeTools().run).save('s', undefined);
    const unreadable = fakeTools({pg_restore: true});
    await expect(new StateStore(ctx, {postgres: pg}, unreadable.run).restore('s', undefined)).rejects.toThrow(/pg_restore of .* failed/);
    expect(unreadable.calls.some(c => c.cmd.includes('psql'))).toBe(false);
    const rejected = fakeTools({psql: true});
    await expect(new StateStore(ctx, {postgres: pg, migrate: 'node -e "require(\'fs\').writeFileSync(\'migrated\', \'\')"'}, rejected.run).restore('s', undefined)).rejects.toThrow(/nothing was changed/);
    expect(fs.existsSync(path.join(root, 'migrated'))).toBe(false);
  });

  it('bring back a state saved by a project command with the built-in restore', async () => {
    const root = tmpRoot();
    const ctx = {root, stateDir: path.join(root, '.pitbox')};
    await new StateStore(ctx, {save: `node -e "require('fs').writeFileSync(process.argv[1], 'ARCHIVE')" {file}`}).save('old', undefined);
    const tools = fakeTools();
    await new StateStore(ctx, {postgres: pg}, tools.run).restore('old', undefined);
    expect(tools.calls[0]!.stdin).toBe('ARCHIVE');
  });

  it('use the machine tools with a connection string', () => {
    const remote = {url: 'postgres://u:p@localhost:5432/app', schemas: ['a', 'b']};
    expect(pgCommand(remote, 'pg_dump', ['-Fc'])).toEqual({file: 'pg_dump', args: ['-Fc', '--dbname=postgres://u:p@localhost:5432/app']});
    expect(pgCommand(remote, 'pg_restore', [], {stdin: true, database: false})).toEqual({file: 'pg_restore', args: []});
    expect(dropStatements({schemas: ['we"ird']})).toBe('DROP SCHEMA IF EXISTS "we""ird" CASCADE;\n');
  });

  it('take a container or a url in the config, and the schemas', () => {
    const states = (s: unknown) => configSchema.safeParse({states: s}).success;
    expect(states({postgres: {container: 'db', database: 'app', schemas: ['app']}, redis: {container: 'cache'}, migrate: 'yarn migrate'})).toBe(true);
    expect(states({postgres: {url: 'postgres://localhost/app', schemas: ['app']}})).toBe(true);
    expect(states({postgres: {container: 'db', database: 'app', schemas: []}})).toBe(false);
    expect(states({postgres: {container: 'db', url: 'postgres://localhost/app', schemas: ['app']}})).toBe(false);
    expect(states({postgres: {url: 'postgres://localhost/app', database: 'app', schemas: ['app']}})).toBe(false);
    expect(states({redis: {}})).toBe(false);
    expect(states({save: 'a', restore: 'b'})).toBe(true);
  });
});

// Against a real Postgres: PITBOX_TEST_PG_CONTAINER names a running container (the user is `postgres`, the database
// `postgres`); CI has none, so it runs only where one is given.
const container = process.env.PITBOX_TEST_PG_CONTAINER;
describe.skipIf(!container)('postgres states on a real database', () => {
  const sql = (q: string) => execFileSync('docker', ['exec', container!, 'psql', '-U', 'postgres', '-qAtX', '-v', 'ON_ERROR_STOP=1', '-c', q], {encoding: 'utf8'}).trim();

  it.each(['pitbox_app', 'public'])('save and restore the %s schema, dropping tables made since', async schema => {
    sql(`DROP SCHEMA IF EXISTS pitbox_app CASCADE; ${schema === 'public' ? 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' : 'CREATE SCHEMA pitbox_app;'}`);
    sql(`CREATE TABLE ${schema}.item (id serial primary key, name text); INSERT INTO ${schema}.item (name) VALUES ('a'), ('b');`);
    const root = tmpRoot();
    const store = new StateStore({root, stateDir: path.join(root, '.pitbox')}, {postgres: {container: container!, user: 'postgres', database: 'postgres', schemas: [schema]}});
    await store.save('two', undefined);
    sql(`INSERT INTO ${schema}.item (name) VALUES ('c'); CREATE TABLE ${schema}.later (id int);`);
    await store.restore('two', undefined);
    expect(sql(`SELECT string_agg(name, ',' ORDER BY id) FROM ${schema}.item`)).toBe('a,b');
    expect(sql(`SELECT count(*) FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name = 'later'`)).toBe('0');
    // A damaged archive is refused before anything is dropped.
    sql(`INSERT INTO ${schema}.item (name) VALUES ('d')`);
    fs.writeFileSync(path.join(root, '.pitbox', 'states', 'two.dump'), 'not an archive');
    await expect(store.restore('two', undefined)).rejects.toThrow(/pg_restore/);
    expect(sql(`SELECT count(*) FROM ${schema}.item`)).toBe('3');
    sql(`DROP SCHEMA ${schema} CASCADE; ${schema === 'public' ? 'CREATE SCHEMA public;' : ''}`);
  });

  it('leave the database as it was when the dump fails half way in', async () => {
    // The dump hands a table to a role that is gone by the restore: its ALTER … OWNER fails after the drops ran.
    sql(`DROP SCHEMA IF EXISTS pitbox_app CASCADE; DROP ROLE IF EXISTS pitbox_gone; CREATE ROLE pitbox_gone; CREATE SCHEMA pitbox_app; CREATE TABLE pitbox_app.item (id int); ALTER TABLE pitbox_app.item OWNER TO pitbox_gone;`);
    const root = tmpRoot();
    const store = new StateStore({root, stateDir: path.join(root, '.pitbox')}, {postgres: {container: container!, user: 'postgres', database: 'postgres', schemas: ['pitbox_app']}});
    await store.save('owned', undefined);
    sql(`DROP OWNED BY pitbox_gone; DROP ROLE pitbox_gone; CREATE TABLE pitbox_app.now (id int); INSERT INTO pitbox_app.now VALUES (1);`);
    await expect(store.restore('owned', undefined)).rejects.toThrow(/nothing was changed.*pitbox_gone/);
    expect(sql(`SELECT count(*) FROM pitbox_app.now`)).toBe('1');
    sql(`DROP SCHEMA pitbox_app CASCADE`);
  });
});
