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
    // Never inline an asset into the JS chunk. The file-icon set is ~1200
    // SVGs; at the 4 KB default most of them were base64'd into the critical
    // bundle, which every client pays for on first paint even though only a
    // dozen icons are ever visible. As separate files they are fetched lazily
    // and cached individually by the browser.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // One big bundle is the worst possible shape for a long-haul link.
        // Measured Ho Chi Minh -> Helsinki (286ms round trip, zero loss): a
        // single connection moves ~200 kB/s and stalls, while eight concurrent
        // connections move ~1200 kB/s in the same wall clock. The path is not
        // short of bandwidth, it is short of open windows -- every stream
        // spends its life ramping up and one stream can only ramp so fast. So
        // the win is spreading the payload over chunks the browser fetches
        // side by side: same bytes, several times sooner. Grouping by
        // dependency layer also stops an app-code edit from invalidating the
        // cached vendor chunks.
        //
        // Two traps to respect when widening any rule here.
        //
        // First: only the eight grammars the markdown pane pre-resolves may be
        // named. Roughly 130 more are reachable only through language-data's
        // lazy load(), and naming them in a manual chunk would drag every one
        // into a statically loaded file -- turning a lazy catalogue into eager
        // megabytes. Rollup already gives each dynamic grammar its own chunk.
        //
        // Second, and easy to get wrong: the same applies to the lezer parsers
        // underneath them. A blanket @lezer/ rule looks harmless and is not --
        // it captures the parsers belonging to those lazy-only grammars (go,
        // rust, java, php, cpp) and makes them eager too. Match only the three
        // core packages every grammar shares, and let each parser travel with
        // whichever grammar chunk pulled it in.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@xterm')) return 'xterm';
          if (id.includes('@codemirror/merge')) return 'cm-merge';
          if (id.includes('@codemirror/language-data')) return 'cm-lang-data';
          if (/@lezer[\\/](common|highlight|lr)[\\/]/.test(id)) return 'lezer-core';
          if (/@codemirror[\\/]lang-(sql|javascript|python|json|yaml|html|css|markdown)[\\/]/.test(id)) return 'cm-lang-eager';
          if (/@codemirror\/(state|view|language|commands|search|autocomplete|lint)/.test(id)) return 'cm-core';
          if (/[\\/]svelte[\\/]/.test(id)) return 'svelte';
          // No catch-all here, however tempting. This callback runs for every
          // module, dynamic ones included, so a trailing `return 'vendor'`
          // would sweep mermaid, katex and the whole lazy grammar catalogue
          // into a statically loaded chunk -- about 2 MB that today nobody
          // downloads unless they open a diagram. Anything not named above is
          // left to Rollup, which keeps lazy things lazy.
        },
      },
    },
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
      '@codemirror/merge',
      '@replit/codemirror-indentation-markers',
    ],
  },
});
