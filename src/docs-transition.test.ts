import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const doc = readFileSync(join(root, 'docs/transition.md'), 'utf8');
const STATUSES = ['keep', 'adapt', 'remove', 'undecided'];

function section(title: string): string {
  const start = doc.indexOf(`\n## ${title}\n`);
  expect(start, title).toBeGreaterThanOrEqual(0);
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

const expand = (path: string): string[] => {
  const m = /\{([^}]+)\}/.exec(path);
  return m ? m[1]!.split(',').flatMap((alt) => expand(path.replace(m[0], alt))) : [path];
};

const sourceFiles = readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.endsWith('.test.ts'))
  .map((e) => join(e.parentPath, e.name).slice(root.length + 1).split(sep).join('/')); // doc rows use `/`, as git does

// Inventory tables: the module cell is first, the status column is found by its header.
const rows = new Map<string, string>();
const duplicates: string[] = [];
let statusCol = -1;
for (const line of section('Module inventory').split('\n')) {
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.includes('Status')) statusCol = cells.indexOf('Status');
  else if (!cells[0]!.startsWith('-')) {
    for (const [, path] of cells[0]!.matchAll(/`([^`]+)`/g)) {
      for (const p of expand(path!)) {
        if (rows.has(p)) duplicates.push(p);
        rows.set(p, cells[statusCol] ?? '');
      }
    }
  }
}

describe('docs/transition.md', () => {
  it('gives every non-test file of src/ a row with a starting status', () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
    const missing = sourceFiles.filter((f) => {
      const status = rows.get(f) ?? [...rows].find(([p]) => p.endsWith('/') && f.startsWith(p))?.[1];
      return !STATUSES.includes(status ?? '');
    });
    expect(missing).toEqual([]);
  });

  it('gives every row, in or out of src/, a known status', () => {
    expect([...rows].filter(([, s]) => !STATUSES.includes(s)).map(([p]) => p)).toEqual([]);
  });

  it('lists each path once, and only paths that exist', () => {
    expect(duplicates).toEqual([]);
    expect([...rows.keys()].filter((p) => !existsSync(join(root, p)))).toEqual([]);
  });

  it('lists in « Undecided » exactly the rows marked undecided', () => {
    const undecided = [...rows].filter(([, s]) => s === 'undecided').map(([p]) => p);
    const listed = [...section('Undecided').matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual(undecided.sort());
  });

  it('is linked from the README', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('(docs/transition.md)');
  });
});
