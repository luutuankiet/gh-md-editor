import { mount } from 'svelte';
import App from './components/App.svelte';
import './app.css';
import 'markdown-it-github-alerts/styles/github-base.css';
import 'markdown-it-github-alerts/styles/github-colors-light.css';
// v0.7.0: switched from `-dark-media.css` (auto-follows OS prefers-color-scheme)
// to `-dark-class.css` (activated via the `.dark` class). The `.dark` vars are
// re-bound onto `.preview-container.theme-dark` inside Preview.svelte so alert
// colors follow the per-pane preview theme — not the OS pref.
import 'markdown-it-github-alerts/styles/github-colors-dark-class.css';
import { injectPreviewThemes } from './lib/preview-theme';

// One-shot inject of both github-markdown-{light,dark} stylesheets, each
// scoped to `.markdown-body.theme-{light,dark}`. Required because the auto
// switching file uses @media and can't be overridden per-pane.
injectPreviewThemes();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
