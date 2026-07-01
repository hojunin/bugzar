import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    // e2e/ is Playwright's (it imports @playwright/test, not vitest).
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
