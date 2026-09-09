import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against canvas-core's source so a change there is visible
      // without a rebuild; tsc resolves the published types from dist.
      '@picasso/canvas-core': fileURLToPath(new URL('../canvas-core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
