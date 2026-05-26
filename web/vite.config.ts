import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import path from 'path';
import fs from 'fs';

const apiTarget = process.env.CPB_API_TARGET || 'http://localhost:3456';
const wsTarget = process.env.CPB_WS_TARGET || apiTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [
    {
      name: 've-css-resolve',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!source.endsWith('.css') || source.endsWith('.vanilla.css')) return null;
        let resolved: string | undefined;
        const dir = typeof __dirname !== 'undefined' ? __dirname : path.dirname(new URL(import.meta.url).pathname);
        if (source.startsWith('@/')) {
          resolved = path.join(dir, 'src', source.slice(2));
        } else if (importer && source.startsWith('.')) {
          resolved = path.resolve(path.dirname(importer), source);
        }
        if (!resolved) return null;
        const tsPath = resolved + '.ts';
        if (fs.existsSync(tsPath)) return tsPath;
        return null;
      },
    },
    react(),
    {
      name: 've-tsx-file-scope',
      enforce: 'pre',
      transform(code, id) {
        if (id.includes('node_modules')) return null;
        if (!id.endsWith('.tsx') && !id.endsWith('.ts')) return null;
        if (id.endsWith('.css.ts') || id.endsWith('.d.ts')) return null;
        if (!code.includes('@vanilla-extract/css')) return null;
        const fileScope = path.relative(__dirname, id);
        return {
          code: `import { setFileScope, endFileScope } from '@vanilla-extract/css/fileScope';\nsetFileScope('${fileScope}');\n${code}\nendFileScope();`,
          map: null,
        };
      },
    },
    vanillaExtractPlugin(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './test-setup.ts',
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
