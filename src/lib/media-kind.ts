// Which files the server IDE opens as a preview rather than as text. The
// server's /api/raw keeps its own list of the same extensions (MEDIA_MIME in
// server/index.mjs); a name that matches here and not there previews as a 415.
export type MediaKind = 'image' | 'pdf';

export function mediaKindOf(name: string): MediaKind | null {
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(name)) return 'image';
  return null;
}
