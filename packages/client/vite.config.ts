import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // /audio/* sample overrides live in the repo-level assets folder
  publicDir: resolve(__dirname, '../../assets'),
  server: { port: 5173, host: true },
  // workspace packages are source: never serve a stale pre-bundled copy
  optimizeDeps: { exclude: ['@sigilfall/sim', '@sigilfall/recognizer'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
