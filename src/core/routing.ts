import type { TicketState } from './types.js';

/** Prefix of the label that names a ticket's repo: `repo:<project id>` (ORC-291). */
const REPO_LABEL = 'repo:';

/** The label that names a repo. */
export const repoLabel = (id: string): string => `${REPO_LABEL}${id}`;

const namesRepo = (label: string, id: string): boolean => label.toLowerCase() === repoLabel(id).toLowerCase();

/** The block reason, and the message, of a ticket whose repo is still to be chosen among `repos`. */
export function unroutedReason(repos: readonly string[]): string {
  const labels = repos.map((r) => `\`${repoLabel(r)}\``).join(', ');
  return `Dépôt à préciser : cette équipe Linear a plusieurs dépôts. Ajoutez au ticket le label de son dépôt (${labels}), puis déléguez-le de nouveau.`;
}

/** The ticket waits for its repo: `awaitingRepo`, whatever its block reason says. */
export const isUnrouted = (t: TicketState | undefined): boolean => !!t?.awaitingRepo;

/** A ticket its project keeps whatever its labels say: work was asked of it there (sticky routing). */
export const holds = (t: TicketState): boolean => !isUnrouted(t) && (t.delegated || t.prNumber !== undefined || t.branch !== undefined);

/** A label naming another repo of the team than `projectId`: what a ticket held there cannot follow. */
export function namesOtherRepo(team: readonly string[], projectId: string, label: string): boolean {
  return team.some((id) => id !== projectId && namesRepo(label, id));
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
export function resolveRoute(team: readonly string[], stored: readonly TicketState[], labels: readonly string[]): Route;
export function resolveRoute(team: readonly string[], stored: readonly TicketState[]): Route | undefined;
export function resolveRoute(team: readonly string[], stored: readonly TicketState[], labels?: readonly string[]): Route | undefined {
  if (team.length === 1) return { projectId: team[0]! };
  const held = stored.find(holds);
  if (held) return { projectId: held.projectId };
  const pending = stored.find(isUnrouted)?.projectId;
  if (!labels) {
    const known = pending ?? stored[0]?.projectId;
    return known ? { projectId: known } : undefined;
  }
  const chosen = team.find((id) => labels.some((l) => namesRepo(l, id)));
  if (chosen) return { projectId: chosen, ...(pending && pending !== chosen ? { waitedIn: pending } : {}) };
  return { projectId: pending ?? team[0]!, repos: [...team] };
}
