import type { FakeForge } from '../forge/fake.js';
import type { Publication, Publisher, PublishRequest } from './types.js';

export class FakePublisher implements Publisher {
  published: PublishRequest[] = [];
  private prs = new Map<string, number>();
  private opened = 0;

  constructor(private forge?: FakeForge) {}

  async publish(req: PublishRequest): Promise<Publication> {
    this.published.push(req);
    const known = this.prs.get(req.branch);
    // As on GitHub, a push does not reopen a merged or closed PR: the branch gets a new one.
    const pr = await this.forge?.findPr(req.repoPath, req.branch);
    const ended = pr !== undefined && pr.number === known && pr.state !== 'OPEN';
    const prNumber = known !== undefined && !ended ? known : ++this.opened;
    this.prs.set(req.branch, prNumber);
    const url = `https://github.test/pr/${prNumber}`;
    this.forge?.setPr(req.branch, { number: prNumber, url, state: 'OPEN', checks: 'pending', failedChecks: [] });
    return { prNumber, url, sha: req.sha };
  }
}
