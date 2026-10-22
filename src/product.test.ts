import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

describe('product name', () => {
  it('leaves no trace of the old name in src/, bin/, packs/ and web/ (docs/transition.md, « Renommage »)', () => {
    const hits = ['src', 'bin', 'packs', 'web']
      .flatMap((d) => readdirSync(join(root, d), { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && !/(^|\/)(node_modules|dist)(\/|$)/.test(relative(root, e.parentPath)))
      .map((e) => join(e.parentPath, e.name))
      .filter((f) => f !== import.meta.filename && /relais/i.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });
});
