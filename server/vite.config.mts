import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const parentRoot = path.resolve(__dirname, '..');

// Third app shell (server mode). Same pattern as vscode/vite.config.mts:
// own root + entry, shared components via the @gmd alias, so everything in
// src/components (minus App shells) + src/lib flows to all deliverables.
export default defineConfig({
  root: path.join(__dirname, 'web'),
  plugins: [
    svelte({
      configFile: path.join(parentRoot, 'svelte.config.js'),
    }),
  ],
  base: './',
  resolve: {
    alias: {
      '@gmd': path.join(parentRoot, 'src'),
    },
    // Exactly ONE copy of the CodeMirror core may exist in the page. The old
    // optimizeDeps.exclude of state/view left those two as raw source while
    // every other @codemirror package was pre-bundled WITH its own inlined
    // copy of @codemirror/state — two cores at once. Extensions minted by one
    // copy are invisible to states from the other (no syntax highlighting),
    // and the view/measure handshake between mismatched copies spins forever
    // (the freeze on opening any non-md file).
    dedupe: [
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@lezer/common',
      '@lezer/highlight',
      '@lezer/lr',
    ],
  },
  server: {
    port: 5174,
    host: '127.0.0.1',
    proxy: {
      // Dev loop: vite serves the client with HMR, node server owns the API.
      // The pty rule must come first — key order is match order.
      '/api/pty': { target: 'ws://127.0.0.1:8790', ws: true },
      '/api': 'http://127.0.0.1:8790',
    },
  },
  build: {
    outDir: path.join(__dirname, 'dist', 'web'),
    emptyOutDir: true,
  },
  optimizeDeps: {
    // Pre-bundle the whole CM graph together so esbuild dedupes it into one
    // optimized set. language-data is here so its lazy grammar imports are
    // discovered up front instead of triggering a mid-session dev reload.
    include: [
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@codemirror/language-data',
      '@codemirror/commands',
      '@codemirror/search',
      '@replit/codemirror-indentation-markers',
    ],
  },
});
