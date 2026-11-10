import type { Forge, ForgeBranch, OpenPr } from '../adapters/forge/types.js';
import type { SearchHit } from '../adapters/tracker/types.js';
import type { AgentOutput } from './agent-output.js';
import { DEFAULT_BRANCH_NAMING, isOwnBranch, ownBranchPrefixes, type BranchNaming } from './naming.js';
import type { ReuseLead } from './types.js';

/**
 * The work the ticket itself already has on the forge (ORC-207): a branch of its own, named by its open PR when it has one.
 * The `not_started` pickup check, absorbed by the duplicate search: a certain duplicate, found without judgement.
 */
export function ownWork(identifier: string, branches: readonly ForgeBranch[], prs: readonly OpenPr[], naming: BranchNaming = DEFAULT_BRANCH_NAMING): string | undefined {
  const own = branches.find((b) => isOwnBranch(identifier, b.name, naming));
  if (!own) return undefined;
  const link = prs.find((p) => !p.fork && p.branch === own.name)?.url ?? own.url;
  return `This ticket already has work on the forge: ${link} (branch ${own.name}).`;
}

/** The ticket's own branches on the forge (ORC-207, ORC-283): asked by each of their prefixes, kept when `isOwnBranch` takes them. */
export async function ticketBranches(forge: Pick<Forge, 'branches'>, repoPath: string, identifier: string, naming: BranchNaming = DEFAULT_BRANCH_NAMING): Promise<ForgeBranch[]> {
  const found = (await Promise.all(ownBranchPrefixes(identifier, naming).map((prefix) => forge.branches(repoPath, prefix)))).flat();
  return [...new Map(found.filter((b) => isOwnBranch(identifier, b.name, naming)).map((b) => [b.name, b])).values()];
}

/** What the factory read of the work in progress elsewhere, for `intake` to judge: its duplicate candidates. */
export interface ActiveWork {
  prs: OpenPr[];
  branches: ForgeBranch[];
  tickets: SearchHit[];
}

/** Characters of work in progress the intake prompt carries (ORC-207): past it, what is left out is counted. Proposal: settled with the prompt budget (ORC-254). */
export const ACTIVE_WORK_MAX = 12000;
/** Files shown of one PR: as many as the forge reads of it (`PR_FILES`). */
const PR_FILES_SHOWN = 30;

/**
 * The work in progress elsewhere as intake reads it (ORC-207): the open PRs with the files they change, the most recently
 * updated first, the tickets the tracker finds close, then the recent branches without an open PR. The ticket's own work is
 * left out (`ownWork` checks it); a branch is listed once, with its PR when it has one (a fork's PR names a branch of
 * another repository: it hides none). Capped at `ACTIVE_WORK_MAX`, in that order, what is cut counted at the end. Data the
 * factory read: the forge's and the tracker's texts, not instructions.
 */
export function formatActiveWork(identifier: string, work: ActiveWork, naming: BranchNaming = DEFAULT_BRANCH_NAMING): string {
  const own = (branch: string) => isOwnBranch(identifier, branch, naming);
  const prs = work.prs.filter((p) => p.fork || !own(p.branch));
  const withPr = new Set(work.prs.filter((p) => !p.fork).map((p) => p.branch));
  const branches = work.branches.filter((b) => !withPr.has(b.name) && !own(b.name));
  const tickets = work.tickets.filter((t) => t.identifier !== identifier);
  if (!prs.length && !branches.length && !tickets.length) return 'No open PR, no other branch, no close ticket.';
  const sections = [
    { head: 'Open PRs:', noun: 'open PRs', lines: prs.map(prLine) },
    { head: 'Close tickets in the tracker:', noun: 'close tickets', lines: tickets.map((t) => `- ${t.identifier} (${t.stateName}): ${t.title} ${t.url}`) },
    { head: 'Recent branches without an open PR:', noun: 'branches', lines: branches.map((b) => `- ${b.name}`) },
  ];
  const out: string[] = [];
  let used = 0;
  const cut = sections.map((s) => {
    const shown = s.lines.filter((line) => {
      if (used + line.length + 1 > ACTIVE_WORK_MAX) return false;
      used += line.length + 1;
      return true;
    });
    if (shown.length) out.push(s.head, ...shown);
    return { noun: s.noun, left: s.lines.length - shown.length };
  });
  if (cut.some((c) => c.left > 0)) out.push(`Capped at ${ACTIVE_WORK_MAX} characters: ${cut.map((c) => `${c.left} more ${c.noun}`).join(', ')} not shown.`);
  return out.join('\n');
}

function prLine(p: OpenPr): string {
  const head = `- #${p.number} ${p.title} (${p.url}, ${p.fork ? 'from a fork, ' : ''}branch ${p.branch})`;
  if (!p.files) return `${head}: files not listed by the forge`;
  const shown = p.files.slice(0, PR_FILES_SHOWN);
  const files = shown.map((f) => `\`${f}\``).join(', ');
  const more = p.filesTotal > shown.length ? `, and ${p.filesTotal - shown.length} more files` : '';
  return `${head}: ${files || 'no file'}${more}`;
}

/** The leads to existing code `build` is given (ORC-207), one line each. */
export const formatReuse = (leads: readonly ReuseLead[]): string =>
  leads.map((l) => `- \`${l.path}\`${l.symbol ? ` (\`${l.symbol}\`)` : ''}: ${l.why}`).join('\n');

/**
 * What intake found that keeps the ticket from starting (ORC-207), as inputs of the guard beside the failed checks: each
 * probable duplicate with its link, and a refusal of scope with the split it proposes. Facts for a human to answer, never
 * a silent drop: a reply relaunches intake with the answer.
 */
export function guardFindings(a: NonNullable<AgentOutput['intake']>): string[] {
  const duplicates = (a.duplicates ?? []).map((d) => `Probable duplicate: ${d.url} (${d.why})`);
  if (!a.scope) return duplicates;
  const split = a.scope.split?.length ? ` Proposed split, not created: ${a.scope.split.map((s, i) => `${i + 1}. ${s.title}: ${s.summary}`).join(' ')}` : '';
  return [...duplicates, `Out of scope: ${a.scope.refuse}${split}`];
}
