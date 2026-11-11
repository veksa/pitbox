import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Every test file gets a temporary PITBOX_HOME: the machine's real device leases are never touched.
    setupFiles: ['src/test-setup.ts'],
  },
});
