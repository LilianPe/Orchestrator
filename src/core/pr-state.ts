/** Where a review's sandbox reads the factory's bundle of its PR refs, read-only (ORC-322). */
export const PR_TARGET = '/run/factory/pr';

/**
 * A PR as the factory read it for a review (ORC-322): the forge's answer, and the shas `origin/<branch>` and
 * `origin/<base>` name in the worktree once the factory brought them. In the prompt, and from `factory-agent pr`.
 */
export interface PrState {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  branch: string;
  base?: string;
  mergeable?: string;
  mergeState?: string;
  head?: string;
  baseSha?: string;
  /** What the factory did to the worktree's branch before the run. */
  worktree?: 'fast-forwarded' | 'up-to-date' | 'diverged';
  /** What it could not read or bring: the agent reads it again with `factory-agent pr`. */
  error?: string;
}

/** The forge did not answer: not the same as a ticket without a PR. */
export interface PrUnreadable {
  unreadable: true;
}

export type PrRead = PrState | PrUnreadable;

export const isUnreadable = (pr: PrRead): pr is PrUnreadable => 'unreadable' in pr;

const short = (sha: string) => sha.slice(0, 12);

const WORKTREE: Record<NonNullable<PrState['worktree']>, string> = {
  'fast-forwarded': 'your branch was fast-forwarded to the PR head.',
  'up-to-date': 'your branch already holds the PR head.',
  diverged: 'your branch and the PR head have diverged: the factory moved nothing.',
};

/** The PR as text, the same in the prompt and from `factory-agent pr`. */
export function formatPrState(pr: PrRead): string {
  if (isUnreadable(pr)) return "The factory could not read the PR: the forge did not answer (the factory's log says why).";
  const lines = [`#${pr.number} — ${pr.state}${pr.base ? ` — base \`${pr.base}\`` : ''}${pr.mergeable ? ` — mergeable: ${pr.mergeable}${pr.mergeState ? ` (${pr.mergeState})` : ''}` : ''}`, `URL: ${pr.url}`];
  if (pr.head && pr.baseSha && pr.base) {
    lines.push(`In your worktree, \`origin/${pr.branch}\` at ${short(pr.head)}, \`origin/${pr.base}\` at ${short(pr.baseSha)}${pr.worktree ? `; ${WORKTREE[pr.worktree]}` : '.'}`);
  }
  if (pr.error) lines.push(`Part of it not read by the factory: ${pr.error}`);
  return lines.join('\n');
}
