#!/usr/bin/env node
import {main} from './cli.ts';

// exitCode, not process.exit(): exiting while network handles are still closing aborts Node on Windows
// (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`).
main().catch(e => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exitCode = 1;
});
