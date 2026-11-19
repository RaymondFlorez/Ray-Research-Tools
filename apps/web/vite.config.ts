import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Split long-lived vendor code into separately cacheable chunks (Step 11). deck.gl and
 * luma.gl dominate the bundle and change rarely, so app deploys don't invalidate them;
 * the globe itself is lazy-loaded (see App.tsx) so the UI shell paints first.
 */
function vendorChunk(id: string): string | undefined {
  // Rollup otherwise hoists Vite's tiny preload/commonjs helpers into whichever chunk
  // first needs them — the GL chunk — which would force it to load eagerly.
  if (id.includes('vite/preload-helper') || id.includes('commonjsHelpers')) return 'vendor-react';
  if (!id.includes('node_modules')) return undefined;
  if (/[\\/](@luma\.gl|@math\.gl|@probe\.gl|@loaders\.gl)[\\/]/.test(id)) return 'vendor-gl';
  if (/[\\/]@deck\.gl[\\/]/.test(id)) return 'vendor-deck';
  if (/[\\/](react|react-dom|scheduler|zustand)[\\/]/.test(id)) return 'vendor-react';
  if (/[\\/](zod|fast-json-patch)[\\/]/.test(id)) return 'vendor-schema';
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    // Enforced per chunk by scripts/check-bundle-size.mjs; this only silences Vite's
    // generic warning for the (expected) large GL chunk.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
});
