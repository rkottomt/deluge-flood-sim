import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset and preset URLs: the same build works at the site root (npm run demo) and under any sub-path
  // (GitHub Pages serves a project at /<repo>/), with no server rewrites. Presets are fetched from BASE_URL.
  base: './',
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
