import { branchOf } from './active-work.js';
import type { CiFailureReport } from '../../core/ci-failures.js';
import type { FeedbackItem } from '../../core/types.js';
import type { RepoPermission, RepoPermissions } from '../roles/types.js';
import { ArtifactsRefused, ReviewLinesRefused, type ArtifactHost, type CheckRunRequest, type Forge, type ForgeBranch, type ForgeWriter, type GitAccess, type HostedFile, type MergeResult, type OpenPr, type PrInfo, type PrRequest, type ReviewRequest } from './types.js';

export type FakeCheckRun = CheckRunRequest & { id: number };

export class FakeForge implements Forge, ForgeWriter, ArtifactHost, RepoPermissions {
  private prs = new Map<string, PrInfo>();
  /** The PRs `ensurePr` opened, in order. */
  opened: (PrRequest & { number: number })[] = [];
  /** The check runs on the forge, as GitHub keeps them: by id, with their sha and external id. */
  checkRuns: FakeCheckRun[] = [];
  private comments = new Map<number, FeedbackItem[]>();
  private permissions = new Map<string, RepoPermission>();
  /** A forge that does not answer: every read rejects. */
  offline = false;

  setPr(branch: string, pr: Omit<PrInfo, 'branch'>): void {
    this.prs.set(branch, { ...pr, branch });
  }

  /** A GitHub user's permission on the repo (ORC-186); `none` until set. */
  setRepoPermission(login: string, permission: RepoPermission): void {
    this.permissions.set(login, permission);
  }

  async repoPermission(_github: string, login: string): Promise<RepoPermission> {
    this.answer();
    return this.permissions.get(login) ?? 'none';
  }

  setReviewComments(prNumber: number, items: FeedbackItem[]): void {
    this.comments.set(prNumber, items);
  }

  private answer(): void {
    if (this.offline) throw new Error('forge unreachable');
  }

  async findPr(_github: string, branch: string): Promise<PrInfo | undefined> {
    this.answer();
    const pr = this.prs.get(branch);
    return pr && structuredClone(pr);
  }

  /** The red CI `ciFailures` answers per PR number (ORC-459); unset, the failed checks of the PR, without log, a green base. */
  private ciReports = new Map<number, CiFailureReport>();

  setCiFailures(prNumber: number, report: CiFailureReport): void {
    this.ciReports.set(prNumber, report);
  }

  async ciFailures(_github: string, prNumber: number): Promise<CiFailureReport> {
    this.answer();
    const set = this.ciReports.get(prNumber);
    if (set) return structuredClone(set);
    const pr = [...this.prs.values()].find((p) => p.number === prNumber);
    if (!pr) throw new Error(`no pull request #${prNumber}`);
    const failed = pr.failedChecks.map((name) => ({ name, conclusion: 'failure', noLog: 'the fake forge keeps no log' }));
    return { head: pr.headSha ?? '', failed, base: { branch: this.defaultBranch, sha: '', checks: 'pass', failedChecks: [] } };
  }

  async unresolvedReviewComments(_github: string, prNumber: number): Promise<FeedbackItem[]> {
    this.answer();
    return (this.comments.get(prNumber) ?? []).map((c) => ({ ...c }));
  }

  /** The open PRs `openPrs` lists (ORC-207), as another hand opened them: apart from `setPr`'s and `ensurePr`'s. */
  openPullRequests: OpenPr[] = [];
  /** The branch names on the forge (ORC-207). */
  branchNames: string[] = [];
  /** The web page of the repository, the root of a branch's link. */
  repoUrl = 'https://github.test/acme/app';

  async openPrs(): Promise<OpenPr[]> {
    this.answer();
    return this.openPullRequests.map((pr) => ({ ...pr, files: pr.files && [...pr.files] }));
  }

  async branches(_github: string, prefix: string): Promise<ForgeBranch[]> {
    this.answer();
    return this.branchNames.filter((b) => b.startsWith(prefix)).map((name) => branchOf(this.repoUrl, name));
  }

  /** The default branch, which `recentBranches` leaves out. */
  defaultBranch = 'main';

  /** The branches but the default one, in the order a test set them: the most recent first. */
  async recentBranches(): Promise<ForgeBranch[]> {
    this.answer();
    return this.branchNames.filter((b) => b !== this.defaultBranch).map((name) => branchOf(this.repoUrl, name));
  }

  async ensurePr(_github: string, req: PrRequest): Promise<{ number: number; url: string; deduplicated: boolean }> {
    this.answer();
    const pr = this.prs.get(req.branch);
    if (pr?.state === 'OPEN') return { number: pr.number, url: pr.url, deduplicated: true };
    const number = Math.max(0, ...[...this.prs.values()].map((p) => p.number), ...this.opened.map((p) => p.number)) + 1;
    const url = `https://github.test/pr/${number}`;
    this.opened.push({ ...req, number });
    this.setPr(req.branch, { number, url, state: 'OPEN', checks: 'pending', failedChecks: [] });
    return { number, url, deduplicated: false };
  }

  /** The PRs taken out of draft, in order. */
  readied: number[] = [];

  async markPrReady(_github: string, number: number): Promise<void> {
    this.answer();
    this.readied.push(number);
  }

  private prLabels = new Map<number, string[]>();
  /** How many label writes reached the forge (ORC-198): a final state already in place adds none. */
  labelWrites = 0;

  /** The labels of a PR, as a test or a human set them. */
  setPrLabels(number: number, labels: readonly string[]): void {
    this.prLabels.set(number, [...labels]);
  }

  labelsOf(number: number): string[] {
    return [...(this.prLabels.get(number) ?? [])];
  }

  async setExclusiveLabel(_github: string, number: number, label: string, group: readonly string[]): Promise<void> {
    this.answer();
    const now = this.labelsOf(number);
    const others = now.filter((l) => !group.includes(l));
    if (now.includes(label) && others.length === now.length - 1) return;
    this.labelWrites++;
    this.prLabels.set(number, [...others, label]);
  }

  /** Where the factory's git goes: a local repository in a test. */
  gitUrl = 'https://github.test/acme/app.git';
  gitEnv: Record<string, string> = {};

  async gitAccess(): Promise<GitAccess> {
    return { url: this.gitUrl, env: this.gitEnv };
  }

  /** The merges asked (ORC-148), with the head each one required. */
  merges: { number: number; sha: string }[] = [];
  /** The checks of the PRs' base commit: `none` is a repository with no CI (ORC-148). */
  baseChecks: PrInfo['checks'] = 'none';
  /** The repository's own active Actions workflows: one is a CI, even one that never checks the base (ORC-148). */
  ciWorkflows = 0;

  /** As GitHub: merged only if the PR's head is still `sha`; a PR already merged on it is found again. */
  async mergePr(_github: string, number: number, sha: string, opts: { unchecked?: boolean } = {}): Promise<MergeResult> {
    this.answer();
    const pr = [...this.prs.values()].find((p) => p.number === number);
    if (!pr) throw new Error(`no PR #${number}`);
    if (pr.state === 'MERGED' && pr.headSha === sha) return { merged: true, deduplicated: true };
    if (pr.headSha !== sha) return { merged: false, reason: 'head_moved' };
    if (pr.state !== 'OPEN' || pr.checks === 'fail') return { merged: false, reason: 'not_mergeable', message: 'Pull Request is not mergeable' };
    if (opts.unchecked && (pr.checks !== 'none' || this.ciWorkflows > 0 || this.baseChecks !== 'none')) return { merged: false, reason: 'checks_missing' };
    this.merges.push({ number, sha });
    this.prs.set(pr.branch, { ...pr, state: 'MERGED' });
    return { merged: true, deduplicated: false };
  }

  async upsertCheckRun(_github: string, req: CheckRunRequest): Promise<{ id: number; deduplicated: boolean }> {
    this.answer();
    // As GitHub's adapter: among the sha's runs of that name.
    const existing = this.checkRuns.find((c) => c.sha === req.sha && c.name === req.name && c.externalId === req.externalId);
    if (existing) {
      Object.assign(existing, req);
      return { id: existing.id, deduplicated: true };
    }
    const id = this.checkRuns.length + 1;
    this.checkRuns.push({ ...req, id });
    return { id, deduplicated: false };
  }

  /** The reviews posted on the PRs (ORC-183), with their PR's number, as GitHub keeps them. */
  reviews: (ReviewRequest & { number: number; id: number })[] = [];
  /** Lines (`path:line`) GitHub cannot place a comment on, as a test sets them: a review commenting one is refused. */
  unplaceable = new Set<string>();

  async postReview(_github: string, number: number, req: ReviewRequest): Promise<{ id: number; deduplicated: boolean }> {
    this.answer();
    const existing = this.reviews.find((r) => r.number === number && r.externalId === req.externalId);
    if (existing) return { id: existing.id, deduplicated: true };
    if (req.comments.some((c) => this.unplaceable.has(`${c.path}:${c.line}`))) throw new ReviewLinesRefused('Line could not be resolved');
    const id = this.reviews.length + 1;
    this.reviews.push({ ...req, comments: req.comments.map((c) => ({ ...c })), number, id });
    return { id, deduplicated: false };
  }

  /** The files on `factory/artifacts` (ORC-407), by path, and how many commits put them there. */
  artifacts = new Map<string, Uint8Array>();
  artifactCommits = 0;
  /** A refusal of the forge, as a protection rule gives one: every write of the branch rejects `ArtifactsRefused` with it. */
  artifactsRefusal: string | undefined;

  async hostArtifacts(_github: string, files: readonly HostedFile[]): Promise<string[]> {
    this.answer();
    if (this.artifactsRefusal) throw new ArtifactsRefused(this.artifactsRefusal);
    if (files.some((f) => !this.artifacts.has(f.path))) this.artifactCommits++;
    for (const f of files) this.artifacts.set(f.path, f.content);
    return files.map((f) => `${this.repoUrl}/blob/c${this.artifactCommits}/${f.path}?raw=true`);
  }

  async pruneArtifacts(_github: string, expired: (folder: string) => Promise<boolean>): Promise<string[]> {
    this.answer();
    if (this.artifactsRefusal) throw new ArtifactsRefused(this.artifactsRefusal);
    const removed: string[] = [];
    for (const folder of new Set([...this.artifacts.keys()].map((p) => p.split('/')[0]!))) if (await expired(folder)) removed.push(folder);
    for (const p of [...this.artifacts.keys()]) if (removed.includes(p.split('/')[0]!)) this.artifacts.delete(p);
    if (removed.length) this.artifactCommits++;
    return removed;
  }
}
