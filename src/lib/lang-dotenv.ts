import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import type { StreamParser } from '@codemirror/language';

// Environment files are `KEY=value` with `#` comments — structurally the same
// shape as a Java properties file, which @codemirror/legacy-modes already
// tokenises (key as `def`, separator as `operator`, value as `string`). The
// only thing it lacks is comment metadata, so Mod-/ has nothing to toggle;
// declaring commentTokens is what wires the comment command up.
async function loadDotenv(): Promise<LanguageSupport> {
  const { properties } = await import('@codemirror/legacy-modes/mode/properties');
  const parser = properties as StreamParser<unknown>;
  const language = StreamLanguage.define({
    ...parser,
    languageData: {
      ...(parser.languageData ?? {}),
      commentTokens: { line: '#' },
    },
  });
  return new LanguageSupport(language);
}

// Matched by filename, not extension: `.env` has no extension at all, and
// `.env.local` / `.env.production` would otherwise be read as `.local` /
// `.production`. LanguageDescription.matchFilename tries filename patterns
// before extensions, so this wins over any accidental extension collision.
// `foo.env` is covered too, for the rarer extension-style naming.
// Same predicate the LanguageDescription below matches on, exported so the
// value cloak can auto-arm without duplicating the rule or reaching into
// CodeMirror's matcher.
export function isDotenvFile(name: string): boolean {
  return /^\.env(\.[^.]+)*$/.test(name) || /\.env$/.test(name);
}

export const dotenvLanguage = LanguageDescription.of({
  name: 'dotenv',
  alias: ['env', 'environment'],
  filename: /^\.env(\.[^.]+)*$/,
  extensions: ['env'],
  load: loadDotenv,
});
