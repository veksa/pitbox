// The simulators pitbox created for sessions (`<name> (pitbox N)`), by udid: only these are ever deleted — on
// release, and by `devices clean`. A simulator someone named the same way by hand is not on the list and stays.

import fs from 'node:fs';
import path from 'node:path';
import {pitboxHome, withLock} from './lease.ts';

export type Created = {udid: string; name: string; at: number};

const file = () => path.join(pitboxHome(), 'created-simulators.json');

const read = (): Created[] => {
  try {
    const list = JSON.parse(fs.readFileSync(file(), 'utf8')) as Created[];
    return Array.isArray(list) ? list.filter(c => c && typeof c.udid === 'string') : [];
  } catch {
    return [];
  }
};

const write = (list: Created[]) => {
  fs.mkdirSync(path.dirname(file()), {recursive: true});
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, file());
};

export const listCreated = (): Created[] => read();

export const isCreated = (udid: string): boolean => read().some(c => c.udid === udid);

export const recordCreated = (udid: string, name: string) => withLock(file(), () => write([...read().filter(c => c.udid !== udid), {udid, name, at: Date.now()}]));

export const forgetCreated = (udid: string) => withLock(file(), () => write(read().filter(c => c.udid !== udid)));
