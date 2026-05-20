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
