import type { FakeForge } from '../forge/fake.js';
import type { Publication, Publisher, PublishRequest } from './types.js';

export class FakePublisher implements Publisher {
  published: PublishRequest[] = [];
  private prs = new Map<string, number>();

  /** With a forge, each publication shows up as an open PR whose checks are pending. */
  constructor(private forge?: FakeForge) {}

  async publish(req: PublishRequest): Promise<Publication> {
    this.published.push(req);
    const prNumber = this.prs.get(req.branch) ?? this.prs.size + 1;
    this.prs.set(req.branch, prNumber);
    const url = `https://github.test/pr/${prNumber}`;
    this.forge?.setPr(req.branch, { number: prNumber, url, state: 'OPEN', checks: 'pending', failedChecks: [] });
    return { prNumber, url, sha: req.sha };
  }
}
