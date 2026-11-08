import type { FeedbackItem } from '../../core/types.js';
import { execCmd, execFailure, mustExec, type Exec, type ExecResult } from '../exec.js';
import { isRecord } from '../graphql-pages.js';
import { unresolvedReviewFeedback, type GraphQl } from './review-threads.js';
import { REPO_PERMISSIONS, type RepoPermission, type RepoPermissions } from '../roles/types.js';
import { isFactoryCheck, MERGEABLE, type Forge, type PrInfo, type PrMergeState } from './types.js';

/**
 * A bucket outside pass/skipping/fail/cancel/pending (empty, or new) is never green: it reads as `pending` (ORC-303), so the
 * PR poller sends no `pr.checks_passed`, and a merge, which reads checks through `GitHubAppForge` (it shares this aggregate), refuses.
 */
export function aggregateChecks(buckets: string[]): PrInfo['checks'] {
  if (buckets.length === 0) return 'none';
  if (buckets.some((b) => b === 'fail' || b === 'cancel')) return 'fail';
  if (buckets.every((b) => b === 'pass' || b === 'skipping')) return 'pass';
  return 'pending';
}

/**
 * `gh pr checks` exits 1 with an empty stdout both for a PR without any check and for a failure (network,
 * auth); only this stderr line tells the first apart. Checks that fail or are pending still come as JSON.
 */
const NO_CHECKS = /^no checks reported on the '.*' branch$/m;
/** A gh older than 2.50 has no `--json` on `pr checks`: it answers this, then its usage, exit 1. */
const NO_JSON_FLAG = /^unknown flag: --json$/m;

type Check = { name: string; bucket: string };

const isCheck = (c: unknown): c is Check =>
  typeof c === 'object' && c !== null && typeof (c as Check).name === 'string' && typeof (c as Check).bucket === 'string';

const EXCERPT = 200;
/** The first EXCERPT code units of `s`, one less rather than half a character, `…` when cut. */
function cut(s: string): { head: string; more: string } {
  if (s.length <= EXCERPT) return { head: s, more: '' };
  const end = /[\uD800-\uDBFF]/.test(s[EXCERPT - 1]!) ? EXCERPT - 1 : EXCERPT;
  return { head: s.slice(0, end), more: '…' };
}
export const excerpt = (out: string) => {
  const { head, more } = cut(out);
  return JSON.stringify(head) + more;
};

/** The JSON in `out`, `undefined` when it is none. */
function parseJson(out: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

/**
 * The checks `gh pr checks --json name,bucket` lists. Output that is not such a list throws, never reads as
 * `none`, a PR without CI, for which the PR poller sends no checks event (ORC-305). It logs the error and retries.
 */
function parseChecks(args: string[], r: ExecResult): Check[] {
  const list = parseJson(r.stdout);
  if (Array.isArray(list) && list.every(isCheck)) return list;
  const stderr = cut(r.stderr.trim());
  const exit = r.code === 0 && !stderr.head ? '' : ` (exit ${r.code}${stderr.head && `: ${stderr.head}${stderr.more}`})`;
  throw new Error(`gh ${args.join(' ')}: unreadable output, not a list of checks: ${excerpt(r.stdout)}${exit}`);
}

/**
 * What `GET /repos/{owner}/{repo}/collaborators/{user}/permission` answers (ORC-186): its `role_name`
 * when it is a known one (`maintain`, `triage`), else the base `permission` (a custom role keeps its base).
 */
export function toRepoPermission(dto: { permission?: string; role_name?: string } | undefined): RepoPermission {
  const known = (v: string | undefined) => REPO_PERMISSIONS.find((p) => p === v);
  return known(dto?.role_name) ?? known(dto?.permission) ?? 'none';
}

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
      if (r.code !== 0 && r.stdout.trim() === '') {
        if (!NO_CHECKS.test(r.stderr)) {
          if (NO_JSON_FLAG.test(r.stderr)) throw new Error(`gh ${args.join(' ')}: this gh has no --json on pr checks, gh 2.50 or later is required`);
          throw execFailure('gh', args, r);
        }
      } else {
        const list = parseChecks(args, r).filter((c) => !isFactoryCheck(c.name));
        checks = aggregateChecks(list.map((c) => c.bucket));
        failedChecks = list.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name);
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

  async mergeState(repoPath: string, prNumber: number): Promise<PrMergeState> {
    const out = await mustExec(this.exec, 'gh', ['pr', 'view', String(prNumber), '--json', 'baseRefName,mergeable,mergeStateStatus'], { cwd: repoPath });
    const v = JSON.parse(out) as { baseRefName?: unknown; mergeable?: unknown; mergeStateStatus?: unknown };
    if (typeof v.baseRefName !== 'string' || !v.baseRefName) throw new Error(`gh pr view ${prNumber}: no base branch`);
    if (!MERGEABLE.includes(v.mergeable as PrMergeState['mergeable'])) throw new Error(`gh pr view ${prNumber}: unknown mergeable ${JSON.stringify(v.mergeable)}`);
    return { base: v.baseRefName, mergeable: v.mergeable as PrMergeState['mergeable'], status: typeof v.mergeStateStatus === 'string' && v.mergeStateStatus ? v.mergeStateStatus.toUpperCase() : 'UNKNOWN' };
  }

  async unresolvedReviewComments(repoPath: string, prNumber: number): Promise<FeedbackItem[]> {
    const repo = JSON.parse(await mustExec(this.exec, 'gh', ['repo', 'view', '--json', 'owner,name'], { cwd: repoPath })) as {
      owner: { login: string };
      name: string;
    };
    // Every page of threads and of their comments (ORC-347). A cursor or a name goes as a string (`-f`): `-F` would
    // turn `null`, `true` or digits into JSON. GraphQL errors make gh exit non-zero.
    const gql: GraphQl = async <T>(query: string, variables: Record<string, unknown>, isData: (d: unknown) => d is T, what: string) => {
      const fields = Object.entries(variables).flatMap(([k, v]) => (v === null ? [] : [typeof v === 'number' ? '-F' : '-f', `${k}=${String(v)}`]));
      const out = await mustExec(this.exec, 'gh', ['api', 'graphql', '-f', `query=${query}`, ...fields], { cwd: repoPath });
      const answer = parseJson(out);
      const data = isRecord(answer) ? answer.data : undefined;
      if (!isData(data)) throw new Error(`gh api graphql: unreadable output, not ${what}: ${excerpt(out)}`);
      return data;
    };
    return unresolvedReviewFeedback(gql, repo.owner.login, repo.name, prNumber);
  }
}
