import { TRUSTED, type FactoryEvent, type PrPayload, type Taint, type TicketState } from '../../core/types.js';
import { verifyLinearSignature } from '../tracker/linear/webhook.js';
import { checkRunBucket } from './github-app.js';
import type { PrInfo } from './types.js';

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
  /** The ticket's PR as the forge reads it now: the verdict of all its checks, which one webhook does not carry. */
  findPr(ticket: TicketState): Promise<PrInfo | undefined>;
  now(): number;
}

type Draft = { id: string; type: FactoryEvent['type']; payload: unknown; taint?: Taint };
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
    out.push(
      pr.merged
        ? { id: prEventId(t.ticketId, n, 'merged'), type: 'pr.merged', payload }
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
      payload: { branch, sha: body.after, author },
    },
  ];
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
  if (!ticket) return [];
  const at = ctx.now();
  return events.map(
    ({ id, type, payload, taint }) =>
      ({ ...TRUSTED, ...(taint ? { taint } : {}), id, type, at, projectId: ticket.projectId, ticketId: ticket.ticketId, payload }) as FactoryEvent,
  );
}
