/** Prefix of the label that names a ticket's repo: `repo:<project id>` (ORC-291). */
export const REPO_LABEL = 'repo:';

/**
 * The project of a ticket among its Linear team's (`team`, in config order): the only one, or the one its
 * `repo:` label names. Otherwise the first gets it, with `repos`: the ticket waits for a human to choose.
 */
export function routeTicket(team: readonly string[], labels: readonly string[]): { projectId: string; repos?: string[] } {
  if (team.length === 1) return { projectId: team[0]! };
  const named = new Set(labels.map((l) => l.toLowerCase()));
  const chosen = team.find((id) => named.has(`${REPO_LABEL}${id}`.toLowerCase()));
  return chosen ? { projectId: chosen } : { projectId: team[0]!, repos: [...team] };
}
