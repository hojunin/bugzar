import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [['**/postmessage-bridge.test.ts', 'jsdom']],
  },
});
