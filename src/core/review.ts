import type { ReviewLens } from '../config/workflow-schema.js';
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

/** The diff a lens is given in its prompt, at most; past it, the changed files, read in its clone. */
export const DIFF_MAX = 60_000;

/** The diff, or past `max` the changed files (`stat`, read only then); `undefined`, a diff whose reading stopped past the cap. */
export async function capDiff(diff: string | undefined, stat: () => Promise<string>, max = DIFF_MAX): Promise<string> {
  if (diff !== undefined && !diff.trim()) return '(no change against the trunk)';
  if (diff !== undefined && diff.length <= max) return diff;
  return `The diff has more than ${max} characters: read the changed files in the clone.\n\n${await stat()}`;
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

/** A finding as a comment on its line. */
export function inlineComment(f: ReviewFinding): string {
  return [
    `**${LABEL[f.severity]}** · ${f.lens} lens`,
    f.explanation,
    ...(f.suggestion ? [`**Suggestion**: ${f.suggestion}`] : []),
    ...(f.fact ? [`Violates fact \`${f.fact}\`.`] : []),
  ].join('\n\n');
}

/**
 * The review's own text: the verdict, then each finding with its place when they could not go on their lines (`inline: false`,
 * GitHub refused one). Both lenses ran: the second starts only once the first one's findings are kept.
 */
export function reviewBody(sha: string, findings: readonly ReviewFinding[], o: { inline: boolean }): string {
  const head = `**AI review** of \`${sha.slice(0, 12)}\` (correctness and security lenses): ${reviewVerdict(findings).summary}.`;
  if (!findings.length) return `${head}\n\nNo finding.`;
  if (o.inline) return `${head}\n\nEach finding is a comment on its line.`;
  return [head, ...findings.map((f) => `\`${f.file}:${f.line}\`\n${inlineComment(f)}`)].join('\n\n');
}
