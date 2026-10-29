import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { labelEchoKey } from '../types.js';
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
  labelNameById(teamKey: string, labelId: string): string | undefined;
  /** May read the store, hence the promise. */
  isEcho(key: string): boolean | Promise<boolean>;
  commands(projectId: string): string[];
  now(): number;
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

function sessionEvents(body: any, author: string, projectId: string, ctx: MapContext): PartialEvent[] {
  const sessionId: string = body.agentSession.id;
  if (body.action === 'created') {
    const comment = body.agentSession.comment;
    if (!comment) return [{ type: 'ticket.delegated', payload: { linearSessionId: sessionId, promptContext: body.promptContext } }];
    const text = stripMention(comment.body ?? '');
    const [first = '', ...rest] = text.split(/\s+/);
    if (ctx.commands(projectId).includes(first.toLowerCase())) {
      return [{ type: 'command', payload: { name: first.toLowerCase(), body: rest.join(' '), linearSessionId: sessionId, author } }];
    }
    return [{ type: 'session.mentioned', payload: { linearSessionId: sessionId, body: text, author } }];
  }
  if (body.action === 'prompted') {
    if (body.agentActivity?.signal === 'stop') return [{ type: 'session.stopped', payload: { linearSessionId: sessionId } }];
    return [{ type: 'session.prompted', payload: { linearSessionId: sessionId, body: body.agentActivity?.content?.body ?? '', author } }];
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
    if (toName && !(await ctx.isEcho(`state:${identifier}:${toName}`))) {
      out.push({
        type: 'status.changed',
        payload: {
          from: fromName ? ctx.logicalFor(projectId, fromName) : null,
          to: ctx.logicalFor(projectId, toName),
          ...(data.state?.type === 'canceled' ? { cancelled: true as const } : {}),
        },
      });
    }
  }
  if (Array.isArray(from.labelIds) && Array.isArray(data.labelIds)) {
    const before = from.labelIds as string[];
    const after = data.labelIds as string[];
    const changes = [
      ...after.filter((id) => !before.includes(id)).map((id) => ({ id, change: 'added' as const })),
      ...before.filter((id) => !after.includes(id)).map((id) => ({ id, change: 'removed' as const })),
    ];
    for (const { id, change } of changes) {
      const name = ctx.labelNameById(teamKey, id);
      if (name && !(await ctx.isEcho(labelEchoKey(identifier, name, change)))) {
        out.push({ type: 'label.changed', payload: { label: name, change }, suffix: `:label:${id}` });
      }
    }
  }
  return out;
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
  let identifier: string | undefined;
  if (body?.type === 'AgentSessionEvent') identifier = body.agentSession?.issue?.identifier;
  else if (body?.type === 'Issue') identifier = body.data?.identifier ?? (body.data?.team?.key ? `${body.data.team.key}-${body.data.number}` : undefined);
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
