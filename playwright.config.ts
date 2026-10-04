// Browser end-to-end QA (WP-L, DESIGN §18 R18). The suite runs against the PRODUCTION layout: `npm run build`, then
// the real Node server serves the built client and the /ws endpoint on one origin (PORT 8097 by default; override
// with E2E_PORT when the port is taken). Specs live in e2e/*.spec.ts, shared helpers in e2e/helpers/, and the
// numbered full-page screenshots for the lead's visual review land in e2e/screenshots/ (git-ignored).
//
//   npm run e2e                    # build + start the server + run every spec (one worker, file order)
//   npx playwright test e2e/02-singleplayer.spec.ts
//   npx tsx e2e/tools/devProxyCheck.ts   # separate: Vite dev server proxy check (/api, /ws), see the script header
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8097);
const BASE_URL = `http://127.0.0.1:${PORT}`;
/** Default: Playwright's headless shell. E2E_CHANNEL=chromium runs the full Chromium build in new-headless mode (rendering comparisons). */
const CHANNEL = process.env.E2E_CHANNEL || undefined;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  outputDir: './test-results',
  // One worker in file order: the specs share one server and the numbered screenshots tell one story.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // Round steps (a whole hole with default keyboard shots, two-browser multiplayer) take up to a few minutes.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // No HTML reporter on purpose: its trace-viewer bundle would land in a folder that `eslint .` lints (R10 forbids
  // touching eslint.config.js to ignore it). The JSON result file is not linted.
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  use: {
    baseURL: BASE_URL,
    channel: CHANNEL,
    viewport: { width: 1280, height: 800 },
    locale: 'fi-FI',
    timezoneId: 'Europe/Helsinki',
    screenshot: 'on',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: 'npm run build && node packages/server/dist/index.js',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { PORT: String(PORT), LOG_LEVEL: 'info' },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
