import { readdirSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Prefer a pre-installed Chromium (PLAYWRIGHT_BROWSERS_PATH, e.g. this sandbox); on CI
// runners that dir won't exist, so fall back to Playwright's own installed browser.
function findChromium(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return undefined;
  try {
    const dir = readdirSync(base).find((d) => d.startsWith('chromium-'));
    return dir ? `${base}/${dir}/chrome-linux/chrome` : undefined;
  } catch {
    return undefined;
  }
}

const executablePath = findChromium();

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: {
      executablePath,
      args: [
        '--no-sandbox',
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --host 127.0.0.1 --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
