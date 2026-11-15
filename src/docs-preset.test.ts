import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCondition } from './core/conditions.js';

const doc = readFileSync(join(import.meta.dirname, '../docs/preset.md'), 'utf8');

/** The `text` blocks of the section `### <title>`, up to the next heading of that level or above. */
function blocks(title: string): string[] {
  const start = doc.indexOf(`\n### ${title}\n`);
  expect(start, title).toBeGreaterThanOrEqual(0);
  const end = doc.slice(start + 1).search(/\n#{1,3} /);
  const section = doc.slice(start, end === -1 ? undefined : start + 1 + end);
  return [...section.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

// docs/workflow.md's examples moved there with ORC-389: the grammar the rules are written in, until ORC-392 removes it.
describe('docs/preset.md', () => {
  it('the when examples parse or fail as documented', () => {
    const [valid, invalid] = blocks('`when` grammar');
    const lines = (b: string) => b.split('\n').map((l) => l.replace(/\s+#.*$/, '').trim()).filter(Boolean);
    expect(lines(valid!).length).toBeGreaterThan(0);
    expect(lines(invalid!).length).toBeGreaterThan(0);
    for (const c of lines(valid!)) expect(() => parseCondition(c), c).not.toThrow();
    for (const c of lines(invalid!)) expect(() => parseCondition(c), c).toThrow(/invalid condition/);
  });
});
