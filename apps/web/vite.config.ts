import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vitejs.dev/config/
export default defineConfig({
  // Default base is '/'. Set VITE_BASE for sub-path deploys (GitHub Pages).
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Pre-bundle workspace deps so they reload cleanly on change.
  optimizeDeps: {
    include: ['@ganttly/schema', '@ganttly/calendar-data', '@ganttly/domain'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Proxy API + discovery to the server so the browser sees same-origin
      // requests — session cookies flow without CORS/SameSite friction.
      // Default server port is 3001 (apps/server/src/config.ts + .env.example).
      '/api': 'http://localhost:3001',
      '/.well-known': 'http://localhost:3001',
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
