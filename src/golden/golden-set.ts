import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { MAX_DIFF } from '../checks/diff-size.js';
import { hashCanonical } from '../runtime/workflow-version.js';

/**
 * The golden tickets (ORC-236): 10 closed tickets of the pilot repositories, frozen with their start commit,
 * replayed on every change of prompt, skill or preset. Their choice follows the ORC-137 decision; the set
 * changes only through a written decision, which `decisions` names with the fingerprint of the new set.
 */
export const PILOT_REPOS = ['Intersektion/intersektion-platform', 'LilianPe/Orchestrator'] as const;
export const GOLDEN_SET_PATH = join(import.meta.dirname, '../../pilot/golden-tickets.yml');

const GOLDEN_COUNT = 10;
const PER_REPO = GOLDEN_COUNT / PILOT_REPOS.length;
const RISKS = ['low', 'medium', 'high'] as const;
/** ORC-137: aim for 3 low, 4 medium, 3 high. */
const RISK_MIX: Record<Risk, number> = { low: 3, medium: 4, high: 3 };

export type Risk = (typeof RISKS)[number];

export interface GoldenTicket {
  ticket: string;
  repo: string;
  /** The human PR that closed it. */
  pr: number;
  title: string;
  /** The first parent of the PR's merge commit: where the replay starts. */
  startCommit: string;
  mergeCommit: string;
  /** Changed lines outside tests in the human PR, against `max_diff`. */
  nonTestLines: number;
  risk: Risk;
}

export interface GoldenSet {
  /** Replays of each ticket on every change: a regression can show once in two. */
  passes: number;
  tickets: GoldenTicket[];
  /** sha256 of the tickets' canonical JSON, the one the last decision names. */
  fingerprint: string;
}

export class GoldenSetError extends Error {
  constructor(readonly violations: string[]) {
    super(`invalid golden set:\n- ${violations.join('\n- ')}`);
  }
}

const SHA = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character sha is expected');

const TICKET = z.strictObject({
  ticket: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  title: z.string().min(1),
  start_commit: SHA,
  merge_commit: SHA,
  non_test_lines: z.number().int().nonnegative(),
  risk: z.enum(RISKS),
});

const FILE = z.strictObject({
  version: z.literal(1),
  passes: z.number().int().positive(),
  /** Why the split is not 5 and 5, when a pilot repository had fewer eligible tickets (ORC-137). */
  shortfall: z.string().min(1).optional(),
  decisions: z.array(z.strictObject({ date: z.iso.date(), decision: z.string().min(1), fingerprint: z.string() })).min(1),
  tickets: z.array(TICKET),
});

/** Reads a golden set; throws a GoldenSetError listing every rule it breaks. */
export function parseGoldenSet(text: string): GoldenSet {
  const parsed = FILE.safeParse(parse(text));
  if (!parsed.success) throw new GoldenSetError(parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`));
  const file = parsed.data;
  const tickets = file.tickets.map((t): GoldenTicket => ({
    ticket: t.ticket, repo: t.repo, pr: t.pr, title: t.title,
    startCommit: t.start_commit, mergeCommit: t.merge_commit, nonTestLines: t.non_test_lines, risk: t.risk,
  }));
  const violations: string[] = [];

  if (tickets.length !== GOLDEN_COUNT) violations.push(`the set holds ${GOLDEN_COUNT} tickets, not ${tickets.length}`);
  const seen = new Set<string>();
  for (const t of tickets) {
    if (seen.has(t.ticket)) violations.push(`${t.ticket} is listed twice`);
    seen.add(t.ticket);
    if (!(PILOT_REPOS as readonly string[]).includes(t.repo)) violations.push(`${t.ticket}: ${t.repo} is not a pilot repository (${PILOT_REPOS.join(', ')})`);
    if (t.nonTestLines > MAX_DIFF.lines) violations.push(`${t.ticket}: ${t.nonTestLines} lines outside tests, past max_diff (${MAX_DIFF.lines})`);
  }

  const split = PILOT_REPOS.map((r) => tickets.filter((t) => t.repo === r).length);
  if (split.some((n) => n !== PER_REPO) && !file.shortfall) {
    violations.push(`${PER_REPO} tickets from each pilot repository (${split.join(' and ')} here): write why under \`shortfall\``);
  }

  const mix = (counts: Record<Risk, number>) => RISKS.map((r) => `${counts[r]} ${r}`).join(', ');
  const counts = Object.fromEntries(RISKS.map((r) => [r, tickets.filter((t) => t.risk === r).length])) as Record<Risk, number>;
  if (RISKS.some((r) => counts[r] !== RISK_MIX[r])) violations.push(`risk mix: ${mix(RISK_MIX)} expected, ${mix(counts)} here`);

  // The tickets only, whatever the order of the keys or the comments of the file.
  const fingerprint = hashCanonical(tickets);
  const last = file.decisions.at(-1)!;
  if (last.fingerprint !== fingerprint) {
    violations.push(`the tickets changed without a written decision: add an entry to \`decisions\` naming it, with fingerprint ${fingerprint}`);
  }

  if (violations.length) throw new GoldenSetError(violations);
  return { passes: file.passes, tickets, fingerprint };
}

export function loadGoldenSet(path: string = GOLDEN_SET_PATH): GoldenSet {
  return parseGoldenSet(readFileSync(path, 'utf8'));
}
