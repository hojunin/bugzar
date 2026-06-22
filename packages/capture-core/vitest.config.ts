import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The capture modules patch DOM globals (console, fetch, localStorage,
    // PerformanceObserver). happy-dom gives all three a working browser-like
    // surface. rrweb-recorder.test.ts mocks rrweb and needs no real DOM, so it
    // runs fine under the same environment.
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
  },
});
