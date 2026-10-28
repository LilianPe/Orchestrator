import { createHmac, timingSafeEqual } from 'node:crypto';
import { TRUSTED, type FactoryEvent, type PrPayload, type Taint, type TicketState } from '../../core/types.js';
import { isUsableWebhookSecret } from '../tracker/linear/webhook.js';
import { checkRunBucket } from './github-app.js';
import type { PrInfo } from './types.js';

/**
 * `X-Hub-Signature-256` is `sha256=<hex HMAC-SHA256 of the raw body>`, compared in constant time as
 * `verifyLinearSignature` does. An empty secret refuses everything: anyone could sign with it.
 */
export function verifyGithubSignature(raw: string, header: string | undefined, secret: string): boolean {
  if (!isUsableWebhookSecret(secret) || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header);
  if (!m) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(Buffer.from(m[1]!, 'hex'), expected);
}

/**
 * Id of a checks verdict on a PR's head: the webhook and `PrPoller` give the same verdict on the same
 * head the same id, so the inbox keeps it once whichever reports it first (ORC-134).
 */
export function checksEventId(ticketId: string, prNumber: number, verdict: 'pass' | 'fail' | 'pending' | 'none', head: string): string {
  return `pr:${ticketId}:${prNumber}:checks:${verdict}:${head}`;
}

export interface GithubMapContext {
  /** The ticket the factory tracks on `branch`, matched as `PrPoller` matches it (the ticket's branch). */
  ticketForBranch(branch: string): Promise<TicketState | undefined>;
  /** The ticket's PR as the forge reads it now: the verdict of all its checks, which one webhook does not carry. */
  findPr(ticket: TicketState): Promise<PrInfo | undefined>;
  now(): number;
}

type Draft = { id: string; type: FactoryEvent['type']; payload: unknown; taint?: Taint };

const isBot = (user: any): boolean => user?.type === 'Bot';

function prPayload(pr: any): PrPayload {
  return { number: pr.number, url: pr.html_url, branch: pr.head.ref };
}

/** `pr.opened` first when the ticket does not know this PR yet, as `PrPoller` does. */
function opened(t: TicketState, payload: PrPayload): Draft[] {
  return t.prNumber === payload.number ? [] : [{ id: `pr:${t.ticketId}:${payload.number}:opened`, type: 'pr.opened', payload }];
}

function pullRequest(body: any, t: TicketState): Draft[] {
  const pr = body.pull_request;
  const payload = prPayload(pr);
  const out = opened(t, payload);
  const n = payload.number;
  if (body.action === 'closed') {
    out.push(
      pr.merged
        ? { id: `pr:${t.ticketId}:${n}:merged`, type: 'pr.merged', payload }
        : { id: `pr:${t.ticketId}:${n}:closed`, type: 'pr.closed', payload },
    );
    return out;
  }
  // GitHub computes mergeability after the event: `dirty` is seen on the events that come once it is known.
  if (pr.state === 'open' && pr.mergeable_state === 'dirty') {
    out.push({
      id: `pr:${t.ticketId}:${n}:conflicted:${pr.head.sha}:${pr.base.sha}`,
      type: 'pr.conflicted',
      payload: { ...payload, headSha: pr.head.sha, baseRef: pr.base.ref },
    });
  }
  return out;
}

/** A completed check run or suite: red as soon as one fails; green only once the forge reads all of them green. */
async function checks(body: any, kind: 'check_run' | 'check_suite', ctx: GithubMapContext): Promise<{ ticket?: TicketState; events: Draft[] }> {
  if (body.action !== 'completed') return { events: [] };
  const check = body[kind];
  const ref = check.pull_requests?.[0];
  const t = ref?.head?.ref ? await ctx.ticketForBranch(ref.head.ref) : undefined;
  return t ? { ticket: t, events: await verdict(body, kind, check, ref, t, ctx) } : { events: [] };
}

async function verdict(body: any, kind: 'check_run' | 'check_suite', check: any, ref: any, t: TicketState, ctx: GithubMapContext): Promise<Draft[]> {
  // A report on a head the PR has left behind says nothing of the PR.
  const head: string = check.head_sha;
  if (ref.head?.sha !== head) return [];
  const bucket = checkRunBucket({ status: 'completed', conclusion: check.conclusion });
  const payload: PrPayload = { number: ref.number, url: `${body.repository.html_url}/pull/${ref.number}`, branch: ref.head.ref };
  if (bucket === 'fail') {
    const name: string = kind === 'check_run' ? check.name : (check.app?.name ?? 'check suite');
    return [
      ...opened(t, payload),
      { id: checksEventId(t.ticketId, payload.number, 'fail', head), type: 'pr.checks_failed', payload: { ...payload, failures: [name] } },
    ];
  }
  if (bucket !== 'pass') return [];
  // One green suite is not a green PR: the others may still run or fail.
  const pr = await ctx.findPr(t);
  if (!pr || pr.number !== payload.number || pr.state !== 'OPEN' || pr.checks !== 'pass' || (pr.headSha && pr.headSha !== head)) return [];
  const url = { ...payload, url: pr.url };
  return [...opened(t, url), { id: checksEventId(t.ticketId, payload.number, 'pass', head), type: 'pr.checks_passed', payload: url }];
}

function push(body: any, t: TicketState, branch: string): Draft[] {
  // A deleted branch, or a push by a bot (the factory's GitHub App among them), is no human commit.
  if (body.deleted || isBot(body.sender) || !body.after) return [];
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
  if (!item || isBot(item.user) || isBot(body.sender)) return [];
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
async function partials(name: string, body: any, ctx: GithubMapContext): Promise<{ ticket?: TicketState; events: Draft[] }> {
  if (name === 'check_run' || name === 'check_suite') return checks(body, name, ctx);
  let branch: string | undefined;
  if (name === 'push') {
    const ref: string = body.ref ?? '';
    if (ref.startsWith('refs/heads/')) branch = ref.slice('refs/heads/'.length);
  } else if (name === 'pull_request' || name === 'pull_request_review' || name === 'pull_request_review_comment') {
    branch = body.pull_request?.head?.ref;
  }
  const ticket = branch ? await ctx.ticketForBranch(branch) : undefined;
  if (!ticket) return { events: [] };
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
 * Only branches of tickets the factory tracks are read; anything else maps to nothing.
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
