import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@picasso/canvas-core': pkg('canvas-core'),
      '@picasso/canvas-pricing': pkg('canvas-pricing'),
      '@picasso/canvas-router': pkg('canvas-router'),
      '@picasso/canvas-agents': pkg('canvas-agents'),
      '@picasso/canvas-guard': pkg('canvas-guard'),
      '@picasso/canvas-markets': pkg('canvas-markets'),
      '@picasso/canvas-equity': pkg('canvas-equity'),
      '@picasso/canvas-hypothesis': pkg('canvas-hypothesis'),
      '@picasso/canvas-sync': pkg('canvas-sync'),
      '@picasso/canvas-ink': pkg('canvas-ink'),
      '@picasso/canvas-render': pkg('canvas-render'),
    },
  },
  test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 120_000 },
});
