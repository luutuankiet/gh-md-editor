import { mount } from 'svelte';
import App from '@gmd/components/App-server.svelte';
import '@gmd/app.css';
import 'markdown-it-github-alerts/styles/github-base.css';
import 'markdown-it-github-alerts/styles/github-colors-light.css';
import 'markdown-it-github-alerts/styles/github-colors-dark-class.css';
import { injectPreviewThemes } from '@gmd/lib/preview-theme';

// Same preview-theme injection contract as src/main.ts — the markdown
// cockpit's per-pane theming depends on both scoped stylesheets existing.
injectPreviewThemes();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
