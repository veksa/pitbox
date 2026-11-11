// The devices pitbox created for sessions, by id: simulators (`<name> (pitbox N)`, by udid) and AVDs
// (`<avd>_pitbox_N`, as `android:<name>`). Only these are ever deleted — on release, and by `devices clean` — and an
// AVD only while its folder is still the one pitbox made (`stamp`). One someone named the same way by hand is not on
// the list and stays.

import fs from 'node:fs';
import path from 'node:path';
import {pitboxHome, withLock} from './lease.ts';

export type Created = {
  udid: string;
  name: string;
  at: number;
  /** The AVD it is a copy of (Android). */
  like?: string;
  /** The AVD folder's inode and birth time, once created (Android). */
  stamp?: string;
  /** Made for a session that keeps what it creates (`devices.deleteCreated: false`): only `devices clean` deletes it. */
  keep?: boolean;
};

const file = () => path.join(pitboxHome(), 'created-simulators.json');

const read = (): Created[] => {
  try {
    const list = JSON.parse(fs.readFileSync(file(), 'utf8')) as Created[];
    return Array.isArray(list) ? list.filter(c => c && typeof c.udid === 'string') : [];
  } catch {
    return [];
  }
};

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const write = (list: Created[]) => {
  fs.mkdirSync(path.dirname(file()), {recursive: true});
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  // Windows refuses a rename over a file another process has open for a moment (an antivirus, a reader): retried.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file());
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        fs.rmSync(tmp, {force: true});
        throw e;
      }
      sleepSync(25 * (i + 1));
    }
  }
};

export const listCreated = (): Created[] => read();

export const createdEntry = (udid: string): Created | undefined => read().find(c => c.udid === udid);

export const isCreated = (udid: string): boolean => read().some(c => c.udid === udid);

export const recordCreated = (udid: string, name: string, extra: Partial<Pick<Created, 'like' | 'stamp' | 'keep'>> = {}) =>
  withLock(file(), () => write([...read().filter(c => c.udid !== udid), {udid, name, at: Date.now(), ...extra}]));

export const updateCreated = (udid: string, patch: Partial<Pick<Created, 'stamp'>>) => withLock(file(), () => write(read().map(c => (c.udid === udid ? {...c, ...patch} : c))));

export const forgetCreated = (udid: string) => withLock(file(), () => write(read().filter(c => c.udid !== udid)));
