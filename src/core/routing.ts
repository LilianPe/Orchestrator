import type { TicketState } from './types.js';

/** Prefix of the label that names a ticket's repo: `repo:<project id>` (ORC-291). */
export const REPO_LABEL = 'repo:';

/** Start of the block reason of a ticket whose repo is still to be chosen. */
export const UNROUTED = 'Dépôt à préciser';

/** The block reason, and the message, of a ticket whose repo is still to be chosen among `repos`. */
export function unroutedReason(repos: readonly string[]): string {
  const labels = repos.map((r) => `\`${REPO_LABEL}${r}\``).join(', ');
  return `${UNROUTED} : cette équipe Linear a plusieurs dépôts. Ajoutez au ticket le label de son dépôt (${labels}), puis déléguez-le de nouveau.`;
}

export const isUnrouted = (t: TicketState | undefined): boolean => !!t?.blocked && !!t.blockReason?.startsWith(UNROUTED);

/** A ticket its project keeps whatever its labels say: work was asked of it there (sticky routing). */
export const holds = (t: TicketState): boolean => !isUnrouted(t) && (t.delegated || t.prNumber !== undefined || t.branch !== undefined);

/** A label naming another repo of the team than `projectId`: what a ticket held there cannot follow. */
export function namesOtherRepo(team: readonly string[], projectId: string, label: string): boolean {
  const lower = label.toLowerCase();
  return team.some((id) => id !== projectId && lower === `${REPO_LABEL}${id}`.toLowerCase());
}

export interface Route {
  projectId: string;
  /** The repos to choose from: the ticket names none. */
  repos?: string[];
  /** The project where the ticket waited for this choice: on Postgres, its one row now moves here (ORC-291). */
  waitedIn?: string;
}

/**
 * The project of a ticket among its Linear team's (`team`, in config order), given the team's tickets
 * the store holds for it (ORC-291). The only project; else the one holding it; else, given `labels`
 * (something to route: a delegation, a mention), the one its `repo:` label names, or the first with the
 * choice to make. Without `labels`, a ticket no project knows has nowhere to go.
 */
export function resolveRoute(team: readonly string[], stored: readonly TicketState[], labels?: readonly string[]): Route | undefined {
  if (team.length === 1) return { projectId: team[0]! };
  const held = stored.find(holds);
  if (held) return { projectId: held.projectId };
  const pending = stored.find(isUnrouted)?.projectId;
  if (!labels) {
    const known = pending ?? stored[0]?.projectId;
    return known ? { projectId: known } : undefined;
  }
  const named = new Set(labels.map((l) => l.toLowerCase()));
  const chosen = team.find((id) => named.has(`${REPO_LABEL}${id}`.toLowerCase()));
  if (chosen) return { projectId: chosen, ...(pending && pending !== chosen ? { waitedIn: pending } : {}) };
  return { projectId: pending ?? team[0]!, repos: [...team] };
}
