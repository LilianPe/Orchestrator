import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// ORC-202 AC2: the docs describe the factory, not Relais. The old name, smee as a production relay, GH_TOKEN,
// ANTHROPIC_API_KEY and the « Ready to Merge » status appear only in a historical note: a blockquote whose first line
// starts with `> **Historical note**` (what was), or `> **Transition note**` (what the code still reads until a ticket
// removes it), the whole quote exempt; or on a page that is a record of the past as a whole.
const root = join(import.meta.dirname, '..');

/** Pages that are history as a whole: the starting point and its renaming table, and the dated decision records. */
const HISTORICAL_PAGES = [/^docs\/transition\.md$/, /^docs\/decisions\//];

const TERMS: { name: string; pattern: RegExp; allowedOn?: RegExp }[] = [
  { name: 'relais', pattern: /relais/i },
  { name: 'GH_TOKEN', pattern: /\bGH_TOKEN\b/ },
  { name: 'ANTHROPIC_API_KEY', pattern: /ANTHROPIC_API_KEY/ },
  { name: 'Ready to Merge', pattern: /ready to merge/i },
  // smee is the workstation's relay (`factory init --dev`): a line that says so may name it, and so may a channel's URL
  // alone on its line, as `init` prints it, and the relay's two lines as `init --dev` writes them in factory.yml (ORC-474).
  { name: 'smee', pattern: /smee/i, allowedOn: /--dev\b|workstation|development|^\s*(?:kind: smee|(?:url: )?https:\/\/smee\.io\/\S*)$/i },
];

const MARKER = /^>\s*\*\*(?:Historical|Transition) note\*\*/;

function docPages(): string[] {
  const docs = readdirSync(join(root, 'docs'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(md|json)$/.test(e.name))
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'));
  return ['README.md', ...docs.sort()];
}

/** The forbidden terms of a page, outside its historical notes, each with its line. */
function forbidden(markdown: string): { line: number; term: string; text: string }[] {
  const found: { line: number; term: string; text: string }[] = [];
  let inNote = false;
  markdown.split('\n').forEach((line, i) => {
    if (MARKER.test(line)) inNote = true;
    else if (!line.startsWith('>')) inNote = false;
    if (inNote) return;
    for (const term of TERMS) {
      if (term.pattern.test(line) && !term.allowedOn?.test(line)) found.push({ line: i + 1, term: term.name, text: line.trim().slice(0, 120) });
    }
  });
  return found;
}

describe('the docs speak of the factory, Relais only in a historical note (ORC-202)', () => {
  const pages = docPages().filter((page) => !HISTORICAL_PAGES.some((p) => p.test(page)));

  it.each(pages)('%s names no retired term outside a historical note', (page) => {
    expect(forbidden(readFileSync(join(root, page), 'utf8')).map((f) => `${f.line}: ${f.term}: ${f.text}`)).toEqual([]);
  });

  it('exempts a historical note, and only it', () => {
    const md = [
      'Relais was the old name.',
      '> **Historical note**: Relais read `GH_TOKEN`.',
      '> It also had a « Ready to Merge » status.',
      '',
      '> **Transition note**: ANTHROPIC_API_KEY is still read on the host.',
      '',
      '> A quote about ANTHROPIC_API_KEY.',
      'smee in production.',
      '  https://smee.io/…',
      'smee relays the webhooks on a workstation (`factory init --dev`).',
      'smee in production; a local tunnel is optional.',
    ].join('\n');
    expect(forbidden(md).map((f) => `${f.line}: ${f.term}`)).toEqual(['1: relais', '7: ANTHROPIC_API_KEY', '8: smee', '11: smee']);
  });
});
