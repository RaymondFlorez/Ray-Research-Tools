import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@picasso/canvas-core': pkg('canvas-core'),
      '@picasso/canvas-ink': pkg('canvas-ink'),
      '@picasso/canvas-sync': pkg('canvas-sync'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // One Postgres, one schema per test file; files run one after another.
    fileParallelism: false,
  },
});
