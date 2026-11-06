import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { REFREEZE } from '../../../checks/freeze.js';
import { classifyMessage } from '../../../core/human-message.js';
import { maskTranscriptLine } from '../../runner/transcript.js';
import { IssueNotFoundError, labelEchoKey, stateEchoKey } from '../types.js';
import { labelChanges, type KnownLabels } from './labels.js';
import { holds, isNoRepo, namesOtherRepo, resolveRoute, type Route } from '../../../core/routing.js';
import { SCHEMA_VERSION, type LogicalState, type FactoryEvent, type Taint, type TicketState } from '../../../core/types.js';

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
  /** The projects of a Linear team, in config order (ORC-291). */
  projectsOfTeam(teamKey: string): string[];
  /** The project a delegation on a team with no repo waits under (ORC-171): the first of the configuration. */
  firstProject?(): string | undefined;
  /** A ticket's label names, read from Linear: only to route a new session on a ticket no project holds. */
  labelsOf(identifier: string): Promise<string[]>;
  /** The ticket a project stores, read only when its team has several projects. */
  ticket(projectId: string, identifier: string): Promise<TicketState | undefined>;
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

/** A session Linear opened on a delegation: no comment opened it. */
const isDelegation = (body: any): boolean => body.type === 'AgentSessionEvent' && body.action === 'created' && !body.agentSession.comment;

const delegationPayload = (body: any) => ({ linearSessionId: body.agentSession.id as string, promptContext: body.promptContext as string | undefined });

/**
 * What a message becomes before the inbox (ORC-180): the secret shapes of the transcripts masked, so that none reaches
 * the journal, a prompt or an activity, then classified without a model. On Linear, the message stays as its author wrote it.
 */
function message(text: string): { body: string; masked?: true } {
  const body = maskTranscriptLine(text, []);
  return body === text ? { body } : { body, masked: true };
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
    if (!comment) return [{ type: 'ticket.delegated', payload: { ...delegationPayload(body), ack: true } }];
    const text = stripMention(comment.body ?? '');
    const command = parseCommand(text);
    // `/refreeze` is the factory's own (ORC-131), not a workflow rule's.
    if ([REFREEZE, ...ctx.commands(projectId)].includes(command.name)) {
      return [{ type: 'command', payload: { ...command, ...message(command.body), linearSessionId: sessionId, author, ack: true, kind: 'command' } }];
    }
    const said = message(text);
    return [{ type: 'session.mentioned', payload: { ...said, linearSessionId: sessionId, author, ack: true, kind: classifyMessage(said.body) } }];
  }
  if (body.action === 'prompted') {
    if (body.agentActivity?.signal === 'stop') return [{ type: 'session.stopped', payload: { linearSessionId: sessionId } }];
    const reply: string = body.agentActivity?.content?.body ?? '';
    // A blocked ticket's thread asks for a reply: `/refreeze` there is the command, not feedback that relaunches the agent.
    const command = parseCommand(stripMention(reply));
    if (command.name === REFREEZE) return [{ type: 'command', payload: { ...command, ...message(command.body), linearSessionId: sessionId, author, kind: 'command' } }];
    const said = message(reply);
    const bare = stripMention(said.body);
    const kind = classifyMessage(bare);
    // A command is read by its first word: without the mention it may open with.
    return [{ type: 'session.prompted', payload: { ...said, body: kind === 'command' ? bare : said.body, linearSessionId: sessionId, author, ack: true, kind } }];
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
        const otherRepo = namesOtherRepo(ctx.projectsOfTeam(teamKey), projectId, name);
        out.push({ type: 'label.changed', payload: { label: name, change, ...(otherRepo ? { otherRepo } : {}) }, suffix: `:label:${id}` });
      }
    }
  }
  return out;
}

/**
 * The project of the ticket a webhook is about (ORC-291). Several repos in the team: the project holding the
 * ticket keeps it. Otherwise a session's event (a delegation, a mention, a command, a reply, a stop) is routed by
 * its `repo:` label, read from Linear only then: the delegation that named it may still be in the inbox. Once a
 * label names a repo, a reply goes to the copy that opened its session. An issue deleted meanwhile has no label:
 * its event goes on, as on a team of one (ORC-302).
 */
async function routeOf(body: any, identifier: string, teamKey: string, ctx: MapContext): Promise<Route | undefined> {
  const team = ctx.projectsOfTeam(teamKey);
  if (team.length === 0) {
    // A delegation on a team no project takes waits blocked under the first one (ORC-171); anything else there is dropped.
    const first = isDelegation(body) ? ctx.firstProject?.() : undefined;
    return first ? { projectId: first, noRepo: teamKey } : undefined;
  }
  const route = await routeInTeam(body, identifier, team, ctx);
  // Its team got a repo while it waited under the first project: the label goes now, not at the pass that ends that wait (ORC-171).
  const first = route && isDelegation(body) ? ctx.firstProject?.() : undefined;
  return first && !team.includes(first) && isNoRepo(await ctx.ticket(first, identifier)) ? { ...route!, waitedIn: first } : route;
}

async function routeInTeam(body: any, identifier: string, team: string[], ctx: MapContext): Promise<Route | undefined> {
  if (team.length === 1) return { projectId: team[0]! };
  const stored = (await Promise.all(team.map((p) => ctx.ticket(p, identifier)))).filter((t) => t !== undefined);
  const session: string | undefined = body.type === 'AgentSessionEvent' ? body.agentSession?.id : undefined;
  if (!session || stored.some(holds)) return resolveRoute(team, stored);
  if (body.action !== 'created' && body.action !== 'prompted') return resolveRoute(team, stored);
  const labels = await ctx.labelsOf(identifier).catch((err: Error) => {
    if (err instanceof IssueNotFoundError) return [];
    throw err;
  });
  const route = resolveRoute(team, stored, labels);
  const opener = body.action === 'prompted' && !route.repos ? stored.find((t) => t.linearSessionId === session || t.questionSessionIds.includes(session)) : undefined;
  return opener ? { projectId: opener.projectId } : route;
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
  const projectId = (await routeOf(body, identifier, teamKey, ctx))?.projectId;
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
  const route = await routeOf(body, identifier, teamKey, ctx);
  if (!route) return [];
  const { projectId, repos, waitedIn, noRepo } = route;
  const { id: actor, taint, name } = signedActor(body);
  let partials: PartialEvent[];
  if (noRepo) partials = [{ type: 'ticket.delegated', payload: { ...delegationPayload(body), noRepo } }];
  else if (body.type === 'AgentSessionEvent') partials = sessionEvents(body, name, projectId, ctx);
  else partials = await issueEvents(body, identifier, teamKey, projectId, ctx);
  // The choice to make goes with the event: `decide` blocks the delegation, answers the rest.
  const routing = { ...(repos ? { repos } : {}), ...(waitedIn ? { waitedIn } : {}) };
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
        payload: { ...(p.payload as object), ...routing },
      }) as FactoryEvent,
  );
}
