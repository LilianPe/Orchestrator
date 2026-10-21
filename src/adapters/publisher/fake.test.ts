import { describe, expect, it } from 'vitest';
import { FakeForge } from '../forge/fake.js';
import { FakePublisher } from './fake.js';
import type { PublishRequest } from './types.js';

const req = (o: Partial<PublishRequest> = {}): PublishRequest => ({
  projectId: 'p', repoPath: '/repo', ticketId: 'REL-1', branch: 'relais/rel-1-x', sha: 'aaa', title: 'feat: x', body: 'b', ...o,
});

describe('FakePublisher', () => {
  it('opens one PR per branch and republishing the branch updates its sha', async () => {
    const p = new FakePublisher();
    const first = await p.publish(req());
    expect(first).toEqual({ prNumber: 1, url: 'https://github.test/pr/1', sha: 'aaa' });
    expect(await p.publish(req({ sha: 'bbb' }))).toEqual({ ...first, sha: 'bbb' });
    expect((await p.publish(req({ branch: 'relais/rel-2-y' }))).prNumber).toBe(2);
    expect(p.published.map((r) => r.sha)).toEqual(['aaa', 'bbb', 'aaa']);
  });

  it('makes the published PR visible to a FakeForge, checks pending', async () => {
    const forge = new FakeForge();
    const p = new FakePublisher(forge);
    await p.publish(req());
    expect(await forge.findPr('/repo', 'relais/rel-1-x')).toEqual({
      number: 1, url: 'https://github.test/pr/1', state: 'OPEN', branch: 'relais/rel-1-x', checks: 'pending', failedChecks: [],
    });
  });
});
