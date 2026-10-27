import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end journeys against the local stack (docker compose infra +
 * dev API + Vite). Locally uses installed Google Chrome; CI uses bundled Chromium.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
    ...(process.env.CI ? {} : { channel: 'chrome' }),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env.CI ? {} : { channel: 'chrome' }) } }],
  webServer: [
    { command: 'npx tsx dev/server.ts', url: 'http://localhost:8787/api/health', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npx vite --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000 },
  ],
});
