import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LogicalState, RelaisEvent } from '../../../core/types.js';

export function verifyLinearSignature(raw: string, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function isFresh(body: { webhookTimestamp?: number }, now: number, maxSkewMs = 60_000): boolean {
  return typeof body.webhookTimestamp === 'number' && Math.abs(now - body.webhookTimestamp) <= maxSkewMs;
}

export interface MapContext {
  projectIdForTeam(teamKey: string): string | undefined;
  logicalFor(projectId: string, stateName: string): LogicalState | null;
  stateNameById(teamKey: string, stateId: string): string | undefined;
  labelNameById(teamKey: string, labelId: string): string | undefined;
  isEcho(key: string): boolean;
  commands(projectId: string): string[];
  now(): number;
}

export function stripMention(body: string): string {
  return body.replace(/^\s*(\[@[^\]]*\]\([^)]*\)|@\S+)\s*/, '').trim();
}

type PartialEvent = { type: RelaisEvent['type']; payload: unknown };

function author(body: any): string {
  return body.agentActivity?.user?.name ?? body.agentSession?.comment?.user?.name ?? body.agentSession?.creator?.name ?? 'Humain';
}

function sessionEvents(body: any, projectId: string, ctx: MapContext): PartialEvent[] {
  const sessionId: string = body.agentSession.id;
  if (body.action === 'created') {
    const comment = body.agentSession.comment;
    if (!comment) return [{ type: 'ticket.delegated', payload: { linearSessionId: sessionId, promptContext: body.promptContext } }];
    const text = stripMention(comment.body ?? '');
    const [first = '', ...rest] = text.split(/\s+/);
    if (ctx.commands(projectId).includes(first.toLowerCase())) {
      return [{ type: 'command', payload: { name: first.toLowerCase(), body: rest.join(' '), linearSessionId: sessionId, author: author(body) } }];
    }
    return [{ type: 'session.mentioned', payload: { linearSessionId: sessionId, body: text, author: author(body) } }];
  }
  if (body.action === 'prompted') {
    if (body.agentActivity?.signal === 'stop') return [{ type: 'session.stopped', payload: { linearSessionId: sessionId } }];
    return [{ type: 'session.prompted', payload: { linearSessionId: sessionId, body: body.agentActivity?.content?.body ?? '', author: author(body) } }];
  }
  return [];
}

function issueEvents(body: any, identifier: string, teamKey: string, projectId: string, ctx: MapContext): PartialEvent[] {
  if (body.action !== 'update') return [];
  const out: PartialEvent[] = [];
  const data = body.data ?? {};
  const from = body.updatedFrom ?? {};
  if (from.stateId !== undefined) {
    const toName: string | undefined = data.state?.name ?? ctx.stateNameById(teamKey, data.stateId);
    const fromName = ctx.stateNameById(teamKey, from.stateId);
    if (toName && !ctx.isEcho(`state:${identifier}:${toName}`)) {
      out.push({
        type: 'ticket.moved',
        payload: { from: fromName ? ctx.logicalFor(projectId, fromName) : null, to: ctx.logicalFor(projectId, toName) },
      });
    }
  }
  if (Array.isArray(from.labelIds) && Array.isArray(data.labelIds)) {
    for (const id of data.labelIds as string[]) {
      if ((from.labelIds as string[]).includes(id)) continue;
      const name = ctx.labelNameById(teamKey, id);
      if (name && !ctx.isEcho(`label:${identifier}:${name}`)) out.push({ type: 'label.added', payload: { label: name } });
    }
  }
  return out;
}

export function mapLinearWebhook(body: any, deliveryId: string, ctx: MapContext): RelaisEvent[] {
  let identifier: string | undefined;
  if (body?.type === 'AgentSessionEvent') identifier = body.agentSession?.issue?.identifier;
  else if (body?.type === 'Issue') identifier = body.data?.identifier ?? (body.data?.team?.key ? `${body.data.team.key}-${body.data.number}` : undefined);
  if (!identifier) return [];
  const teamKey = identifier.split('-')[0]!;
  const projectId = ctx.projectIdForTeam(teamKey);
  if (!projectId) return [];
  const partials = body.type === 'AgentSessionEvent' ? sessionEvents(body, projectId, ctx) : issueEvents(body, identifier, teamKey, projectId, ctx);
  const at = ctx.now();
  return partials.map(
    (p, i) => ({ id: i === 0 ? `linear:${deliveryId}` : `linear:${deliveryId}:${i}`, type: p.type, at, projectId, ticketId: identifier, payload: p.payload }) as RelaisEvent,
  );
}
