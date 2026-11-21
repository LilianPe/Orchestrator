import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(join(import.meta.dirname, '../docs/preset.md'), 'utf8');
const engine = readFileSync(join(import.meta.dirname, 'core/engine.ts'), 'utf8');

/** The section `## <title>`, up to the next heading of that level or above. */
function section(title: string): string {
  const start = doc.indexOf(`\n## ${title}\n`);
  expect(start, title).toBeGreaterThanOrEqual(0);
  const end = doc.slice(start + 1).search(/\n#{1,2} /);
  return doc.slice(start, end === -1 ? undefined : start + 1 + end);
}

/** The default reactions `decide` codes (ORC-392), by the name of their function. */
const REACTIONS = ['onDelegated', 'reviewAgain', 'resumeBlocked', 'humanFeedback', 'instruction', 'askQuestion', 'stopped', 'prFailed', 'merged'];

describe('docs/preset.md', () => {
  it('lists each default reaction coded in decide, by its function (ORC-392)', () => {
    for (const name of REACTIONS) expect(engine, name).toMatch(new RegExp(`(function|const) ${name}\\b`));
    const listed = section('Default reactions (ORC-227, ORC-392)');
    for (const name of REACTIONS) expect(listed, name).toContain(`\`${name}\``);
  });

  it('documents no `when` grammar any more: the rules are gone (ORC-392)', () => {
    expect(doc).not.toMatch(/`when` grammar|whenSrc/);
  });

  it('names no key of the removed workflow.yml limits in any doc but the decisions and the transition log: the bounds are in the preset (ORC-177)', () => {
    const docs = join(import.meta.dirname, '../docs');
    const stale = readdirSync(docs).filter((f) => f.endsWith('.md') && f !== 'transition.md' && /`(limits\.(per_run|verify_attempts|ci_fix_attempts|human_review_rounds)|jobs\.\*\.limits)/.test(readFileSync(join(docs, f), 'utf8')));
    expect(stale).toEqual([]);
  });
});
