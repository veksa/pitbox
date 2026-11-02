// Daemon process entry: `node main.js --config <file>`.

import {serve} from './server.ts';

const i = process.argv.indexOf('--config');
const config = i >= 0 ? process.argv[i + 1] : undefined;

serve(config).catch(e => {
  process.stderr.write(`pitbox daemon failed: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
