import { describe, expect, it } from 'vitest';
import { describePublisherContract } from '../../../test/contracts/publisher.contract.js';
import { FakeForge } from '../forge/fake.js';
import { FakePublisher } from './fake.js';
import type { PublishRequest } from './types.js';

const req = (o: Partial<PublishRequest> = {}): PublishRequest => ({
  projectId: 'p', repoPath: '/repo', ticketId: 'REL-1', runId: 'r1', worktree: '/w', branch: 'factory/rel-1-x', sha: 'aaa', title: 'feat: x', body: 'b', ...o,
});

describePublisherContract('FakePublisher', () => {
  const forge = new FakeForge();
  return {
    publisher: new FakePublisher(forge),
    request: req(),
    end: async (branch, prNumber) => forge.setPr(branch, { number: prNumber, url: `https://github.test/pr/${prNumber}`, state: 'MERGED', checks: 'pass', failedChecks: [] }),
  };
});

describe('FakePublisher', () => {
  it('holdNext: the next publication starts, then waits for its release before reaching the forge (ORC-290)', async () => {
    const p = new FakePublisher();
    const { started, release } = p.holdNext();
    const publishing = p.publish(req());
    await started;
    await Promise.resolve();
    expect(p.asked).toHaveLength(1);
    expect(p.published).toEqual([]);
    release();
    expect((await publishing).prNumber).toBe(1);
    expect(p.published).toHaveLength(1);
    expect((await p.publish(req({ sha: 'bbb' }))).sha).toBe('bbb');
  });

  it('opens one PR per branch and republishing the branch updates its sha', async () => {
    const p = new FakePublisher();
    const first = await p.publish(req());
    expect(first).toEqual({ prNumber: 1, url: 'https://github.test/pr/1', sha: 'aaa' });
    expect(await p.publish(req({ sha: 'bbb' }))).toEqual({ ...first, sha: 'bbb' });
    expect((await p.publish(req({ branch: 'factory/rel-2-y' }))).prNumber).toBe(2);
    expect(p.published.map((r) => r.sha)).toEqual(['aaa', 'bbb', 'aaa']);
  });

  it('opens a new PR when the forge shows the branch PR merged or closed', async () => {
    const forge = new FakeForge();
    const p = new FakePublisher(forge);
    const first = await p.publish(req());
    forge.setPr('factory/rel-1-x', { number: first.prNumber, url: first.url, state: 'MERGED', checks: 'pass', failedChecks: [] });
    const second = await p.publish(req({ sha: 'bbb' }));
    expect(second.prNumber).toBe(2);
    expect((await forge.findPr('/repo', 'factory/rel-1-x'))).toMatchObject({ number: 2, state: 'OPEN' });
    expect((await p.publish(req({ sha: 'ccc' }))).prNumber).toBe(2);
  });

  it('makes the published PR visible to a FakeForge, checks pending', async () => {
    const forge = new FakeForge();
    const p = new FakePublisher(forge);
    await p.publish(req());
    expect(await forge.findPr('/repo', 'factory/rel-1-x')).toEqual({
      number: 1, url: 'https://github.test/pr/1', state: 'OPEN', branch: 'factory/rel-1-x', headSha: 'aaa', checks: 'pending', failedChecks: [],
    });
  });
});
