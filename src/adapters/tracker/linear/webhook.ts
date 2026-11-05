import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { REFREEZE } from '../../../checks/freeze.js';
import { labelEchoKey, stateEchoKey } from '../types.js';
import { labelChanges, type KnownLabels } from './labels.js';
import { SCHEMA_VERSION, type LogicalState, type FactoryEvent, type Taint } from '../../../core/types.js';

export function isUsableWebhookSecret(secret: unknown): boolean {
  return typeof secret === 'string' && secret.trim() !== '';
}

export function verifyLinearSignature(raw: string, signature: string | undefined, secret: string): boolean {
  if (!isUsableWebhookSecret(secret) || !signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const FRESHNESS_MS = 60_000;

export function isFresh(body: { webhookTimestamp?: number }, now: number): boolean {
  return typeof body.webhookTimestamp === 'number' && Math.abs(now - body.webhookTimestamp) <= FRESHNESS_MS;
}

export interface MapContext {
  projectIdForTeam(teamKey: string): string | undefined;
  logicalFor(projectId: string, stateName: string): LogicalState | null;
  stateNameById(teamKey: string, stateId: string): string | undefined;
  /** Linear type of a state (`canceled`, `completed`…), from the team's cache. */
  stateTypeById(teamKey: string, stateId: string): string | undefined;
  labelNameById(teamKey: string, labelId: string): string | undefined;
  /** May read the store, hence the promise. */
  isEcho(key: string): boolean | Promise<boolean>;
  commands(projectId: string): string[];
  now(): number;
  /** The ticket's labels as the factory last read them, and when (ORC-185); undefined when it never did. */
  knownLabels?(projectId: string, identifier: string): Promise<KnownLabels | undefined>;
  /** Records the ticket's labels as known at `at` (an issue's `updatedAt`), once the webhook's events are in the inbox. */
  recordLabels?(projectId: string, identifier: string, labels: string[], at: number): Promise<void>;
}

export function stripMention(body: string): string {
  return body.replace(/^\s*(\[@[^\]]*\]\([^)]*\)|@\S+)\s*/, '').trim();
}

type PartialEvent = { type: FactoryEvent['type']; payload: unknown; suffix?: string };

/** Who did what a webhook reports, as the signed body says it. */
export interface SignedActor {
  /** Linear id of the workspace user who did it; absent when Linear names none (then `untrusted`). */
  id?: string;
  taint: Taint;
  /** The author's name, for messages: taken from the same object as `id`. */
  name: string;
}

const idOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Who wrote what a session webhook carries: the reply, the comment that opened the session, or its creator. */
function sessionAuthor(body: any): { id?: string; name?: string; external: boolean } {
  const s = body.agentSession ?? {};
  const [obj, id] =
    body.action === 'prompted'
      ? [body.agentActivity, idOf(body.agentActivity?.user?.id) ?? idOf(body.agentActivity?.userId)]
      : s.comment
        ? [s.comment, idOf(s.comment.user?.id) ?? idOf(s.comment.userId)]
        : [s, idOf(s.creator?.id) ?? idOf(s.creatorId)];
  const name = obj?.user?.name ?? obj?.creator?.name;
  return { id, name, external: !!(obj?.botActor || obj?.externalUser || obj?.externalUserId) };
}

/**
 * The actor of a signed webhook (ORC-160). Trusted, with its id, only when Linear names a workspace
 * user as the author: a reply or a mention by a member, a delegation, a change made in Linear by a
 * user. Untrusted, without an id, when no user is named, when an integration or an OAuth app did it
 * (`actor.type`), or when the comment came through a bot or from outside the workspace (`botActor`,
 * `externalUser`: Slack, email, customer requests). Who may do what is ORC-186's matrix, checked on
 * this id: an untrusted event has none to borrow.
 */
export function signedActor(body: any): SignedActor {
  let id: string | undefined;
  let name: string | undefined;
  if (body?.type === 'AgentSessionEvent') {
    const a = sessionAuthor(body);
    id = a.external ? undefined : a.id;
    name = a.name;
  } else {
    id = body?.actor?.type === 'user' ? idOf(body.actor.id) : undefined;
    name = body?.actor?.name;
  }
  return id ? { id, taint: 'trusted', name: name ?? 'Humain' } : { taint: 'untrusted', name: name ?? 'Humain' };
}

/** The first word of a comment, without its mention, as a command's name, and the rest as its body. */
function parseCommand(text: string): { name: string; body: string } {
  const [first = '', ...rest] = text.split(/\s+/);
  return { name: first.toLowerCase(), body: rest.join(' ') };
}

function sessionEvents(body: any, author: string, projectId: string, ctx: MapContext): PartialEvent[] {
  const sessionId: string = body.agentSession.id;
  if (body.action === 'created') {
    const comment = body.agentSession.comment;
    if (!comment) return [{ type: 'ticket.delegated', payload: { linearSessionId: sessionId, promptContext: body.promptContext } }];
    const text = stripMention(comment.body ?? '');
    const command = parseCommand(text);
    // `/refreeze` is the factory's own (ORC-131), not a workflow rule's.
    if ([REFREEZE, ...ctx.commands(projectId)].includes(command.name)) {
      return [{ type: 'command', payload: { ...command, linearSessionId: sessionId, author } }];
    }
    return [{ type: 'session.mentioned', payload: { linearSessionId: sessionId, body: text, author } }];
  }
  if (body.action === 'prompted') {
    if (body.agentActivity?.signal === 'stop') return [{ type: 'session.stopped', payload: { linearSessionId: sessionId } }];
    const reply: string = body.agentActivity?.content?.body ?? '';
    // A blocked ticket's thread asks for a reply: `/refreeze` there is the command, not feedback that relaunches the agent.
    const command = parseCommand(stripMention(reply));
    if (command.name === REFREEZE) return [{ type: 'command', payload: { ...command, linearSessionId: sessionId, author } }];
    return [{ type: 'session.prompted', payload: { linearSessionId: sessionId, body: reply, author } }];
  }
  return [];
}

async function issueEvents(body: any, identifier: string, teamKey: string, projectId: string, ctx: MapContext): Promise<PartialEvent[]> {
  if (body.action !== 'update') return [];
  const out: PartialEvent[] = [];
  const data = body.data ?? {};
  const from = body.updatedFrom ?? {};
  if (from.stateId !== undefined) {
    const toName: string | undefined = data.state?.name ?? ctx.stateNameById(teamKey, data.stateId);
    const fromName = ctx.stateNameById(teamKey, from.stateId);
    if (toName && !(await ctx.isEcho(stateEchoKey(identifier, toName)))) {
      out.push({
        type: 'status.changed',
        payload: {
          from: fromName ? ctx.logicalFor(projectId, fromName) : null,
          to: ctx.logicalFor(projectId, toName),
          ...((data.state?.type ?? ctx.stateTypeById(teamKey, data.stateId)) === 'canceled' ? { cancelled: true as const } : {}),
        },
      });
    }
  }
  if (Array.isArray(from.labelIds) && Array.isArray(data.labelIds)) {
    const changes = labelChanges(from.labelIds as string[], data.labelIds as string[]).map(({ label: id, change }) => ({ id, change }));
    // A change the factory already knows was caught up by the reconciliation first (ORC-185).
    const known = changes.length ? await ctx.knownLabels?.(projectId, identifier) : undefined;
    for (const { id, change } of changes) {
      const name = ctx.labelNameById(teamKey, id);
      if (name && known && known.labels.includes(name) === (change === 'added')) continue;
      if (name && !(await ctx.isEcho(labelEchoKey(identifier, name, change)))) {
        out.push({ type: 'label.changed', payload: { label: name, change }, suffix: `:label:${id}` });
      }
    }
  }
  return out;
}

function issueIdentifier(body: any): string | undefined {
  if (body?.type === 'AgentSessionEvent') return body.agentSession?.issue?.identifier;
  if (body?.type === 'Issue') return body.data?.identifier ?? (body.data?.team?.key ? `${body.data.team.key}-${body.data.number}` : undefined);
  return undefined;
}

/**
 * Applies an issue webhook's own label changes to the labels the factory knows (ORC-185), the factory's
 * own echoes included: what the reconciliation compares Linear with. A label the team's cache cannot
 * name is left out; nothing is recorded for a ticket never read yet.
 */
export async function recordIssueLabels(body: any, ctx: MapContext): Promise<void> {
  if (body?.type !== 'Issue' || body.action !== 'update' || !ctx.recordLabels || !ctx.knownLabels) return;
  // Only the webhook's own label changes: its full label list may hold one whose webhook was lost, which
  // the reconciliation must still report (a description edit carries every label too).
  const from = body.updatedFrom?.labelIds;
  if (!Array.isArray(from) || !Array.isArray(body.data?.labelIds)) return;
  const identifier = issueIdentifier(body);
  if (!identifier) return;
  const teamKey = identifier.split('-')[0]!;
  const projectId = ctx.projectIdForTeam(teamKey);
  const at = Date.parse(body.data.updatedAt);
  if (!projectId || !Number.isFinite(at)) return;
  // Never read yet: the reconciliation's first pass records them.
  const known = await ctx.knownLabels(projectId, identifier);
  if (!known) return;
  const next = new Set(known.labels);
  for (const { label: id, change } of labelChanges(from as string[], body.data.labelIds as string[])) {
    const name = ctx.labelNameById(teamKey, id);
    if (!name) continue;
    if (change === 'added') next.add(name);
    else next.delete(name);
  }
  // A webhook come late still adds what it reported, at the newer date: dropped, its change would be reported again.
  await ctx.recordLabels(projectId, identifier, [...next], Math.max(at, known.at));
}

// Linear-Delivery is outside the HMAC: the dedup key must come from the signed body.
export function deliveryKey(body: any): string {
  if (body?.type === 'AgentSessionEvent') {
    if (body.action === 'prompted' && body.agentActivity?.id) return `activity:${body.agentActivity.id}`;
    if (body.action === 'created' && body.agentSession?.id) return `session:${body.agentSession.id}`;
  }
  if (body?.type === 'Issue' && body.data?.id && body.data?.updatedAt) return `issue:${body.data.id}:${body.data.updatedAt}`;
  // Linear resends a failed delivery with a new webhookTimestamp: leave it out of the hash.
  return `body:${createHash('sha256').update(JSON.stringify({ ...body, webhookTimestamp: undefined })).digest('hex')}`;
}

export async function mapLinearWebhook(body: any, key: string, ctx: MapContext): Promise<FactoryEvent[]> {
  const identifier = issueIdentifier(body);
  if (!identifier) return [];
  const teamKey = identifier.split('-')[0]!;
  const projectId = ctx.projectIdForTeam(teamKey);
  if (!projectId) return [];
  const { id: actor, taint, name } = signedActor(body);
  const partials = body.type === 'AgentSessionEvent' ? sessionEvents(body, name, projectId, ctx) : await issueEvents(body, identifier, teamKey, projectId, ctx);
  const at = ctx.now();
  return partials.map(
    (p) =>
      ({
        id: `linear:${key}${p.suffix ?? ''}`,
        type: p.type,
        at,
        projectId,
        ticketId: identifier,
        schemaVersion: SCHEMA_VERSION,
        taint,
        ...(actor ? { actor } : {}),
        payload: p.payload,
      }) as FactoryEvent,
  );
}
