#!/usr/bin/env node
import {main} from './cli.ts';

main().catch(e => {
  process.stderr.write(`${(e as Error).message}
`);
  process.exit(1);
});
