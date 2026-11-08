import { mdCode } from '../checks/markdown.js';
import type { AgentOutput } from '../core/agent-output.js';
import { spentTokens, type TokenUsage } from '../core/types.js';
import { OUTPUT_LIMITS } from './output-limits.js';

/**
 * A visual-proof capture once published (ORC-176): where the image is, at the width it was shot at. ORC-176 takes them and
 * hosts them; the description only shows them.
 */
export interface PublishedCapture {
  width: number;
  caption: string;
  url: string;
}

/** What the factory itself knows of the work it publishes: never the agent's word. */
export interface PrFacts {
  ticketId: string;
  title: string;
  /** The commit `verify` found green, the one pushed. */
  sha: string;
  /** What `verify` ran on it (ORC-151): absent when an earlier verification found it green, empty when nothing is declared. */
  commands?: readonly string[];
  /** The ticket touches the interface (ORC-206): its evidence must hold captures. */
  visualProof?: 'required';
  captures?: readonly PublishedCapture[];
}

/**
 * The reviewer's fixed order (doc MVP, « Review humaine »): the same in every PR, so a human knows where to look first.
 * ORC-183 (the AI review) adds its findings once the PR is open: their section goes between `Where to look first` and
 * `Evidence`, the one place this order may grow.
 */
export const PR_SECTIONS = ['Why', 'What changes', 'Assumptions', 'Risks', 'Untested', 'Trusted without verification', 'Where to look first', 'Evidence'] as const;

const NONE = '_None stated._';
const NO_RESULT = '_The agent returned no structured result: nothing of what it wrote is published._';

/**
 * An agent's text block, so that nothing of it can pass for one of the factory's sections or hide them: an HTML tag or comment
 * (a heading, a comment that would swallow what follows) shown as text, and on each line an ATX heading, a setext underline and a code fence
 * that would run to the end of the body escaped.
 */
const prose = (s: string): string =>
  s
    // Only a `<` that opens a tag or a comment: `a < b` stays as written.
    .replace(/<(?=[A-Za-z!/?])/g, '&lt;')
    .replace(/^(\s{0,3})(#|=+\s*$|-+\s*$|`{3}|~{3})/gm, '$1\\$2');
/** An agent's list entry, on its one line: a line break would let it open a heading or an entry of its own. */
const entry = (s: string): string => prose(s.replace(/\s*[\r\n]+\s*/g, ' ').trim());
/** A capture's URL in a Markdown link: what would end the link or break it, percent-encoded. */
const linkUrl = (url: string): string => url.replace(/[\s()<>[\]]/g, (c) => encodeURIComponent(c));
/**
 * What the factory's own facts may add to a description past the agent's fields: the ticket's id, the commands `verify` ran, the
 * captures. `submit_result` keeps the agent's part under the cap of a PR body by this much (`publishedSizeIssues`).
 */
export const FACTS_ROOM = 1_500;
const bullets = (items: readonly string[]): string => (items.length ? items.map((i) => `- ${i}`).join('\n') : NONE);

/** The PR's title: the ticket's id and title, on one line clipped to what GitHub takes. */
function prTitle(f: Pick<PrFacts, 'ticketId' | 'title'>): string {
  const title = `${f.ticketId} ${f.title.replace(/\s+/g, ' ').trim()}`;
  return title.length > OUTPUT_LIMITS.prTitle ? `${title.slice(0, OUTPUT_LIMITS.prTitle - 1)}…` : title;
}

/**
 * What `verify` found on the commit pushed (ORC-151), in the same words on the PR and on its `factory/verify` check: `commands`
 * absent when an earlier verification found it green, empty when none is declared.
 */
export function verifySummary(sha: string, commands: readonly string[] | undefined): { conclusion: 'success' | 'neutral'; summary: string } {
  if (commands === undefined) return { conclusion: 'success', summary: `${sha.slice(0, 12)} already found green by an earlier verification.` };
  if (!commands.length) return { conclusion: 'neutral', summary: 'No verification command declared: nothing ran.' };
  return { conclusion: 'success', summary: `Green on ${sha.slice(0, 12)}, in a fresh clone, without network:\n${commands.map((c) => `- ${mdCode(c)}`).join('\n')}` };
}

function evidence(o: AgentOutput | undefined, f: PrFacts): string {
  const parts = [`**Checked by the factory**: ${verifySummary(f.sha, f.commands).summary}`];
  if (o) parts.push(`**Tests added**, as stated by the agent:\n${bullets(o.tests_added.map((t) => mdCode(entry(t))))}`);
  if (f.visualProof === 'required') {
    const shots = [...(f.captures ?? [])].sort((a, b) => a.width - b.width);
    parts.push(
      shots.length
        ? `**Screens**:\n${shots.map((c) => `![${entry(c.caption).replace(/[[\]]/g, '')} (${c.width} px)](${linkUrl(c.url)})`).join('\n')}`
        : '**Screens**: the visual proof is required for this ticket, and no capture was taken.',
    );
  }
  return parts.join('\n\n');
}

/**
 * The PR's title and body (ORC-195), composed by the factory in the reviewer's fixed order (`PR_SECTIONS`) from the structured
 * output (`submit_result`) and the factory's own facts, never copied from the agent's free text. Pure: the `OutputPolicy`
 * vets what it composes before anything goes out. An empty field keeps its place, said empty. No closing keyword: it would be
 * a claim on the whole ticket, and nothing here can make it.
 */
export function describePr(o: AgentOutput | undefined, f: PrFacts): { title: string; body: string } {
  const list = (items: readonly string[] | undefined) => (o ? bullets((items ?? []).map(entry)) : NO_RESULT);
  const text: Record<(typeof PR_SECTIONS)[number], string> = {
    Why: o ? (o.why.trim() ? prose(o.why.trim()) : NONE) : NO_RESULT,
    'What changes': o ? prose(o.summary.trim()) : NO_RESULT,
    Assumptions: list(o?.assumptions),
    Risks: list(o?.risks),
    Untested: list(o?.untested),
    // The approved spec's section (ORC-212), as the agent carries it: ORC-212 may hand the spec's own once it keeps it.
    'Trusted without verification': list(o?.trusted),
    'Where to look first': o ? bullets(o.review_hints.map((h) => `${mdCode(entry(h.file))}: ${entry(h.reason)}`)) : NO_RESULT,
    Evidence: evidence(o, f),
  };
  return { title: prTitle(f), body: [`Ticket: ${f.ticketId}`, ...PR_SECTIONS.map((s) => `## ${s}\n\n${text[s]}`)].join('\n\n') };
}

/** One attempt of the ticket as the recap reads it: its measure (`RunMeasure`, ORC-223), never its text. */
export interface RecapRun {
  turns: number;
  tokens: TokenUsage | null;
  durationMs: number | null;
}

const count = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  return m ? `${m} min ${sec} s` : `${sec} s`;
}

/**
 * The recap posted as the ticket goes to Human Review and its PR out of draft (ORC-195): the summary, the tests added, and the
 * work of the ticket's attempts, as the dashboard measures it (turns, tokens, duration: tokens, where Relais counted dollars).
 * Tokens are what a token cap counts (`spentTokens`), cache reads apart. Every attempt of the ticket counts, as on the dashboard:
 * intake, tests and questions too. What is not known is said, never shown as a zero.
 */
export function formatRecap(o: Pick<AgentOutput, 'summary' | 'tests_added'>, runs: readonly RecapRun[]): string {
  const reported = runs.filter((r) => r.tokens !== null);
  const unreported = runs.length - reported.length;
  const total = reported.reduce((sum, r) => sum + spentTokens(r.tokens!), 0);
  const tokens = reported.length ? `${count(total, 'token')} (cache reads apart${unreported ? `; ${count(unreported, 'attempt')} reported none` : ''})` : 'tokens not reported';
  const timed = runs.filter((r) => r.durationMs !== null);
  const untimed = runs.length - timed.length;
  const took = timed.length ? `${duration(timed.reduce((sum, r) => sum + r.durationMs!, 0))}${untimed ? ` (${count(untimed, 'attempt')} not measured)` : ''}` : 'duration not measured';
  const turns = runs.reduce((sum, r) => sum + r.turns, 0);
  return [
    o.summary,
    `**Tests added**\n${bullets(o.tests_added.map((t) => mdCode(entry(t))))}`,
    `**Work**: ${count(runs.length, 'attempt')}, ${count(turns, 'turn')}, ${tokens}, ${took}.`,
  ].join('\n\n');
}
