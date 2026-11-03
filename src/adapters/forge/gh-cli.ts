import type { FeedbackItem } from '../../core/types.js';
import { execCmd, execFailure, mustExec, type Exec } from '../exec.js';
import { REPO_PERMISSIONS, type RepoPermission, type RepoPermissions } from '../roles/types.js';
import type { Forge, PrInfo } from './types.js';

export function aggregateChecks(buckets: string[]): PrInfo['checks'] {
  if (buckets.length === 0) return 'none';
  if (buckets.some((b) => b === 'fail' || b === 'cancel')) return 'fail';
  if (buckets.some((b) => b === 'pending')) return 'pending';
  return 'pass';
}

/**
 * `gh pr checks` exits 1 with an empty stdout both for a PR without any check and for a failure (network,
 * auth); only this stderr line tells the first apart. Checks that fail or are pending still come as JSON.
 */
const NO_CHECKS = /^no checks reported on the '.*' branch$/m;

function parseChecks(stdout: string): { name: string; bucket: string }[] | undefined {
  try {
    const list: unknown = JSON.parse(stdout);
    return Array.isArray(list) ? (list as { name: string; bucket: string }[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What `GET /repos/{owner}/{repo}/collaborators/{user}/permission` answers (ORC-186): its `role_name`
 * when it is a known one (`maintain`, `triage`), else the base `permission` (a custom role keeps its base).
 */
export function toRepoPermission(dto: { permission?: string; role_name?: string } | undefined): RepoPermission {
  const known = (v: string | undefined) => REPO_PERMISSIONS.find((p) => p === v);
  return known(dto?.role_name) ?? known(dto?.permission) ?? 'none';
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes {
    isResolved comments(first: 1) { nodes { author { login } body createdAt path line } } } } } } }`;

export class GhCliForge implements Forge, RepoPermissions {
  constructor(private exec: Exec = execCmd) {}

  /**
   * A user's permission on the repo (ORC-186), as the GitHub App forge reads it, through `gh api`. Every
   * failure throws, a 404 included: `gh` gives the same 404 for a login GitHub does not know and for a
   * repo its account cannot see, and the second is a configuration error, not a refusal.
   */
  async repoPermission(repoPath: string, login: string): Promise<RepoPermission> {
    const out = await mustExec(this.exec, 'gh', ['api', `repos/{owner}/{repo}/collaborators/${encodeURIComponent(login)}/permission`], { cwd: repoPath });
    return toRepoPermission(JSON.parse(out) as { permission?: string; role_name?: string });
  }

  async findPr(repoPath: string, branch: string): Promise<PrInfo | undefined> {
    const out = await mustExec(
      this.exec,
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state,headRefName,headRefOid,mergeCommit,mergedAt', '--limit', '1'],
      { cwd: repoPath },
    );
    const [pr] = JSON.parse(out) as {
      number: number;
      url: string;
      state: PrInfo['state'];
      headRefName: string;
      headRefOid?: string;
      mergeCommit?: { oid?: string } | null;
      mergedAt?: string | null;
    }[];
    if (!pr) return undefined;
    let checks: PrInfo['checks'] = 'none';
    let failedChecks: string[] = [];
    if (pr.state === 'OPEN') {
      const args = ['pr', 'checks', String(pr.number), '--json', 'name,bucket'];
      const r = await this.exec('gh', args, { cwd: repoPath });
      const list = parseChecks(r.stdout);
      if (list) {
        checks = aggregateChecks(list.map((c) => c.bucket));
        failedChecks = list.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name);
      } else if (r.code !== 0 && !NO_CHECKS.test(r.stderr)) {
        throw execFailure('gh', args, r);
      }
    }
    return {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      branch: pr.headRefName,
      ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}),
      ...(pr.state === 'MERGED' && pr.mergeCommit?.oid ? { mergeSha: pr.mergeCommit.oid } : {}),
      ...(pr.state === 'MERGED' && pr.mergedAt && Number.isFinite(Date.parse(pr.mergedAt)) ? { mergedAt: Date.parse(pr.mergedAt) } : {}),
      checks,
      failedChecks,
    };
  }

  async unresolvedReviewComments(repoPath: string, prNumber: number): Promise<FeedbackItem[]> {
    const repo = JSON.parse(await mustExec(this.exec, 'gh', ['repo', 'view', '--json', 'owner,name'], { cwd: repoPath })) as {
      owner: { login: string };
      name: string;
    };
    const out = await mustExec(
      this.exec,
      'gh',
      ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${repo.owner.login}`, '-F', `name=${repo.name}`, '-F', `number=${prNumber}`],
      { cwd: repoPath },
    );
    const nodes = (JSON.parse(out) as any).data.repository.pullRequest.reviewThreads.nodes as {
      isResolved: boolean;
      comments: { nodes: { author: { login: string } | null; body: string; createdAt: string; path: string; line: number | null }[] };
    }[];
    return nodes
      .filter((t) => !t.isResolved && t.comments.nodes[0])
      .map((t) => {
        const c = t.comments.nodes[0]!;
        return {
          author: c.author?.login ?? 'inconnu',
          body: `${c.path}${c.line ? `:${c.line}` : ''} — ${c.body}`,
          at: Date.parse(c.createdAt),
          source: 'review' as const,
        };
      });
  }
}
