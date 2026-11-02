// Start Metro straight through its API with the project's own metro.config.js — no framework CLI in front.
// Used by devserver.ts as --cmd to compare a bare Metro against the CLI that usually wraps it.
//
//   node <pitbox>/bench/metro-raw.mjs [port=8081]      (run from the app directory)

import {createRequire} from 'node:module';
import path from 'node:path';

const port = Number(process.argv[2] ?? 8081);
const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const t0 = performance.now();
const stamp = msg => process.stdout.write(`[metro-raw ${Math.round(performance.now() - t0)}ms] ${msg}\n`);

const Metro = require('metro');
const config = await Metro.loadConfig({cwd: root, port});
stamp('config loaded');
await Metro.runServer(config, {host: '127.0.0.1'});
stamp(`listening on ${port}`);
