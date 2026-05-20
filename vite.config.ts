import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  base: '/gh-md-editor/',
  optimizeDeps: {
    exclude: [
      'codemirror',
      '@codemirror/state',
      '@codemirror/view',
    ],
  },
  server: { port: 5173, host: '127.0.0.1' },
});
