import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // PW_CHANNEL=msedge|chrome uses an installed browser; otherwise run `npx playwright install chromium`
    channel: process.env.PW_CHANNEL || undefined,
    launchOptions: { args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  },
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:5173', reuseExistingServer: true, timeout: 60_000 },
});
