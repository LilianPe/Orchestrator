import type { Forge, OpenPr } from '../adapters/forge/types.js';
import type { Tracker, TrackerIssue } from '../adapters/tracker/types.js';
import type { PickupCheck } from '../config/workflow-schema.js';
import { formatActiveWork } from './intake-checks.js';
import type { BranchNaming } from './naming.js';
import type { Blocker } from './types.js';

/**
 * The tickets `issue` is « blocked by » that are not done (ORC-363): an input of the guard before In Progress. Done is Linear's
 * `completed` type; a cancelled blocker delivered nothing, so it still holds: the human takes the relation off to go on.
 */
export const openBlockers = (issue: TrackerIssue): Blocker[] =>
  (issue.blockedBy ?? []).filter((b) => b.stateType !== 'completed').map(({ identifier, stateName }) => ({ identifier, stateName }));

/** The names a section of acceptance criteria goes by (ORC-353), its heading's text once its marks are taken off. */
const CRITERIA_SECTION =
  /^(acceptance (criteria|tests?)|crit[eè]res? d['’]acceptation|tests? d['’]acceptation|definition of done|dod|d[ée]finition de (fini|termin[ée])|done when|expected (behaviou?rs?|results?)|(r[ée]sultats?|comportements?) attendus?|conditions? de satisfaction)$/i;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
/** A line that opens an example: « Given » or « Étant donné », after a list mark, an emphasis or a `Scenario:` line's indent. */
const GIVEN = /^\s*(([-*+]|\d+[.)])\s+)?(\*\*|__)?\s*(given|[ée]tant donn[ée]e?s?)(?=[\s,:*_]|$)/i;
const THEN = /(^|[\s,;:*_(])(then|alors)(?=[\s,:*_]|$)/i;
/** A list item that goes on with the example: its next step, `- When …`, `2. Alors …`. */
const STEP_ITEM = /^\s*([-*+]|\d+[.)])\s+(\*\*|__)?\s*(when|then|and|but|quand|lorsque|alors|et|mais)(?=[\s,:*_]|$)/i;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s+\S/m;

/** A heading's text: its `#`, its emphasis and its trailing colon taken off. */
const headingText = (line: string): string =>
  line.trim().replace(/^#+\s*/, '').replace(/^(\*\*|__)(.*)\1$/, '$2').replace(/\s*:\s*$/, '').replace(/^(\*\*|__)(.*)\1$/, '$2').trim();

/**
 * Whether a description holds acceptance criteria (ORC-353), however they are written, without a model: the words
 * « critères d'acceptation » or "acceptance criteria" anywhere, a section of its own under one of the usual names with
 * something in it, one « Given … then » / « Étant donné … alors » example, on one line or the lines of its item, or a
 * checklist. `intake` judges whether they are enough (ORC-206); this check only sees that there are some.
 */
export function hasAcceptanceCriteria(description: string): boolean {
  if (/(crit[eè]res? d['’]acceptation|acceptance criteria)/i.test(description) || CHECKBOX.test(description)) return true;
  const lines = description.split(/\r?\n/);
  return lines.some((line, i) => {
    if (CRITERIA_SECTION.test(headingText(line))) {
      const body = lines.slice(i + 1).findIndex((l) => l.trim() !== '');
      return body !== -1 && !lines[i + 1 + body]!.trim().startsWith('#');
    }
    if (!GIVEN.test(line)) return false;
    // The example's lines: this one, then the ones of its item and the items of its next steps, up to a blank line or another item.
    const end = lines.slice(i + 1).findIndex((l) => l.trim() === '' || (LIST_ITEM.test(l) && !STEP_ITEM.test(l)));
    return lines.slice(i, end === -1 ? undefined : i + 1 + end).some((l) => THEN.test(l));
  });
}

/**
 * The checks of `checks` that fail. `ownWork`: the ticket's own work already on the forge, as the duplicate search found it
 * (`ownWork` of intake-checks, ORC-207), or on origin for `factory plan`: the `not_started` failure when that check is listed.
 */
export function pickupFailures(checks: PickupCheck[], issue: TrackerIssue, ownWork?: string): string[] {
  const out: string[] = [];
  for (const check of checks) {
    if (check === 'has_description' && issue.description.trim().length < 30) {
      out.push('The description is shorter than 30 characters.');
    }
    if (check === 'not_started' && ownWork) out.push(ownWork);
    if (check === 'has_acceptance_criteria' && !hasAcceptanceCriteria(issue.description)) {
      out.push('The description has no acceptance criteria.');
    }
  }
  return out;
}

/**
 * `intake`'s duplicate search (ORC-207), at its launch: every open PR with its files and the recent branches of the
 * repository, through the forge, and the tickets the tracker finds close to its title. `activeWork`, what intake reads to
 * judge them; `prs`, for `ownWork` to name the ticket's own PR. A read that fails throws: no intake starts that would
 * see no duplicate for want of a list.
 */
export async function searchDuplicates(
  issue: TrackerIssue,
  repoPath: string,
  d: { forge: Pick<Forge, 'openPrs' | 'recentBranches'>; tracker: Pick<Tracker, 'search'> },
  naming?: BranchNaming,
): Promise<{ prs: OpenPr[]; activeWork: string }> {
  const [prs, branches, tickets] = await Promise.all([d.forge.openPrs(repoPath), d.forge.recentBranches(repoPath), d.tracker.search(issue.title, issue.teamKey)]);
  return { prs, activeWork: formatActiveWork(issue.identifier, { prs, branches, tickets }, naming) };
}
