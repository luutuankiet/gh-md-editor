const KEY = 'gh-md-editor.doc.v1';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function loadDoc(): string {
  try {
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
