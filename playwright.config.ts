import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 8095;
const dbPath = join(mkdtempSync(join(tmpdir(), 'e2e-chat-')), 'chat.db');

export default defineConfig({
  testDir: 'tests/e2e',
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: `http://localhost:${PORT}`, ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run build && npm run start:fake',
    url: `http://localhost:${PORT}/c/e2e-health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { PORT: String(PORT), DB_PATH: dbPath },
  },
});
