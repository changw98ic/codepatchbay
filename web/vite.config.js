import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.CPB_API_TARGET || 'http://localhost:3456';
const wsTarget = process.env.CPB_WS_TARGET || apiTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './test-setup.js',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/ws': {
        target: wsTarget,
        ws: true,
      },
    },
  },
});
