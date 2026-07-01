import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Bugzar lazy-imports the `@bugzar/sdk/export` subpath (a bare specifier
      // by design — keeps the heavy viewer out of the main bundle). That subpath
      // resolves via package.json `exports` to dist/, which doesn't exist until a
      // build, and CI runs tests before building. Alias to source so tests resolve
      // it without a prior build (viewer-asset.generated is produced by `pretest`).
      '@bugzar/sdk/export': fileURLToPath(new URL('./src/export.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
  },
});
