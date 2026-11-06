// The language-guessing model, off the main thread. One instance of this worker
// serves every tab; see lang-model.ts for the side that talks to it.
//
// The model files are vite assets fetched from the host that serves the app,
// so detection works offline and nothing about the buffer leaves the machine.
import { ModelOperations } from '@vscode/vscode-languagedetection';
// The second half of the package's own bundle; see the require shim below.
import cpuBackendChunk from '@vscode/vscode-languagedetection/dist/lib/979.js';
import modelJsonUrl from '@vscode/vscode-languagedetection/model/model.json?url';
import weightsUrl from '@vscode/vscode-languagedetection/model/group1-shard1of1.bin?url';

// The package ships a webpack build aimed at node. On first use it loads its
// CPU backend from a second file with a plain `require("./979.js")`, which
// does not exist in a browser worker and would fail the very first guess. The
// chunk is imported statically above and handed back here; every other
// `require` in that bundle sits behind a node-only branch and never runs. In a
// production build that call only reaches this shim because a worker plugin in
// server/vite.config.mts rewrites it to `globalThis.require(...)`.
(globalThis as { require?: unknown }).require = (id: string) => {
  if (id === './979.js') return cpuBackendChunk;
  throw new Error(`lang-model worker: unexpected require(${JSON.stringify(id)})`);
};

const model = new ModelOperations({
  modelJsonLoaderFunc: async () => (await fetch(modelJsonUrl)).json(),
  weightsLoaderFunc: async () => (await fetch(weightsUrl)).arrayBuffer(),
});

export type LangModelRequest = { id: number; text: string };
export type LangModelResponse =
  | { id: number; guesses: { languageId: string; confidence: number }[] }
  | { id: number; error: string };

self.onmessage = async (e: MessageEvent<LangModelRequest>) => {
  const { id, text } = e.data;
  try {
    const guesses = await model.runModel(text);
    // Only the head of the ranking is ever read; the full list is ~54 entries.
    const reply: LangModelResponse = {
      id,
      guesses: guesses.slice(0, 5).map((g) => ({ languageId: g.languageId, confidence: g.confidence })),
    };
    self.postMessage(reply);
  } catch (err) {
    const reply: LangModelResponse = { id, error: String(err) };
    self.postMessage(reply);
  }
};
