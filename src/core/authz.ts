/**
 * The authorization matrix action × role × channel (ORC-186): who may make the factory act, checked on
 * the signed actor of the webhook (`FactoryEvent.actor`, ORC-160), never on a name quoted in a text.
 * Pure: the roles are resolved outside, before the decision, and journaled with the event
 * (`FactoryEvent.roles`), so that a replay decides the same.
 */

/** Roles resolved for an actor on a project (`RoleResolver`): Linear team, GitHub rights, designations of the configuration. */
export const ROLES = ['team_member', 'repo_writer', 'repo_merger', 'maintainer', 'validator'] as const;
export type Role = (typeof ROLES)[number];

/** Who the actor is to the ticket, read from the ticket itself: the requester is who delegated it (its run's initiator). */
export type Relation = 'requester';

export const AUTHZ_ACTIONS = ['trigger', 'answer_clarify', 'validate_spec', 'refreeze', 'relaunch_blocked', 'done_merge'] as const;
export type AuthzAction = (typeof AUTHZ_ACTIONS)[number];

/** `linear`: the issue (delegation, mention, label, status); `linear_session`: a reply in an agent session; `pr`: the pull request. */
export type Channel = 'linear' | 'linear_session' | 'pr';

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

/**
 * The default matrix of the MVP doc. A constant until the `factory/default` preset declares it (ORC-187):
 * `decide` takes it as a parameter so that a preset can pass its own.
 */
export const DEFAULT_MATRIX: AuthzMatrix = {
  trigger: {
    anyOf: [['team_member', 'repo_writer']],
    channels: ['linear'],
    what: "déclencher l'agent (délégation, mention)",
    who: "aux membres de l'équipe Linear qui ont le droit d'écriture sur le dépôt",
  },
  answer_clarify: {
    anyOf: [['requester'], ['team_member']],
    channels: ['linear_session'],
    what: "répondre à l'agent ou lui poser une question",
    who: "au demandeur et aux membres de l'équipe Linear",
  },
  validate_spec: {
    anyOf: [['validator']],
    neverInitiator: true,
    channels: ['linear_session'],
    what: 'valider la spec',
    who: "aux valideurs désignés par le projet, jamais à l'initiateur du run",
  },
  refreeze: {
    anyOf: [['maintainer']],
    channels: ['linear', 'pr'],
    what: 'regeler les tests (/refreeze)',
    who: 'aux mainteneurs désignés',
  },
  relaunch_blocked: {
    anyOf: [['team_member']],
    channels: ['linear', 'linear_session'],
    what: 'relancer un run bloqué',
    who: "aux membres de l'équipe Linear",
  },
  done_merge: {
    anyOf: [['repo_merger']],
    channels: ['linear'],
    what: 'passer le ticket en Done (merge)',
    who: 'aux humains qui ont le droit de merge GitHub sur le dépôt',
  },
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

/** The refusal answered in the ticket (French). It names no one: the actor knows who they are. */
export function refusalMessage(action: AuthzAction, matrix: AuthzMatrix, reason: RefusalReason | undefined): string {
  const row = matrix[action];
  const why =
    reason === 'unsigned'
      ? " Linear ne nomme aucun membre de l'espace comme auteur (intégration, Slack, e-mail…) : je ne peux pas le vérifier."
      : reason === 'channel'
        ? ' Pas par ce canal.'
        : '';
  return `Refusé : ${row.what} est réservé ${row.who}.${why} La vérification porte sur l'auteur signé de l'action, jamais sur un nom cité dans le texte.`;
}
