import { FakeForge } from '../forge/fake.js';
import { PublishRefused, type BundlePush, type BundleRequest, type Publication, type Publisher, type PublishRefusal, type PublishRequest } from './types.js';

export class FakePublisher implements Publisher {
  /** What was asked, whatever came of it. */
  asked: PublishRequest[] = [];
  /** What reached the forge. */
  published: PublishRequest[] = [];
  /** What the next `publish` refuses, once. */
  private refusals: { code: PublishRefusal; message: string }[] = [];
  /** The bundles handed back (ORC-234), whatever came of them. */
  bundles: BundleRequest[] = [];
  /** The head a bundle carries, as `git bundle verify` would read it: the fake reads no file. */
  bundleHead = 'b'.repeat(40);
  private bundleRefusals: { code: PublishRefusal; message: string }[] = [];

  constructor(private forge: FakeForge = new FakeForge()) {}

  /** The next `publish`, held once asked. */
  private holds: { enter: () => void; gate: Promise<void> }[] = [];

  refuseNext(code: PublishRefusal, message: string = code): void {
    this.refusals.push({ code, message });
  }

  refuseNextBundle(code: PublishRefusal, message: string = code): void {
    this.bundleRefusals.push({ code, message });
  }

  /** The bundle checked and pushed, or refused: its head goes over what the fake forge's PR, if any, has. */
  async publishBundle(req: BundleRequest): Promise<BundlePush> {
    this.bundles.push(req);
    const refusal = this.bundleRefusals.shift();
    if (refusal) throw new PublishRefused(refusal.code, refusal.message);
    const pr = await this.forge.findPr(req.repoPath, req.branch);
    if (pr) this.forge.setPr(req.branch, { ...pr, headSha: this.bundleHead });
    return { sha: this.bundleHead, ...(pr?.headSha ? { before: pr.headSha } : {}) };
  }

  /**
   * Holds the next publication once asked: `started` settles then, with no deadline of its own (ORC-290);
   * `release` lets it go on to the forge.
   */
  holdNext(): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (enter = r));
    this.holds.push({ enter, gate });
    return { started, release };
  }

  /** The forge's `ensurePr`, as the real one: an open PR is found by its branch, a merged or closed one gets a new one. */
  async publish(req: PublishRequest): Promise<Publication> {
    this.asked.push(req);
    const hold = this.holds.shift();
    if (hold) {
      hold.enter();
      await hold.gate;
    }
    const refusal = this.refusals.shift();
    if (refusal) throw new PublishRefused(refusal.code, refusal.message);
    const { number, url } = await this.forge.ensurePr(req.repoPath, { branch: req.branch, base: 'main', title: req.title, body: req.body, draft: true });
    this.published.push(req);
    const pr = (await this.forge.findPr(req.repoPath, req.branch))!;
    this.forge.setPr(req.branch, { ...pr, headSha: req.sha });
    return { prNumber: number, url, sha: req.sha };
  }
}
