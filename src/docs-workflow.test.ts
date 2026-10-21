import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from './config/load-workflow.js';
import { parseCondition } from './core/conditions.js';

const root = join(import.meta.dirname, '..');
const doc = readFileSync(join(root, 'docs/workflow.md'), 'utf8');
const packDir = join(root, 'packs/standard');

function blocks(lang: string): string[] {
  return [...doc.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]!);
}

describe('docs/workflow.md', () => {
  it('every yaml example loads on top of the standard pack', () => {
    const examples = blocks('yaml');
    expect(examples.length).toBeGreaterThanOrEqual(10);
    const dir = mkdtempSync(join(tmpdir(), 'factory-doc-wf-'));
    examples.forEach((yaml, i) => {
      const file = join(dir, `example-${i}.yml`);
      writeFileSync(file, yaml);
      expect(() => loadWorkflow({ packDir, projectFile: file }), yaml).not.toThrow();
    });
  });

  it('the when examples parse or fail as documented', () => {
    const [valid, invalid] = blocks('text');
    const lines = (b: string) => b.split('\n').map((l) => l.replace(/\s+#.*$/, '').trim()).filter(Boolean);
    for (const c of lines(valid!)) expect(() => parseCondition(c), c).not.toThrow();
    for (const c of lines(invalid!)) expect(() => parseCondition(c), c).toThrow(/invalid condition/);
  });
});
