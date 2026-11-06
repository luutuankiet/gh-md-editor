// Main-thread side of the language-guessing model. The worker, and with it the
// ~1 MB of model code and weights, is created on the first call and never at
// startup: most sessions never open a buffer the filename cannot classify.
// Every tab shares the one worker, so a second untitled buffer pays nothing.
import type { ModelGuess } from './lang-detect';
import type { LangModelRequest, LangModelResponse } from './lang-model.worker';

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, (g: ModelGuess[]) => void>();

function ensureWorker(): Worker | null {
  if (worker || broken) return worker;
  try {
    worker = new Worker(new URL('./lang-model.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    broken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<LangModelResponse>) => {
    const done = pending.get(e.data.id);
    pending.delete(e.data.id);
    done?.('guesses' in e.data ? e.data.guesses : []);
  };
  // A worker that failed to load (a missing asset, a blocked script) stays
  // failed. Answer everything outstanding with "no guess" and stop trying, so
  // detection degrades to shebang-only instead of retrying on every pause.
  worker.onerror = () => {
    broken = true;
    worker?.terminate();
    worker = null;
    for (const done of pending.values()) done([]);
    pending.clear();
  };
  return worker;
}

// The model's guesses for `text`, best first. Never rejects: any failure
// resolves to an empty list, which the acceptance rule reads as "keep what you
// have".
export function guessLanguage(text: string): Promise<ModelGuess[]> {
  const w = ensureWorker();
  if (!w) return Promise.resolve([]);
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const msg: LangModelRequest = { id, text };
    w.postMessage(msg);
  });
}
