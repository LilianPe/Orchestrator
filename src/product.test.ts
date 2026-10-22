import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
/** Marks a line that keeps the old name on purpose during the transition. */
const MARK = 'transition, à retirer';

describe('product name', () => {
  it('leaves no trace of the old name in tracked files outside docs/ and README.md, except lines marked « transition, à retirer » (docs/transition.md, « Renommage »)', () => {
    const self = relative(root, import.meta.filename);
    const hits = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter((f) => f && f !== self && !f.startsWith('docs/') && f !== 'README.md' && existsSync(join(root, f)))
      .filter((f) => readFileSync(join(root, f), 'utf8').split('\n').some((l) => /relais/i.test(l) && !l.includes(MARK)));
    expect(hits).toEqual([]);
  });
});
