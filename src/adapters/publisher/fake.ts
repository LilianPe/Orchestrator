import { FakeForge } from '../forge/fake.js';
import { PublishRefused, type Publication, type Publisher, type PublishRefusal, type PublishRequest } from './types.js';

export class FakePublisher implements Publisher {
  /** What was asked, whatever came of it. */
  asked: PublishRequest[] = [];
  /** What reached the forge. */
  published: PublishRequest[] = [];
  /** What the next `publish` refuses, once. */
  private refusals: { code: PublishRefusal; message: string }[] = [];

  constructor(private forge: FakeForge = new FakeForge()) {}

  refuseNext(code: PublishRefusal, message: string = code): void {
    this.refusals.push({ code, message });
  }

  /** The forge's `ensurePr`, as the real one: an open PR is found by its branch, a merged or closed one gets a new one. */
  async publish(req: PublishRequest): Promise<Publication> {
    this.asked.push(req);
    const refusal = this.refusals.shift();
    if (refusal) throw new PublishRefused(refusal.code, refusal.message);
    const { number, url } = await this.forge.ensurePr(req.repoPath, { branch: req.branch, base: 'main', title: req.title, body: req.body, draft: true });
    this.published.push(req);
    const pr = (await this.forge.findPr(req.repoPath, req.branch))!;
    this.forge.setPr(req.branch, { ...pr, headSha: req.sha });
    return { prNumber: number, url, sha: req.sha };
  }
}
