import { defineConfig } from '@playwright/test';

const port = Number(process.env.JOURNAL_E2E_PORT ?? 41_778);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('JOURNAL_E2E_PORT must be an integer between 1 and 65535.');
}

const baseURL = `http://localhost:${port}`;
const isCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  forbidOnly: isCi,
  failOnFlakyTests: isCi,
  retries: isCi ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: isCi
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    serviceWorkers: 'allow',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && node e2e/test-server.mjs',
    env: { JOURNAL_E2E_PORT: String(port), JOURNAL_LOG_LEVEL: 'warn' },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    reuseExistingServer: false,
    timeout: 120_000,
    url: `${baseURL}/healthz`,
  },
  projects: [
    {
      name: 'chromium-desktop',
      testIgnore: /accessibility-mobile\.spec\.ts/,
      use: {
        browserName: 'chromium',
        viewport: { width: 1_280, height: 900 },
      },
    },
    {
      name: 'chromium-mid',
      testMatch: /(?:responsive|keyboard-layout)\.spec\.ts/,
      use: {
        browserName: 'chromium',
        viewport: { width: 680, height: 900 },
      },
    },
    {
      name: 'chromium-short',
      testMatch: /responsive\.spec\.ts/,
      use: {
        browserName: 'chromium',
        hasTouch: true,
        isMobile: true,
        viewport: { width: 375, height: 500 },
      },
    },
    {
      name: 'chromium-landscape',
      testMatch: /responsive\.spec\.ts/,
      use: {
        browserName: 'chromium',
        hasTouch: true,
        isMobile: true,
        viewport: { width: 812, height: 375 },
      },
    },
    {
      name: 'chromium-tablet',
      testMatch: /responsive\.spec\.ts/,
      use: {
        browserName: 'chromium',
        hasTouch: true,
        viewport: { width: 834, height: 1_194 },
      },
    },
    {
      name: 'chromium-narrow',
      testMatch: /(?:responsive|entry-sheet|accessibility-mobile|reflection-timeline)\.spec\.ts/,
      use: {
        browserName: 'chromium',
        hasTouch: true,
        isMobile: true,
        viewport: { width: 375, height: 812 },
      },
    },
    /*
     * WebKit is the engine the owner actually ships on. Chromium's mobile
     * emulation agrees with it about layout far more often than about the
     * visual viewport, so the two surfaces that are *built* on visualViewport —
     * the pinned composer and the entry sheet — are re-run here for real.
     */
    {
      name: 'webkit-iphone',
      testMatch: /(?:responsive|entry-sheet|keyboard-layout|reflection-timeline)\.spec\.ts/,
      use: {
        browserName: 'webkit',
        deviceScaleFactor: 3,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
    },
    /*
     * The ≥680px pinning regression this geometry system exists to prevent (a
     * keyboard-open composer running the full window width, under the sidebar)
     * only reproduces on a wide *touch* layout, which is exactly an iPad.
     */
    {
      name: 'webkit-ipad',
      testMatch: /keyboard-layout\.spec\.ts/,
      use: {
        browserName: 'webkit',
        hasTouch: true,
        viewport: { width: 834, height: 1_194 },
      },
    },
  ],
});
