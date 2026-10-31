import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const verificationUiRoot = path.resolve(__dirname, '../public');

// Serve the Verification System (public/), not the stamping connection demo.
export default defineConfig({
  root: verificationUiRoot,
  publicDir: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Local backend (CORS already allows 5173). Auth/API stay same-origin via proxy.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
});
