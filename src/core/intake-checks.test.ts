import { describe, expect, it } from 'vitest';
import type { ForgeBranch, OpenPr } from '../adapters/forge/types.js';
import { ACTIVE_WORK_MAX, formatActiveWork, formatReuse, guardFindings, ownBranchPrefix, ownWork } from './intake-checks.js';

const branch = (name: string): ForgeBranch => ({ name, url: `https://github.com/acme/app/tree/${name}` });
const pr = (number: number, branchName: string, files: string[] = ['src/a.ts']): OpenPr => ({ number, url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, branch: branchName, files });

describe('ownWork: the not_started check, absorbed by the duplicate search (ORC-207)', () => {
  it("names the ticket's own branch, by its PR's link when it has an open one", () => {
    expect(ownBranchPrefix('REL-3')).toBe('factory/rel-3-');
    expect(ownWork('REL-3', [branch('factory/rel-3-old')], [])).toBe(
      'This ticket already has work on the forge: https://github.com/acme/app/tree/factory/rel-3-old (branch factory/rel-3-old).',
    );
    expect(ownWork('REL-3', [branch('factory/rel-3-old')], [pr(4, 'factory/rel-3-old')])).toBe(
      'This ticket already has work on the forge: https://github.com/acme/app/pull/4 (branch factory/rel-3-old).',
    );
  });

  it("finds none on another ticket's branch, even one whose id starts the same", () => {
    expect(ownWork('REL-3', [branch('factory/rel-31-x'), branch('main')], [pr(1, 'feat/rel-3')])).toBeUndefined();
  });
});

describe('formatActiveWork: what intake reads of the work in progress elsewhere (ORC-207)', () => {
  it('lists the open PRs with their files, the branches without a PR, the close tickets; never the ticket itself', () => {
    const text = formatActiveWork('REL-3', {
      prs: [pr(12, 'feat/csv', ['src/export.ts', 'src/list.tsx']), pr(4, 'factory/rel-3-old')],
      branches: [branch('main'), branch('feat/csv'), branch('wip/pdf'), branch('factory/rel-3-old')],
      tickets: [{ identifier: 'REL-3', title: 'Self', url: 'u3', stateName: 'Todo' }, { identifier: 'REL-9', title: 'CSV again', url: 'https://linear.app/x/REL-9', stateName: 'Done' }],
    })!;
    expect(text).toContain('https://github.com/acme/app/pull/12');
    expect(text).toContain('`src/export.ts`, `src/list.tsx`');
    expect(text).toContain('wip/pdf');
    expect(text).toContain('REL-9');
    expect(text).toContain('Done');
    // Its own work is the factory's to check, and the PR's branch is said with the PR.
    expect(text).not.toContain('REL-3 ');
    expect(text).not.toContain('pull/4');
    expect(text.match(/feat\/csv/g)).toHaveLength(1);
  });

  it('says so when there is nothing, rather than nothing', () => {
    expect(formatActiveWork('REL-3', { prs: [], branches: [branch('main')], tickets: [] })).toBe('No open PR, no other branch, no close ticket.');
  });

  it('caps what it lists, the PR files and the whole, and says what it left out', () => {
    const many = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
    expect(formatActiveWork('REL-3', { prs: [pr(1, 'a', many)], branches: [], tickets: [] })).toContain('and 30 more files');
    const prs = Array.from({ length: 400 }, (_, i) => pr(i + 1, `b${i}`, [`src/${'x'.repeat(40)}${i}.ts`]));
    const text = formatActiveWork('REL-3', { prs, branches: [], tickets: [] })!;
    expect(text.length).toBeLessThanOrEqual(ACTIVE_WORK_MAX + 200);
    expect(text).toMatch(/Capped at \d+ characters: \d+ more open PRs, 0 more branches and 0 more close tickets not shown\./);
  });
});

describe('formatReuse: the leads build reads (ORC-207)', () => {
  it('one line each, its symbol when it has one', () => {
    expect(formatReuse([{ path: 'src/csv.ts', symbol: 'toCsv', why: 'Writes a line.' }, { path: 'src/io/', why: 'The file helpers.' }])).toBe(
      '- `src/csv.ts` (`toCsv`): Writes a line.\n- `src/io/`: The file helpers.',
    );
  });
});

describe('guardFindings: what intake found that keeps the ticket from starting (ORC-207)', () => {
  const base = { size: 'm' as const, risk: 'low' as const, complete: true, missing: [], screen: false };

  it('none for a ticket in scope without duplicate', () => {
    expect(guardFindings(base)).toEqual([]);
  });

  it('each duplicate with its link, the refusal of scope with its split', () => {
    expect(
      guardFindings({
        ...base,
        duplicates: [{ url: 'https://github.com/acme/app/pull/12', why: 'Same export.' }],
        scope: { refuse: 'An architecture change.', split: [{ title: 'Step one', summary: 'The first part.' }] },
      }),
    ).toEqual([
      'Probable duplicate: https://github.com/acme/app/pull/12 (Same export.)',
      'Out of scope: An architecture change. Proposed split, not created: 1. Step one: The first part.',
    ]);
  });
});
