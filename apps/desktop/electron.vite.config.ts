import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    // Bundle the workspace packages into the main build (they are ESM;
    // the main bundle is CJS) — only real node_modules deps stay external.
    plugins: [externalizeDepsPlugin({ exclude: ['@docgit/core', '@docgit/ui'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});
