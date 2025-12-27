import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        launchpad: resolve(__dirname, 'launchpad.html'),
        docs: resolve(__dirname, 'docs.html')
      }
    }
  },
  server: {
    port: 3000
  }
});
