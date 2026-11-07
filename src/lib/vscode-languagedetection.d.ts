// The package's second webpack chunk (its CPU backend), imported directly by
// lang-model.worker.ts. Opaque on purpose: it is only handed back to the
// package's own loader, never read.
declare module '@vscode/vscode-languagedetection/dist/lib/979.js' {
  const chunk: unknown;
  export default chunk;
}
