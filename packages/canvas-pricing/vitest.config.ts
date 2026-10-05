import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@picasso/canvas-core': fileURLToPath(new URL('../canvas-core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Builds the WASM once before any worker starts; see scripts/ensure-wasm.mjs.
    globalSetup: ['../../scripts/ensure-wasm.mjs'],
  },
});
