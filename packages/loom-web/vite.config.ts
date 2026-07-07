/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/client'),
    },
  },
  build: {
    outDir: 'client-dist',
  },
  server: {
    proxy: {
      '/api': `http://localhost:${process.env.LOOM_PORT ?? process.env.PORT ?? 3000}`,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/client/**/*.{test,spec}.{ts,tsx}', 'src/client/**/__tests__/**/*.{ts,tsx}'],
  },
});
