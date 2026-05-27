import { mount } from 'svelte';
import App from '@gmd/components/App-vscode.svelte';
import '@gmd/app.css';
import 'markdown-it-github-alerts/styles/github-base.css';
import 'markdown-it-github-alerts/styles/github-colors-light.css';
import 'markdown-it-github-alerts/styles/github-colors-dark-class.css';
import { injectPreviewThemes } from '@gmd/lib/preview-theme';

type VsCodeApi = {
  postMessage: (msg: unknown) => void;
  getState: <T = unknown>() => T | undefined;
  setState: <T = unknown>(state: T) => void;
};
declare const acquireVsCodeApi: () => VsCodeApi;
const vscodeApi: VsCodeApi = acquireVsCodeApi();
(globalThis as any).__vscodeApi = vscodeApi;

injectPreviewThemes();

type InitMessage = {
  type: 'init';
  content: string;
  widths?: { splitPct: number; outlineSplitterPct: number };
  uri: string;
  languageId: string;
};

let mounted = false;

window.addEventListener('message', (event: MessageEvent) => {
  const msg = (event as any).data;
  if (!mounted && msg?.type === 'init') {
    mounted = true;
    mount(App, {
      target: document.getElementById('app')!,
      props: { initial: msg as InitMessage },
    });
  }
});

// Tell the extension host we're ready to receive the initial document payload.
vscodeApi.postMessage({ type: 'ready' });
