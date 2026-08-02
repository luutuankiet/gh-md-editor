import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Extension } from '@codemirror/state';
import { dotenvLanguage } from './lang-dotenv';

// One list, every consumer: the language picker's names, the picker's lookup,
// filename auto-detection in the editor, and the grammar the diff views load.
// Anything appended here has to be visible to all of them, or the picker and
// the detector disagree about what exists.
export const LANGS = [dotenvLanguage, ...languages];

// Extensions @codemirror/language-data ships no grammar for. Without an entry
// here `matchFilename` returns null and the document renders as unhighlighted
// plain text — which is exactly what a .svelte diff used to look like.
//
// Each maps to the closest grammar that IS present. The single-file component
// formats are HTML documents whose <script> and <style> blocks the HTML grammar
// already delegates to JavaScript and CSS, so the bulk of the file highlights
// correctly; only the template control-flow blocks stay uncoloured.
const EXT_ALIAS: Record<string, string> = {
  svelte: 'html',
  astro: 'html',
  vue: 'html',
  mdx: 'md',
  jsonc: 'json',
  json5: 'json',
};

// Resolve by real filename first so anything the library knows about wins, and
// only then retry through the alias table. The retry goes back through
// matchFilename with a synthetic name rather than matching on language name:
// extensions are the stable identifier, display names are not.
export function describeFor(name: string): LanguageDescription | null {
  const direct = LanguageDescription.matchFilename(LANGS, name);
  if (direct) return direct;
  const ext = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase();
  const alias = ext ? EXT_ALIAS[ext] : undefined;
  return alias ? LanguageDescription.matchFilename(LANGS, `f.${alias}`) : null;
}

// An empty extension array is a valid CodeMirror extension, so an unknown file
// type degrades to no highlighting rather than throwing.
export async function grammarFor(name: string): Promise<Extension> {
  const desc = describeFor(name);
  return desc ? await desc.load() : [];
}
