// More than one daemon for one config (daemon/siblings.ts): found by the process list with a matching --config, a
// starting daemon refuses while the one in the daemon file answers and otherwise stops the unreachable ones. The
// process list and signals are stand-ins: no process is listed or stopped.

import {afterEach, describe, expect, it} from 'vitest';
import {daemonProcs, daemonsOf, parseDaemonProcs, stopDaemons, takeOver, type DaemonProc} from './daemon/siblings.ts';

const real = {...daemonProcs};
afterEach(() => Object.assign(daemonProcs, real));

/** A process table of `procs`; `kill` ends a process unless it is in `stubborn`. */
const table = (procs: DaemonProc[], stubborn: number[] = []) => {
  const live = new Set(procs.map(p => p.pid));
  const killed: number[] = [];
  Object.assign(daemonProcs, {
    list: () => procs.filter(p => live.has(p.pid)),
    alive: (pid: number) => live.has(pid),
    kill: (pid: number) => {
      killed.push(pid);
      if (!stubborn.includes(pid)) live.delete(pid);
    },
  });
  return {killed, live};
};

describe('daemons of one config', () => {
  it('reads the daemons and their config files from the process list, a path with spaces whole', () => {
    const ps = [
      '  101 /usr/local/bin/node /work/app/node_modules/@veksa/pitbox/dist/daemon/main.js --config /work/app/pitbox.config.ts',
      '  102 node /src/pitbox/src/daemon/main.ts --config /Users/me/My Projects/app/pitbox.config.ts',
      '  103 node /work/app/node_modules/.bin/pitbox daemon status',
      '  104 vim /work/app/src/daemon/main.ts',
      '  105 node /work/other/dist/daemon/main.js --config /work/other/pitbox.config.ts  ',
    ].join('\n');
    expect(parseDaemonProcs(ps)).toEqual([
      {pid: 101, config: '/work/app/pitbox.config.ts'},
      {pid: 102, config: '/Users/me/My Projects/app/pitbox.config.ts'},
      {pid: 105, config: '/work/other/pitbox.config.ts'},
    ]);
  });

  it('finds every live daemon of a config but this process and other configs', () => {
    table([
      {pid: 101, config: '/work/app/pitbox.config.ts'},
      {pid: 102, config: '/work/app/./pitbox.config.ts'},
      {pid: 103, config: '/work/other/pitbox.config.ts'},
      {pid: process.pid, config: '/work/app/pitbox.config.ts'},
    ]);
    expect(daemonsOf('/work/app/pitbox.config.ts')).toEqual([101, 102]);
  });

  it('stops them by SIGTERM and says which did not end', async () => {
    const t = table([{pid: 101, config: '/a'}, {pid: 102, config: '/a'}], [102]);
    expect(await stopDaemons([101, 102], 300)).toEqual([102]);
    expect(t.killed).toEqual([101, 102]);
  });
});

describe('a daemon that starts', () => {
  it('refuses while the daemon in the daemon file answers, and stops nothing', async () => {
    const t = table([{pid: 101, config: '/work/app/pitbox.config.ts'}]);
    const r = await takeOver('/work/app/pitbox.config.ts', 101);
    expect(r.refuse).toMatch(/^pitbox daemon 101 already runs for \/work\/app\/pitbox\.config\.ts/);
    expect(t.killed).toEqual([]);
  });

  it('stops the daemons of its config nobody can reach, and leaves other configs alone', async () => {
    const t = table([
      {pid: 101, config: '/work/app/pitbox.config.ts'},
      {pid: 102, config: '/work/app/pitbox.config.ts'},
      {pid: 103, config: '/work/other/pitbox.config.ts'},
    ]);
    const r = await takeOver('/work/app/pitbox.config.ts', undefined, 300);
    expect(r).toEqual({stopped: [101, 102], left: []});
    expect([...t.live]).toEqual([103]);
  });

  it('starts at once when it is the only one', async () => {
    const t = table([]);
    expect(await takeOver('/work/app/pitbox.config.ts', undefined)).toEqual({stopped: [], left: []});
    expect(t.killed).toEqual([]);
  });
});
