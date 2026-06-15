import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    // Bundle EVERYTHING (workspace packages and runtime deps — all pure JS)
    // so the packaged app needs no node_modules at all.
    plugins: [externalizeDepsPlugin({ exclude: ['@docgit/core', '@docgit/ui', 'chokidar', 'fflate', 'electron-updater'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});
