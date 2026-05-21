const KEY = 'gh-md-editor.doc.v1';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function loadDoc(): string {
  try {
    // ?reset=1 in the URL forces the sample doc back — handy for trying the
    // latest version's feature tour without manually clearing site data.
    if (typeof window !== 'undefined' && /[?&]reset=1\b/.test(window.location.search)) {
      localStorage.removeItem(KEY);
      return '';
    }
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveDocDebounced(content: string, delayMs = 500): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, content);
    } catch {
      // Quota or disabled — silent fail
    }
    saveTimer = null;
  }, delayMs);
}

// v0.5.1: explicit storage wipe + reload, bound to the trash button in the
// outline header. A confirm() prevents accidental clicks (the muscle-memory
// path from the GitHub trash icon is destructive). After confirmation the
// sample doc reappears on reload via loadDoc()'s empty-string fallback.
export function clearDoc(): void {
  if (typeof window !== 'undefined') {
    if (!window.confirm('Wipe the local draft and reload? (The sample doc will reappear.)')) {
      return;
    }
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}
