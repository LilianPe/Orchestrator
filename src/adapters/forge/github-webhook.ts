import { githubActor } from '../../core/authz.js';
import { TRUSTED, type CiRunPayload, type FactoryEvent, type PrPayload, type PushedCommit, type Taint, type TicketState } from '../../core/types.js';
import { verifyLinearSignature } from '../tracker/linear/webhook.js';
import { checkRunBucket } from './github-app.js';
import { isFactoryCheck, type PrInfo } from './types.js';

/**
 * `X-Hub-Signature-256` is `sha256=<hex HMAC-SHA256 of the raw body>`: the HMAC Linear signs with, under a
 * prefix. An empty secret refuses everything: anyone could sign with it.
 */
export function verifyGithubSignature(raw: string, header: string | undefined, secret: string): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header ?? '');
  return !!m && verifyLinearSignature(raw, m[1], secret);
}

/**
 * Id of a fact on a ticket's PR: the webhook and `PrPoller` name the same fact the same way, so the
 * inbox keeps it once whichever reports it first (ORC-134).
 */
export function prEventId(ticketId: string, prNumber: number, fact: 'opened' | 'merged' | 'closed'): string {
  return `pr:${ticketId}:${prNumber}:${fact}`;
}

/** Id of a checks verdict on a PR's head, shared by the webhook and `PrPoller` as `prEventId` is. */
export function checksEventId(ticketId: string, prNumber: number, verdict: PrInfo['checks'], head: string): string {
  return `pr:${ticketId}:${prNumber}:checks:${verdict}:${head}`;
}

export interface GithubMapContext {
  /**
   * The ticket the factory tracks on `branch` of repository `repo` (`owner/name`): matched as `PrPoller`
   * matches it (the ticket's branch), within the project whose repository sent the webhook.
   */
  ticketForBranch(repo: string, branch: string): Promise<TicketState | undefined>;
  /** The ticket the factory tracks whose PR is `number` in repository `repo` (ORC-278). */
  ticketForPr(repo: string, number: number): Promise<TicketState | undefined>;
  /** The ticket and PR whose journaled merge has `sha` as merge commit or head, in a project of `repo` (ORC-278). */
  mergedPrOf(repo: string, sha: string): Promise<{ ticket: TicketState; number: number } | undefined>;
  /** The ticket's PR as the forge reads it now: the verdict of all its checks, which one webhook does not carry. */
  findPr(ticket: TicketState): Promise<PrInfo | undefined>;
  now(): number;
  /** The factory's GitHub App, whose check runs are its own verdict (ORC-353); without it, they are known by their name. */
  factoryAppId?: string;
}

/** `ticket`: the ticket of this event when a webhook concerns several (a push on the default branch). */
/** `actor`: the signed author, as `githubActor` names a GitHub login (ORC-190). */
type Draft = { id: string; type: FactoryEvent['type']; payload: unknown; taint?: Taint; ticket?: TicketState; actor?: string };
type Mapped = { ticket?: TicketState; events: Draft[] };

const NOTHING: Mapped = { events: [] };
const isBot = (user: any): boolean => user?.type === 'Bot';
const isPr = (pr: any): boolean => typeof pr?.number === 'number' && typeof pr.head?.ref === 'string' && typeof pr.head.sha === 'string';

function prPayload(pr: any): PrPayload {
  return { number: pr.number, url: pr.html_url, branch: pr.head.ref };
}

/** `pr.opened` first when the ticket does not know this PR yet, as `PrPoller` does. */
function opened(t: TicketState, payload: PrPayload): Draft[] {
  return t.prNumber === payload.number ? [] : [{ id: prEventId(t.ticketId, payload.number, 'opened'), type: 'pr.opened', payload }];
}

function pullRequest(body: any, t: TicketState): Draft[] {
  const pr = body.pull_request;
  const payload = prPayload(pr);
  const n = payload.number;
  // An old PR of the branch, closed before the ticket's current one: what happens to it says nothing of the ticket.
  if (t.prNumber !== undefined && t.prNumber !== n && pr.state !== 'open') return [];
  if (body.action === 'reopened' && t.prNumber === n) {
    // Same PR, open again: `pr.opened` takes it back from `CLOSED`; the id is per reopening.
    return [{ id: `pr:${t.ticketId}:${n}:reopened:${pr.updated_at ?? body.action}`, type: 'pr.opened', payload }];
  }
  const out = opened(t, payload);
  if (body.action === 'closed') {
    // Per closing, so that a PR reopened then closed again is cancelled again; `PrPoller` keeps `:closed`.
    // The merge commit and the head merged, what a revert on the default branch names, and when GitHub merged it (ORC-278).
    const mergedAt = Date.parse(pr.merged_at);
    const shas = {
      ...(typeof pr.merge_commit_sha === 'string' ? { mergeSha: pr.merge_commit_sha } : {}),
      headSha: pr.head.sha,
      ...(Number.isFinite(mergedAt) ? { mergedAt } : {}),
    };
    out.push(
      pr.merged
        ? { id: prEventId(t.ticketId, n, 'merged'), type: 'pr.merged', payload: { ...payload, ...shas } }
        : { id: `${prEventId(t.ticketId, n, 'closed')}:${pr.closed_at ?? ''}`, type: 'pr.closed', payload },
    );
    return out;
  }
  // GitHub computes mergeability after the event: `dirty` is seen on the events that come once it is known.
  if (pr.state === 'open' && pr.mergeable_state === 'dirty') {
    out.push({
      id: `pr:${t.ticketId}:${n}:conflicted:${pr.head.sha}:${pr.base?.sha}`,
      type: 'pr.conflicted',
      payload: { ...payload, headSha: pr.head.sha, baseRef: pr.base?.ref },
    });
  }
  return out;
}

/** The tracked PR a check reports on: GitHub lists every open PR whose head is the checked commit. */
async function checkedPr(repo: string, check: any, ctx: GithubMapContext): Promise<{ ticket: TicketState; ref: any } | undefined> {
  for (const ref of Array.isArray(check?.pull_requests) ? check.pull_requests : []) {
    if (typeof ref?.number !== 'number' || typeof ref.head?.ref !== 'string') continue;
    const ticket = await ctx.ticketForBranch(repo, ref.head.ref);
    if (ticket) return { ticket, ref };
  }
  return undefined;
}

/**
 * A completed check run or suite. Its verdict is the PR's as the forge reads all its checks on that head
 * (as `PrPoller` reads it): one green suite is not a green PR, and a cancelled run may have a newer
 * attempt. Red does not wait on GitHub, though: when the forge does not answer, the failed check is
 * reported alone.
 */
async function checks(body: any, kind: 'check_run' | 'check_suite', repo: string, ctx: GithubMapContext): Promise<Mapped> {
  const check = body[kind];
  if (body.action !== 'completed' || typeof check?.head_sha !== 'string') return NOTHING;
  // The factory's own verdict is no CI; its check suite, named by no check, the forge's reading below leaves out.
  if (kind === 'check_run' && isFactoryCheck({ name: check.name ?? '', app: check.app }, ctx.factoryAppId)) return NOTHING;
  const found = await checkedPr(repo, check, ctx);
  if (!found) return NOTHING;
  const { ticket: t, ref } = found;
  // A report on a head the PR has left behind says nothing of the PR.
  const head: string = check.head_sha;
  if (ref.head.sha !== head) return NOTHING;
  const bucket = checkRunBucket({ status: 'completed', conclusion: check.conclusion });
  if (bucket !== 'fail' && bucket !== 'pass') return NOTHING;
  const payload: PrPayload = { number: ref.number, url: `${body.repository?.html_url}/pull/${ref.number}`, branch: ref.head.ref };
  let pr: PrInfo | undefined;
  try {
    pr = await ctx.findPr(t);
  } catch (err) {
    if (bucket === 'pass') throw err;
  }
  // The PR as the forge reads it on this head; undefined when it read nothing, or another PR or head.
  const live = pr?.number === payload.number && pr.state === 'OPEN' && (!pr.headSha || pr.headSha === head) ? pr : undefined;
  // Red without a reading of the forge is reported; green never is.
  if (live ? live.checks !== bucket : bucket === 'pass') return NOTHING;
  const read = live ? { ...payload, url: live.url } : payload;
  const name: string = kind === 'check_run' ? check.name : (check.app?.name ?? 'check suite');
  const verdict: Draft =
    bucket === 'fail'
      ? { id: checksEventId(t.ticketId, read.number, 'fail', head), type: 'pr.checks_failed', payload: { ...read, failures: live?.failedChecks.length ? live.failedChecks : [name] } }
      : { id: checksEventId(t.ticketId, read.number, 'pass', head), type: 'pr.checks_passed', payload: read };
  return { ticket: t, events: [...opened(t, read), verdict] };
}

function push(body: any, t: TicketState, branch: string): Draft[] {
  // A deleted branch, or a push by a bot (the factory's GitHub App among them), is no human commit.
  if (body.deleted || isBot(body.sender) || typeof body.after !== 'string') return [];
  const author: string = body.sender?.login ?? body.pusher?.name ?? 'inconnu';
  return [
    {
      id: `push:${t.ticketId}:${body.after}`,
      type: 'push.human',
      // What the push brought was verified by no one in the factory (I12).
      taint: 'untrusted',
      // `before`: so that only the commits of this push are the human's (ORC-338).
      payload: { branch, sha: body.after, author, ...(typeof body.before === 'string' ? { before: body.before } : {}) },
    },
  ];
}

/** Subjects GitHub writes when it merges PR `#n`: a merge commit, or `<title> (#n)` for a squash. */
const MERGE_COMMIT = /^Merge pull request #(\d+) from /;
const SQUASH = /\(#(\d+)\)$/;
/** `git revert`, and the revert GitHub's button commits: `This reverts commit <full sha>`. */
const REVERTS_SHA = /\bThis reverts commit ([0-9a-f]{40})\b/gi;
/** The body of a PR opened by GitHub's revert button, kept in its squash commit: `Reverts owner/name#n`. */
const REVERTS_PR = /^Reverts ([\w.-]+\/[\w.-]+)#(\d+)\b/gm;

type TicketPr = { ticket: TicketState; number: number };
type Commit = { sha: string; message: string; author: string; byGithub: boolean };
/**
 * How a commit lands a factory PR: `merge`, a merge commit, brings the PR's own commits along; `rebase`,
 * found by its journaled merge or head commit, is one of them; `squash` is alone.
 */
type Landing = TicketPr & { how: 'merge' | 'squash' | 'rebase' };

/** `f`, asked once per key. */
function once<K, V>(f: (k: K) => Promise<V>): (k: K) => Promise<V> {
  const asked = new Map<K, Promise<V>>();
  return (k) => {
    let v = asked.get(k);
    if (!v) asked.set(k, (v = f(k)));
    return v;
  };
}

/** The lookups of one push, each asked once however many commits name the same PR or SHA. */
function memo(repo: string, ctx: GithubMapContext) {
  return { ticketForPr: once((n: number) => ctx.ticketForPr(repo, n)), mergedPrOf: once((sha: string) => ctx.mergedPrOf(repo, sha)) };
}
type Lookups = ReturnType<typeof memo>;

/**
 * The tracked ticket and PR a commit of the default branch lands, when known: by the subject GitHub wrote
 * (committed by GitHub itself, `web-flow`: a subject a human or an agent typed is not read), else by the
 * journaled merge or head commit of the PR.
 */
async function landing(c: Commit, look: Lookups): Promise<Landing | undefined> {
  const subject = c.message.split('\n', 1)[0]!.trim();
  const merge = c.byGithub ? MERGE_COMMIT.exec(subject) : null;
  const squash = c.byGithub && !merge ? SQUASH.exec(subject) : null;
  const n = merge?.[1] ?? squash?.[1];
  if (n !== undefined) {
    const ticket = await look.ticketForPr(Number(n));
    if (ticket) return { ticket, number: Number(n), how: merge ? 'merge' : 'squash' };
  }
  const found = await look.mergedPrOf(c.sha);
  return found && { ...found, how: 'rebase' };
}

/** The tracked tickets and merged PRs a commit's message says it reverts, each once. */
async function revertedPrs(repo: string, message: string, look: Lookups): Promise<TicketPr[]> {
  const out = new Map<string, TicketPr>();
  const keep = (pr: TicketPr) => out.set(`${pr.ticket.projectId}:${pr.ticket.ticketId}:${pr.number}`, pr);
  for (const [, sha] of message.matchAll(REVERTS_SHA)) {
    const found = await look.mergedPrOf(sha!.toLowerCase());
    if (found) keep(found);
  }
  for (const [, named, n] of message.matchAll(REVERTS_PR)) {
    if (named!.toLowerCase() !== repo.toLowerCase()) continue;
    const ticket = await look.ticketForPr(Number(n));
    if (ticket) keep({ ticket, number: Number(n) });
  }
  return [...out.values()];
}

/**
 * A push on the repository's default branch (ORC-278): one `default_branch.pushed` per tracked ticket it
 * concerns, with the commits that land its PR (`merges`) or revert one of its merged PRs (`reverts`).
 * A commit that lands a factory PR is the agent's work (a squash keeps its commit messages): no revert
 * is read in it. A merge commit or a rebase of a factory PR brings that PR's own commits along: no
 * revert is read in the whole push. The messages are kept as written; only the numbers resolved here
 * are measured.
 */
async function defaultBranchPush(body: any, repo: string, ctx: GithubMapContext): Promise<Mapped> {
  if (body.deleted || typeof body.after !== 'string' || !Array.isArray(body.commits)) return NOTHING;
  const commits: Commit[] = (body.commits as any[])
    .filter((c) => typeof c?.id === 'string' && typeof c.message === 'string')
    .map((c) => ({
      sha: c.id,
      message: c.message,
      author: String(c.author?.username ?? c.author?.name ?? 'inconnu'),
      byGithub: c.committer?.username === 'web-flow',
    }));
  const look = memo(repo, ctx);
  const concerned = new Map<string, { ticket: TicketState; commits: PushedCommit[] }>();
  const add = ({ ticket }: TicketPr, { byGithub: _, ...c }: Commit, relation: Pick<PushedCommit, 'merges' | 'reverts'>) => {
    const key = `${ticket.projectId}:${ticket.ticketId}`;
    const entry = concerned.get(key) ?? { ticket, commits: [] };
    entry.commits.push({ ...c, ...relation });
    concerned.set(key, entry);
  };
  const landed = new Map<string, Landing>();
  for (const c of commits) {
    const pr = await landing(c, look);
    if (pr) landed.set(c.sha, pr);
  }
  const bringsAgentCommits = [...landed.values()].some((l) => l.how !== 'squash');
  for (const c of commits) {
    const pr = landed.get(c.sha);
    if (pr) add(pr, c, { merges: pr.number });
    else if (!bringsAgentCommits) for (const reverted of await revertedPrs(repo, c.message, look)) add(reverted, c, { reverts: reverted.number });
  }
  const pushedAt = typeof body.repository?.pushed_at === 'number' ? body.repository.pushed_at * 1000 : undefined;
  const branch = String(body.ref).slice('refs/heads/'.length);
  const events: Draft[] = [...concerned.values()].map(({ ticket, commits: mine }) => ({
    id: `default-branch:${ticket.ticketId}:${body.after}`,
    type: 'default_branch.pushed',
    // Commit messages are written by whoever commits, the agent among them.
    taint: 'untrusted',
    ticket,
    payload: { branch, before: String(body.before ?? ''), after: body.after, ...(pushedAt === undefined ? {} : { pushedAt }), commits: mine },
  }));
  return { events };
}

/**
 * A completed attempt of a workflow run on a tracked ticket's branch (ORC-278), for its CI cost. Its
 * duration is `run_started_at` (start of this attempt) to `updated_at` (its completion, on this
 * webhook): the webhook carries both, so no API call is made.
 */
async function workflowRun(body: any, repo: string, ctx: GithubMapContext): Promise<Mapped> {
  const run = body.workflow_run;
  if (body.action !== 'completed' || typeof run?.id !== 'number' || typeof run.head_branch !== 'string' || typeof run.head_sha !== 'string') return NOTHING;
  // A run of a fork (or of a deleted one, `head_repository: null`), whose branch may bear a ticket's name, is not the factory's CI.
  if (String(run.head_repository?.full_name).toLowerCase() !== repo.toLowerCase()) return NOTHING;
  const startedAt = Date.parse(run.run_started_at);
  const completedAt = Date.parse(run.updated_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return NOTHING;
  const ticket = await ctx.ticketForBranch(repo, run.head_branch);
  if (!ticket) return NOTHING;
  const attempt = typeof run.run_attempt === 'number' ? run.run_attempt : 1;
  const listed = (Array.isArray(run.pull_requests) ? run.pull_requests : []).find((p: any) => typeof p?.number === 'number' && p.head?.ref === run.head_branch);
  // Without a PR listed by GitHub, the ticket's PR if it is open: a closed one is not what the run tests.
  const number: number | undefined = listed?.number ?? (ticket.prState === 'OPEN' ? ticket.prNumber : undefined);
  const payload: CiRunPayload = {
    ...(number === undefined ? {} : { number }),
    branch: run.head_branch,
    headSha: run.head_sha,
    runId: run.id,
    attempt,
    workflow: String(run.name ?? ''),
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
  };
  // One per run and attempt: a redelivery, or the same attempt reported again, is a duplicate in the inbox.
  return { ticket, events: [{ id: `ci:${ticket.ticketId}:${run.id}:${attempt}`, type: 'ci.run_completed', taint: 'untrusted', payload }] };
}

function review(body: any, t: TicketState, kind: 'review' | 'comment'): Draft[] {
  const item = kind === 'review' ? body.review : body.comment;
  if (!item?.id || isBot(item.user) || isBot(body.sender)) return [];
  const text: string = item.body ?? '';
  const where = kind === 'comment' && item.path ? `${item.path}${item.line ? `:${item.line}` : ''} — ` : '';
  return [
    {
      id: `pr:${t.ticketId}:${body.pull_request.number}:${kind}:${item.id}`,
      type: 'pr.reviewed',
      // Written by whoever can review the PR.
      taint: 'untrusted',
      // The sender of the signed body: the matrix checks its rights on the repository before the review is fed back (ORC-190).
      ...(typeof body.sender?.login === 'string' ? { actor: githubActor(body.sender.login) } : {}),
      payload: {
        ...prPayload(body.pull_request),
        kind,
        author: item.user?.login ?? 'inconnu',
        body: `${where}${text}`,
        ...(kind === 'review' && item.state ? { state: String(item.state) } : {}),
      },
    },
  ];
}

/** The ticket the webhook is about, and its events; nothing for a branch the factory does not track. */
async function partials(name: string, body: any, ctx: GithubMapContext): Promise<Mapped> {
  const repo = body?.repository?.full_name;
  if (typeof repo !== 'string') return NOTHING;
  if (name === 'check_run' || name === 'check_suite') return checks(body, name, repo, ctx);
  if (name === 'workflow_run') return workflowRun(body, repo, ctx);
  const defaultBranch = body.repository?.default_branch;
  if (name === 'push' && typeof defaultBranch === 'string' && body.ref === `refs/heads/${defaultBranch}`) return defaultBranchPush(body, repo, ctx);
  let branch: string | undefined;
  if (name === 'push') {
    const ref = body.ref;
    if (typeof ref === 'string' && ref.startsWith('refs/heads/')) branch = ref.slice('refs/heads/'.length);
  } else if ((name === 'pull_request' || name === 'pull_request_review' || name === 'pull_request_review_comment') && isPr(body.pull_request)) {
    branch = body.pull_request.head.ref;
  }
  const ticket = branch ? await ctx.ticketForBranch(repo, branch) : undefined;
  if (!ticket) return NOTHING;
  switch (name) {
    case 'push':
      return { ticket, events: push(body, ticket, branch!) };
    case 'pull_request':
      return { ticket, events: pullRequest(body, ticket) };
    case 'pull_request_review':
      return { ticket, events: body.action === 'submitted' ? review(body, ticket, 'review') : [] };
    default:
      return { ticket, events: body.action === 'created' ? review(body, ticket, 'comment') : [] };
  }
}

/**
 * Events of a GitHub webhook, named by `X-GitHub-Event` (ORC-134). Ids come from the signed body (PR
 * number, head SHA, review or comment id), never from `X-GitHub-Delivery`, which the signature does
 * not cover: a replayed body, or the same fact reported by `PrPoller`, has the id the inbox already holds.
 * Only branches of tickets the factory tracks, in their project's repository, are read; anything else,
 * a body of another shape included, maps to nothing.
 */
export async function mapGithubWebhook(name: string, body: any, ctx: GithubMapContext): Promise<FactoryEvent[]> {
  const { ticket, events } = await partials(name, body, ctx);
  const at = ctx.now();
  return events.flatMap(({ id, type, payload, taint, ticket: own, actor }) => {
    const t = own ?? ticket;
    return t ? [{ ...TRUSTED, ...(taint ? { taint } : {}), ...(actor ? { actor } : {}), id, type, at, projectId: t.projectId, ticketId: t.ticketId, payload } as FactoryEvent] : [];
  });
}
