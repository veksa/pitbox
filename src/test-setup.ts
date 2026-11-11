// Runs before every test file: pitbox's machine-wide state (device leases under PITBOX_HOME) goes to a temporary
// folder, so no test reads or writes the leases of the sessions running on this machine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll} from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-home-'));
process.env.PITBOX_HOME = home;

afterAll(() => fs.rmSync(home, {recursive: true, force: true}));
