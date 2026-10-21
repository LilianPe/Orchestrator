import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const doc = readFileSync(join(root, 'docs/transition.md'), 'utf8');
const STATUSES = ['garder', 'adapter', 'retirer', 'à trancher'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.test.ts') ? [] : [relative(root, p)];
  });
}

// Each inventory row: | `path` [, `path`…] | role | status | target ticket |
function inventory(): { rows: Map<string, string>; duplicates: string[] } {
  const rows = new Map<string, string>();
  const duplicates: string[] = [];
  for (const line of doc.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    for (const [, path] of cells[0]!.matchAll(/`(src\/[^`]+)`/g)) {
      if (rows.has(path!)) duplicates.push(path!);
      rows.set(path!, cells[2]!);
    }
  }
  return { rows, duplicates };
}

describe('docs/transition.md', () => {
  const { rows, duplicates } = inventory();

  it('lists each path once', () => {
    expect(duplicates).toEqual([]);
  });

  it('gives every non-test file of src/ a row with a starting status', () => {
    const files = sourceFiles(join(root, 'src'));
    expect(files.length).toBeGreaterThan(50);
    const missing = files.filter((f) => {
      const row = [...rows].find(([p]) => p === f || (p.endsWith('/') && f.startsWith(p)));
      return !row || !STATUSES.includes(row[1]);
    });
    expect(missing).toEqual([]);
  });

  it('only lists paths that exist', () => {
    expect([...rows.keys()].filter((p) => !existsSync(join(root, p)))).toEqual([]);
  });

  it('is linked from the README', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('(docs/transition.md)');
  });
});
