import type { FeedbackItem } from '../../core/types.js';
import { execCmd, mustExec, type Exec } from '../exec.js';
import type { Forge, PrInfo } from './types.js';

export function aggregateChecks(buckets: string[]): PrInfo['checks'] {
  if (buckets.length === 0) return 'none';
  if (buckets.some((b) => b === 'fail' || b === 'cancel')) return 'fail';
  if (buckets.some((b) => b === 'pending')) return 'pending';
  return 'pass';
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes {
    isResolved comments(first: 1) { nodes { author { login } body createdAt path line } } } } } } }`;

export class GhCliForge implements Forge {
  constructor(private exec: Exec = execCmd) {}

  async findPr(repoPath: string, branch: string): Promise<PrInfo | undefined> {
    const out = await mustExec(
      this.exec,
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state,headRefName,headRefOid', '--limit', '1'],
      { cwd: repoPath },
    );
    const [pr] = JSON.parse(out) as { number: number; url: string; state: PrInfo['state']; headRefName: string; headRefOid?: string }[];
    if (!pr) return undefined;
    let checks: PrInfo['checks'] = 'none';
    let failedChecks: string[] = [];
    if (pr.state === 'OPEN') {
      const r = await this.exec('gh', ['pr', 'checks', String(pr.number), '--json', 'name,bucket'], { cwd: repoPath });
      try {
        const list = JSON.parse(r.stdout || '[]') as { name: string; bucket: string }[];
        checks = aggregateChecks(list.map((c) => c.bucket));
        failedChecks = list.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name);
      } catch {
        checks = 'none';
      }
    }
    return { number: pr.number, url: pr.url, state: pr.state, branch: pr.headRefName, ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}), checks, failedChecks };
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
