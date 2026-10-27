import { expect } from 'vitest';
import type { FeedbackItem } from '../../src/core/types.js';
import type { Forge } from '../../src/adapters/forge/types.js';
import { describeContract, resolved, subjectWith, type ContractOptions } from './cases.js';

/** What the implementation under test arranged for the suite. Docs: docs/ports/forge.md. */
export interface ForgeSubject {
  forge: Forge;
  repoPath: string;
  /** A branch that never had a PR. */
  missingBranch: string;
  /** A branch with a PR, and that PR's number; absent, the PR cases are skipped. */
  pr?: { branch: string; number: number };
  /** The unresolved review threads arranged on `pr`; absent, only their shape is checked. */
  unresolved?: FeedbackItem[];
  /** The same implementation, talking to a forge that does not answer; absent, the case is skipped. */
  unreachable?: Forge;
  /** The branch of an open PR whose checks the forge answers in a form that cannot be read; absent, the case is skipped. */
  unreadableChecks?: string;
}

export function describeForgeContract(name: string, make: () => ForgeSubject | Promise<ForgeSubject>, options?: ContractOptions): void {
  describeContract(`Forge contract: ${name}`, options, (it) => {

    it('findPr answers undefined for a branch without a PR', async () => {
      const s = await make();
      expect(await resolved(s.forge.findPr(s.repoPath, s.missingBranch))).toBeUndefined();
    });

    it('findPr returns the branch PR, its checks consistent with the failed ones', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'pr');
      const pr = await s.forge.findPr(s.repoPath, s.pr.branch);
      expect(pr).toMatchObject({ number: s.pr.number, branch: s.pr.branch });
      expect(pr!.url).toMatch(/^https:\/\//);
      expect(['OPEN', 'MERGED', 'CLOSED']).toContain(pr!.state);
      expect(['pending', 'pass', 'fail', 'none']).toContain(pr!.checks);
      expect(pr!.failedChecks.length > 0).toBe(pr!.checks === 'fail');
    });

    it('findPr is a read: asking twice gives the same answer', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'pr');
      const [a, b] = await Promise.all([s.forge.findPr(s.repoPath, s.pr.branch), s.forge.findPr(s.repoPath, s.pr.branch)]);
      expect(a).toEqual(b);
    });

    it('findPr and unresolvedReviewComments return snapshots the caller may mutate', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'pr');
      const pr = (await s.forge.findPr(s.repoPath, s.pr.branch))!;
      const before = structuredClone(pr);
      pr.number = -1;
      pr.failedChecks.push('mutated-by-caller');
      expect(await s.forge.findPr(s.repoPath, s.pr.branch)).toEqual(before);
      const items = await s.forge.unresolvedReviewComments(s.repoPath, s.pr.number);
      const listed = structuredClone(items);
      if (items[0]) items[0].body = 'mutated-by-caller';
      items.push({ author: 'x', body: 'x', at: 0, source: 'review' });
      expect(await s.forge.unresolvedReviewComments(s.repoPath, s.pr.number)).toEqual(listed);
    });

    it('unresolvedReviewComments lists the unresolved review threads as review feedback', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'pr');
      const items = await s.forge.unresolvedReviewComments(s.repoPath, s.pr.number);
      if (s.unresolved) expect(items).toEqual(s.unresolved);
      for (const item of items) {
        expect(item.source).toBe('review');
        expect(item.author).not.toBe('');
        expect(item.body).not.toBe('');
        expect(Number.isFinite(item.at)).toBe(true);
      }
    });

    it('findPr and unresolvedReviewComments reject when the forge does not answer', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'unreachable');
      await expect(s.unreachable.findPr(s.repoPath, s.pr?.branch ?? s.missingBranch)).rejects.toThrow();
      await expect(s.unreachable.unresolvedReviewComments(s.repoPath, s.pr?.number ?? 1)).rejects.toThrow();
    });

    it('findPr gives none for checks it cannot read', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'unreadableChecks');
      expect(await resolved(s.forge.findPr(s.repoPath, s.unreadableChecks))).toMatchObject({
        branch: s.unreadableChecks, state: 'OPEN', checks: 'none', failedChecks: [],
      });
    });

  });
}
