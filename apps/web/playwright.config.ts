import { readdirSync, statSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Prefer a pre-installed Chromium (PLAYWRIGHT_BROWSERS_PATH, e.g. this sandbox); on CI
// runners that dir won't exist, so fall back to Playwright's own installed browser.
// Install layouts vary by Playwright version, so probe the known shapes.
function findChromium(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return undefined;
  const candidates = [`${base}/chromium`];
  try {
    for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d))) {
      candidates.push(`${base}/${dir}/chrome-linux64/chrome`, `${base}/${dir}/chrome-linux/chrome`);
    }
  } catch {
    return undefined;
  }
  return candidates.find((p) => {
    try {
      return statSync(p).isFile(); // follows symlinks; skips the `chromium` dir layout
    } catch {
      return false;
    }
  });
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
