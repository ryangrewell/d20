/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@shared': r('./shared'), '@server': r('./server'), '@': r('./src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['shared/**/*.test.ts', 'server/**/*.test.ts'], environment: 'node' } },
      { extends: true, test: { name: 'web', include: ['src/**/*.test.{ts,tsx}'], environment: 'jsdom', setupFiles: ['./src/test/setup.ts'] } },
      { extends: true, test: { name: 'integration', include: ['test/integration/**/*.test.ts'], environment: 'node', testTimeout: 30000, hookTimeout: 30000, fileParallelism: false } },
    ],
  },
});
