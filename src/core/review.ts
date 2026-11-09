import type { ReviewLens } from '../config/workflow-schema.js';
import { OUTPUT_LIMITS } from '../publish/output-limits.js';
import type { Finding, FindingSeverity } from './agent-output.js';

/**
 * The AI review (ORC-183): two read-only lenses on the published commit, whose findings the factory publishes as one GitHub
 * review and the `factory/review` check. The pure part: what a lens reads of the diff, the verdict, and the texts around the
 * findings, which the `OutputPolicy` vets before they go out.
 */

/** The check the review publishes on the commit it read: failed while a blocking finding stands. */
export const REVIEW_CHECK = 'factory/review';
/** The built-in tools a lens has: it reads and searches its clone, it writes nothing and runs no command. */
export const REVIEW_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

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
  return [
    `**${LABEL[f.severity]}** · ${f.lens} lens`,
    f.explanation,
    ...(f.suggestion ? [`**Suggestion**: ${f.suggestion}`] : []),
    ...(f.fact ? [`Violates fact \`${f.fact}\`.`] : []),
  ].join('\n\n');
}

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
  const place = (f: ReviewFinding) => `\`${f.file}:${f.line}\``;
  const forms = [
    (f: ReviewFinding) => `${place(f)}\n${inlineComment(f)}`,
    (f: ReviewFinding) => `${place(f)} **${LABEL[f.severity]}** · ${f.lens} lens: ${f.explanation.length > SHORT ? `${f.explanation.slice(0, SHORT)}…` : f.explanation}`,
    (f: ReviewFinding) => `${place(f)} **${LABEL[f.severity]}** · ${f.lens} lens`,
  ];
  for (const form of forms) {
    const text = [...parts, ...listed.map(form)].join('\n\n');
    if (text.length <= OUTPUT_LIMITS.text) return text;
  }
  return [...parts, `${listed.length} findings, too many to list here: ${listed.slice(0, 50).map(place).join(', ')}`].join('\n\n');
}
