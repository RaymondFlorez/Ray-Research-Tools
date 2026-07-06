import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    // deck.gl + luma.gl are large; code-splitting is addressed in BUILD_PROMPTS Step 11.
    chunkSizeWarningLimit: 1500,
  },
});
