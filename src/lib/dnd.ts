// Custom drag MIME types. Deliberately NOT text/plain: CodeMirror's native
// drop handler inserts any text/plain payload straight into the document, so
// dragging a tab across an open editor used to paste the tab's path into the
// file and mark it dirty. A custom type is invisible to that handler, and the
// editors additionally guard drop/dragover for it.
export const TAB_DND_MIME = 'application/x-gmd-tab';
export const PATH_DND_MIME = 'application/x-gmd-path';
