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
  /** The branch of an open PR that has no check at all; absent, the case is skipped. */
  noChecks?: string;
  /** The branch of an open PR that the forge finds but whose checks it then fails to answer; absent, the case is skipped. */
  checksDown?: string;
  /** The branch of an open PR whose checks include one in a state the forge does not know, the others green; absent, the case is skipped. */
  unknownBucket?: string;
  /** The names of the checks on `unknownBucket` in a state the forge does not know; absent, the case naming them is skipped. */
  unknownChecks?: string[];
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

    it('findPr rejects for checks it cannot read', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'unreadableChecks');
      await expect(s.forge.findPr(s.repoPath, s.unreadableChecks)).rejects.toThrow();
    });

    it('findPr gives none for an open PR without any check', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'noChecks');
      expect(await resolved(s.forge.findPr(s.repoPath, s.noChecks))).toMatchObject({
        branch: s.noChecks, state: 'OPEN', checks: 'none', failedChecks: [],
      });
    });

    it('findPr rejects when the forge answers the PR but not its checks', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'checksDown');
      await expect(s.forge.findPr(s.repoPath, s.checksDown)).rejects.toThrow();
    });

    it('findPr gives neither pass nor none for checks with a state it does not know', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'unknownBucket');
      const pr = await resolved(s.forge.findPr(s.repoPath, s.unknownBucket));
      expect(pr).toMatchObject({ branch: s.unknownBucket, state: 'OPEN' });
      expect(['pending', 'fail']).toContain(pr!.checks);
      expect(pr!.failedChecks.length > 0).toBe(pr!.checks === 'fail');
    });

    it('findPr names each check whose state it does not know', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'unknownBucket', 'unknownChecks');
      const pr = await resolved(s.forge.findPr(s.repoPath, s.unknownBucket));
      expect([...(pr!.unknownChecks ?? [])].sort()).toEqual([...s.unknownChecks].sort());
    });

  });
}
