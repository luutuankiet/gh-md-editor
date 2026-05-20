import { mount } from 'svelte';
import App from './components/App.svelte';
import './app.css';
import 'markdown-it-github-alerts/styles/github-base.css';
import 'markdown-it-github-alerts/styles/github-colors-light.css';
import 'markdown-it-github-alerts/styles/github-colors-dark-media.css';

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
