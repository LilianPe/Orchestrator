/**
 * The authorization matrix action × role × channel (ORC-186): who may make the factory act, checked on
 * the signed actor of the webhook (`FactoryEvent.actor`, ORC-160), never on a name quoted in a text.
 * Pure: the roles are resolved outside, before the decision, and journaled with the event
 * (`FactoryEvent.roles`), so that a replay decides the same.
 */

/**
 * Roles resolved for an actor on a project (`RoleResolver`): Linear team, GitHub rights, designations of the configuration.
 * `operator` is the dashboard's (ORC-301): given by its guard, the password or the loopback without one, never by a resolver.
 */
export const ROLES = ['team_member', 'repo_writer', 'repo_merger', 'maintainer', 'validator', 'operator'] as const;
export type Role = (typeof ROLES)[number];

/** Who the actor is to the ticket, read from the ticket itself: the requester is who delegated it (its run's initiator). */
export type Relation = 'requester';

export const AUTHZ_ACTIONS = ['trigger', 'answer_clarify', 'validate_spec', 'refreeze', 'relaunch_blocked', 'done_merge', 'pause_run', 'stop_run', 'take_over'] as const;
export type AuthzAction = (typeof AUTHZ_ACTIONS)[number];

/** `linear`: the issue (delegation, mention, label, status); `linear_session`: a reply in an agent session; `pr`: the pull request; `dashboard`: a run's inspection (ORC-301). */
export type Channel = 'linear' | 'linear_session' | 'pr' | 'dashboard';

export interface MatrixRow {
  /** Any one of these sets is enough; a set needs all of its roles and relations. */
  anyOf: readonly (readonly (Role | Relation)[])[];
  /** Refused to the run's initiator whatever their roles: a validation stays a second look. */
  neverInitiator?: boolean;
  channels: readonly Channel[];
  /** For the refusal answered in the ticket (French): what the action is, and to whom it is kept. */
  what: string;
  who: string;
}

export type AuthzMatrix = Readonly<Record<AuthzAction, MatrixRow>>;

/** A row of a run's inspection on the dashboard (ORC-301): its operators alone. */
function dashboardRow(what: string): MatrixRow {
  return { anyOf: [['operator']], channels: ['dashboard'], what, who: 'operators of the dashboard' };
}

/**
 * The default matrix of the MVP doc. A constant until the `factory/default` preset declares it (ORC-187):
 * `decide` takes it as a parameter so that a preset can pass its own.
 */
export const DEFAULT_MATRIX: AuthzMatrix = {
  trigger: {
    anyOf: [['team_member', 'repo_writer']],
    channels: ['linear'],
    what: 'triggering the agent (delegation, mention)',
    who: 'Linear team members with write access to the repository',
  },
  answer_clarify: {
    anyOf: [['requester'], ['team_member']],
    channels: ['linear_session'],
    what: 'answering the agent or asking it a question',
    who: 'the requester and Linear team members',
  },
  validate_spec: {
    anyOf: [['validator']],
    neverInitiator: true,
    channels: ['linear_session'],
    what: 'validating the spec',
    who: 'validators designated by the project, never the run\'s initiator',
  },
  refreeze: {
    anyOf: [['maintainer']],
    channels: ['linear', 'pr'],
    what: 'refreezing the tests (/refreeze)',
    who: 'designated maintainers',
  },
  relaunch_blocked: {
    anyOf: [['team_member']],
    channels: ['linear', 'linear_session'],
    what: 'relaunching a blocked run',
    who: 'Linear team members',
  },
  done_merge: {
    anyOf: [['repo_merger']],
    channels: ['linear'],
    what: 'moving the ticket to Done (merge)',
    who: 'humans with GitHub merge rights on the repository',
  },
  // A run's inspection (ORC-301). Stopping from Linear (`agent:stop`, removing the delegation) stays outside the matrix.
  pause_run: dashboardRow('pausing a run'),
  stop_run: dashboardRow('stopping a run'),
  /** Wired by ORC-234, which brings the take-over itself. */
  take_over: dashboardRow('taking over a run'),
};

export interface AuthzRequest {
  action: AuthzAction;
  channel: Channel;
}

/** What the matrix reads of the ticket. */
export interface TicketParties {
  /** Signed actor who delegated the ticket: the run's initiator, and its requester. */
  initiatorId?: string;
}

/** `unsigned`: no signed actor; `channel`: not through this channel; `initiator`: the initiator validating; `roles`: missing roles. */
export type RefusalReason = 'unsigned' | 'channel' | 'initiator' | 'roles';
export type Verdict = { ok: true } | { ok: false; reason: RefusalReason };

/** Pure: whether `actor`, with `roles` on the project, may take `action` on `ticket` through its channel. */
export function allowed(
  request: AuthzRequest,
  actor: string | undefined,
  ticket: TicketParties | undefined,
  matrix: AuthzMatrix,
  roles: readonly Role[],
): Verdict {
  if (!actor) return { ok: false, reason: 'unsigned' };
  const row = matrix[request.action];
  if (!row.channels.includes(request.channel)) return { ok: false, reason: 'channel' };
  const initiator = !!ticket?.initiatorId && ticket.initiatorId === actor;
  if (row.neverInitiator && initiator) return { ok: false, reason: 'initiator' };
  const holds = (grant: Role | Relation) => (grant === 'requester' ? initiator : roles.includes(grant));
  return row.anyOf.some((set) => set.every(holds)) ? { ok: true } : { ok: false, reason: 'roles' };
}

/** The refusal answered in the ticket. It names no one: the actor knows who they are. */
export function refusalMessage(action: AuthzAction, matrix: AuthzMatrix, reason: RefusalReason): string {
  const row = matrix[action];
  const why =
    reason === 'unsigned'
      ? ' Linear names no workspace member as the author (integration, Slack, email…): I cannot check it.'
      : reason === 'channel'
        ? ' Not through this channel.'
        : '';
  return `Refused: ${row.what} is reserved for ${row.who}.${why} The check is on the signed author of the action, never on a name quoted in the text.`;
}
