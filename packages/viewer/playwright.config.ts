import { defineConfig, devices } from '@playwright/test';

const PORT = 4373;

// Builds the viewer and serves dist/ + the committed fixtures (e2e/serve.mjs) on
// one origin, then runs the spec against the real production bundle.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm run build && node e2e/serve.mjs',
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { PORT: String(PORT) },
  },
});
