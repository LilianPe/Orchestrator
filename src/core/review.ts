import type { ReviewLens } from '../config/workflow-schema.js';
import { OUTPUT_LIMITS } from '../publish/output-limits.js';
import type { Finding, FindingSeverity } from './agent-output.js';
import type { ContestedFinding } from './types.js';

/**
 * The AI review (ORC-183): two read-only lenses on the published commit, whose findings the factory publishes as one GitHub
 * review and the `factory/review` check. The pure part: what a lens reads of the diff, the verdict, and the texts around the
 * findings, which the `OutputPolicy` vets before they go out.
 */

/** The check the review publishes on the commit it read: failed while a blocking finding stands. */
export const REVIEW_CHECK = 'factory/review';

/** A finding as the factory keeps it: the lens and the run that made it. */
export type ReviewFinding = Finding & { lens: ReviewLens; runId: string };

/** The diff a lens is given in its prompt, at most; past it, the changed files, read in its clone, as many as fit. */
export const DIFF_MAX = 60_000;

/** The diff, or past `max` the changed files (`stat`, read only then, cut at `max`); `undefined`, a diff whose reading stopped past the cap. */
export async function capDiff(diff: string | undefined, stat: () => Promise<string>, max = DIFF_MAX): Promise<string> {
  if (diff !== undefined && !diff.trim()) return '(no change against the trunk)';
  if (diff !== undefined && diff.length <= max) return diff;
  const files = await stat();
  const cut = files.length > max ? `${files.slice(0, max)}\n[… more changed files: list them with Glob]` : files;
  return `The diff has more than ${max} characters: read the changed files in the clone.\n\n${cut}`;
}

const LABEL: Record<FindingSeverity, string> = { blocking: 'Blocking', minor: 'Minor', out_of_scope: 'Out of scope' };

/** The one definition of a blocking finding: what fails `factory/review` (ORC-183) and starts the fix of the review loop (ORC-184). */
export const isBlocking = (f: Pick<Finding, 'severity'>): boolean => f.severity === 'blocking';

/** The blocking findings of a commit, every lens's count added (ORC-184). */
export const blockingTotal = (counts: Partial<Record<ReviewLens, number>>): number => Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

export function reviewVerdict(findings: readonly Pick<Finding, 'severity'>[]): { conclusion: 'success' | 'failure'; summary: string } {
  const count = (s: FindingSeverity) => findings.filter((f) => f.severity === s).length;
  const blocking = count('blocking');
  return {
    conclusion: blocking ? 'failure' : 'success',
    summary: `${blocking} blocking finding${blocking === 1 ? '' : 's'}, ${count('minor')} minor, ${count('out_of_scope')} out of scope`,
  };
}

/**
 * Whether a finding goes on its line: an out-of-scope one is on code the diff does not change, a line GitHub cannot place a
 * comment on, so it is listed in the review's text.
 */
export const onItsLine = (f: Pick<Finding, 'severity'>): boolean => f.severity !== 'out_of_scope';

/** A finding as a comment on its line. */
export function inlineComment(f: ReviewFinding): string {
  return [`**${LABEL[f.severity]}** · ${f.lens} lens`, ...findingBody(f)].join('\n\n');
}

/** What a finding says, whoever reads it: the PR, the fix of the review loop, the next lens (ORC-184). */
const findingBody = (f: Finding): string[] => [f.explanation, ...(f.suggestion ? [`**Suggestion**: ${f.suggestion}`] : []), ...(f.fact ? [`Violates fact \`${f.fact}\`.`] : [])];

/** Where a finding is, as the texts around the findings name it. */
const placeOf = (f: Pick<Finding, 'file' | 'line'>): string => `\`${f.file}:${f.line}\``;

/** How long a listed finding's explanation may run when the full list would not fit in one text. */
const SHORT = 200;

/**
 * The review's own text: the verdict, then the findings not on their lines with their place: the out-of-scope ones, or all of
 * them when GitHub refused one (`inline: false`). Under the cap of a text: past it, each listed finding is shortened, then
 * reduced to its place and severity, so the policy never withholds the whole review for its length. Both lenses ran: the
 * second starts only once the first one's findings are kept.
 */
export function reviewBody(sha: string, findings: readonly ReviewFinding[], o: { inline: boolean }): string {
  const head = `**AI review** of \`${sha.slice(0, 12)}\` (correctness and security lenses): ${reviewVerdict(findings).summary}.`;
  if (!findings.length) return `${head}\n\nNo finding.`;
  const inline = o.inline ? findings.filter(onItsLine) : [];
  const listed = o.inline ? findings.filter((f) => !onItsLine(f)) : findings;
  const parts = [head, ...(inline.length ? ['Each blocking or minor finding is a comment on its line.'] : [])];
  const forms = [
    (f: ReviewFinding) => `${placeOf(f)}\n${inlineComment(f)}`,
    (f: ReviewFinding) => `${placeOf(f)} **${LABEL[f.severity]}** · ${f.lens} lens: ${f.explanation.length > SHORT ? `${f.explanation.slice(0, SHORT)}…` : f.explanation}`,
    (f: ReviewFinding) => `${placeOf(f)} **${LABEL[f.severity]}** · ${f.lens} lens`,
  ];
  for (const form of forms) {
    const text = [...parts, ...listed.map(form)].join('\n\n');
    if (text.length <= OUTPUT_LIMITS.text) return text;
  }
  return [...parts, `${listed.length} findings, too many to list here: ${listed.slice(0, 50).map(placeOf).join(', ')}`].join('\n\n');
}

/** A blocking finding as the fix of the review loop is given it (ORC-184): `id`, its lens and its rank among that lens's blocking ones on the commit. */
export type BlockingFinding = ReviewFinding & { id: string };

/** The blocking findings kept on a commit, each with its id (`correctness-1`): stable, as `findingsOf` keeps each lens's order. */
export function blockingFindings(findings: readonly ReviewFinding[]): BlockingFinding[] {
  const rank = new Map<string, number>();
  return findings
    .filter(isBlocking)
    .map((f) => {
      const n = (rank.get(f.lens) ?? 0) + 1;
      rank.set(f.lens, n);
      return { ...f, id: `${f.lens}-${n}` };
    });
}

const findingText = (f: BlockingFinding): string => [`### ${f.id} · ${placeOf(f)}`, ...findingBody(f)].join('\n');

/**
 * The input of the fix of the review loop (ORC-184): the blocking findings of the review, one by one under their ids, and how
 * the factory takes the work back: one commit per finding fixed, or the finding contested with a justification.
 */
export function findingsInput(sha: string, findings: readonly BlockingFinding[]): string {
  if (!findings.length) return `No blocking finding is kept on \`${sha.slice(0, 12)}\`: read the AI review on the PR.`;
  return [
    `The AI review of \`${sha.slice(0, 12)}\` left ${findings.length} blocking finding${findings.length === 1 ? '' : 's'}.`,
    ...findings.map(findingText),
    'Fix each finding in a commit of its own, or contest it with a justification. In `submit_result`, every id above goes either in `fixed`, with the commit that fixes it, or in `contested`, with why it does not apply: a contested finding stays open for the next review.',
  ].join('\n\n');
}

/**
 * What a review lens reads of the previous round (ORC-184): the findings the fix contested, each with its justification. They
 * stay open: the lens judges each again on the commit it reads, and reports it again unless the justification holds. An id
 * the commit's findings no longer have is left out.
 */
export function contestedInput(findings: readonly ReviewFinding[], contested: readonly ContestedFinding[]): string | undefined {
  const byId = new Map(blockingFindings(findings).map((f) => [f.id, f]));
  const open = contested.flatMap((c) => {
    const f = byId.get(c.finding);
    return f ? [`${findingText(f)}\n**Contested by the implementer**: ${c.justification}`] : [];
  });
  if (!open.length) return undefined;
  return [
    'The implementer contested these blocking findings of the previous review. Each one is still open: judge it again on this commit, and report it again as blocking unless its justification holds.',
    ...open,
  ].join('\n\n');
}
