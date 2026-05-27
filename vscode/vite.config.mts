import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const parentRoot = path.resolve(__dirname, '..');

export default defineConfig({
  root: path.join(__dirname, 'webview'),
  plugins: [
    svelte({
      configFile: path.join(parentRoot, 'svelte.config.js'),
    }),
  ],
  base: '',
  resolve: {
    alias: {
      '@gmd': path.join(parentRoot, 'src'),
    },
  },
  build: {
    outDir: path.join(__dirname, 'dist', 'webview'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: path.join(__dirname, 'webview', 'index.html'),
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'index.js',
        assetFileNames: (info) => {
          if (info.name === 'index.css') return 'index.css';
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
  optimizeDeps: {
    exclude: [
      'codemirror',
      '@codemirror/state',
      '@codemirror/view',
    ],
  },
});
