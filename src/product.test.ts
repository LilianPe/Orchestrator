import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist']);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    SKIP.has(e.name) ? [] : e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe('product name', () => {
  it('leaves no trace of the old name in src/, bin/, packs/ and web/ (docs/transition.md, « Renommage »)', () => {
    const hits = ['src', 'bin', 'packs', 'web']
      .flatMap((d) => files(join(root, d)))
      .filter((f) => f !== import.meta.filename && /relais/i.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });
});
