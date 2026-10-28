import { expect } from 'vitest';
import type { PublishRequest, Publisher } from '../../src/adapters/publisher/types.js';
import { describeContract, resolved, subjectWith, type ContractOptions } from './cases.js';

/** What the implementation under test arranged for the suite. Docs: docs/ports/publisher.md. */
export interface PublisherSubject {
  publisher: Publisher;
  /** A request on a branch without a PR; the cases vary its branch and sha. */
  request: PublishRequest;
  /** Merges or closes the PR of `branch` on the forge; absent, the ended PR case is skipped. */
  end?: (branch: string, prNumber: number) => Promise<void>;
}

export function describePublisherContract(name: string, make: () => PublisherSubject | Promise<PublisherSubject>, options?: ContractOptions): void {
  describeContract(`Publisher contract: ${name}`, options, (it) => {
    it('publish returns the PR of the branch and the sha it pushed', async () => {
      const s = await make();
      const p = await s.publisher.publish(s.request);
      expect(p.sha).toBe(s.request.sha);
      expect(p.url).toMatch(/^https:\/\//);
      expect(Number.isInteger(p.prNumber) && p.prNumber > 0).toBe(true);
    });

    it('republishing a branch updates its PR instead of opening a second one', async () => {
      const s = await make();
      const first = await s.publisher.publish(s.request);
      const replay = await resolved(s.publisher.publish(s.request));
      const sha = `${s.request.sha}-next`;
      expect(replay).toEqual(first);
      expect(await resolved(s.publisher.publish({ ...s.request, sha }))).toEqual({ ...first, sha });
    });

    it('each branch gets its own PR', async () => {
      const s = await make();
      const a = await s.publisher.publish(s.request);
      const b = await s.publisher.publish({ ...s.request, branch: `${s.request.branch}-other` });
      expect(b.prNumber).not.toBe(a.prNumber);
    });

    it('once the branch PR is merged or closed, publishing opens a new one', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'end');
      const first = await s.publisher.publish(s.request);
      await s.end(s.request.branch, first.prNumber);
      const next = { ...s.request, sha: `${s.request.sha}-next` };
      const second = await s.publisher.publish(next);
      expect(second.prNumber).not.toBe(first.prNumber);
      expect(await resolved(s.publisher.publish(next))).toEqual(second);
    });
  });
}
