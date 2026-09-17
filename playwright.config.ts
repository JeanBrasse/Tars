import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // One Electron instance drives every surface — keep it serial.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  // Makes the directory each run's surfaces record their page errors in.
  globalSetup: './e2e/global-setup.mjs',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    // Every spec that drives the app. Left unnamed, so test titles and output
    // folders read as they did when this was the only project.
    {
      name: '',
      testIgnore: /known-errors\.spec\.ts$/,
      teardown: 'known-errors',
    },
    // The check that no tolerated page error has outlived its defect. As a
    // teardown it starts once everything above has finished, even after a
    // failure and whatever order the files ran in, which is what it needs to
    // see the whole run. See e2e/known-errors.spec.ts.
    {
      name: 'known-errors',
      testMatch: /known-errors\.spec\.ts$/,
    },
  ],
  webServer: {
    command: 'npx next dev -p 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: true,
    timeout: 120_000,
    // Next dev phones home twice per run (telemetry.nextjs.org, seen leaving
    // the machine by lsof on 2026-09-17). This is merged over process.env by
    // the runner, so nothing else about the environment changes.
    env: { NEXT_TELEMETRY_DISABLED: '1' },
  },
});
