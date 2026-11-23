import { mdCode } from '../checks/markdown.js';
import type { VisualProof } from '../checks/visual-proof.js';
import type { AgentOutput } from '../core/agent-output.js';
import type { RunMeasure } from '../core/measures.js';
import { spentTokens } from '../core/types.js';
import { OUTPUT_LIMITS } from './output-limits.js';

/**
 * A visual-proof capture once published (ORC-176): where the image is, at the width it was shot at. ORC-176 takes them, ORC-407
 * hosts them on the repository's `factory/artifacts` branch; the description only shows them.
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
  /** Where `verify` took the command that starts the application from (ORC-386), for a proof it found required. */
  start?: VisualProof['start'];
  captures?: readonly PublishedCapture[];
  /** Why the captures `verify` took are not shown (ORC-407): the forge refused to host them, or nothing here can. */
  unhosted?: string;
  /** The two worst of `factory/qualité-diff` (ORC-280), as its check words them: the factory's measure, after the agent's hints. */
  lookFirst?: readonly string[];
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
/**
 * A capture's URL in a Markdown link: what would end the link or break it, percent-encoded. `encodeURIComponent` leaves `(` and
 * `)` as they are, and a `)` ends the link: those two by hand.
 */
const linkUrl = (url: string): string => url.replace(/[\s()<>[\]]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)));
/**
 * What `lookFirst` may add to « Where to look first » (ORC-280): its heading and two lines of the measure, each with two paths
 * or a path and a name, which `readQuality` clips to 120 characters.
 */
export const MEASURE_ROOM = 700;
/**
 * What the factory's own facts may add to a description past the agent's fields: the ticket's id, the commands `verify` ran, the
 * captures, six links of about 175 characters each (ORC-407), and the measure (`MEASURE_ROOM`). `submit_result` keeps the agent's
 * part under the cap of a PR body by this much (`publishedSizeIssues`).
 */
export const FACTS_ROOM = 2_500 + MEASURE_ROOM;
const bullets = (items: readonly string[]): string => (items.length ? items.map((i) => `- ${i}`).join('\n') : NONE);
/** The tests the agent says it added, the same in the PR and in the recap. */
const testsList = (o: Pick<AgentOutput, 'tests_added'>): string => bullets(o.tests_added.map((t) => mdCode(entry(t))));

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

/** Where the start command came from (ORC-386), the same words in the PR and on `factory/preuve-visuelle`. */
export const START_SAID = {
  declared: 'declared by the repository (`preview` in `.factory/config.yml`).',
  learned: 'learned in the knowledge base (`notes/preview/`).',
  found: 'found by the build agent on this ticket, and started by the factory, which saw it answer on `PORT` before using it.',
  none: 'none: neither declared nor learned, so no capture could be taken.',
} as const;

function evidence(o: AgentOutput | undefined, f: PrFacts): string {
  const parts = [`**Checked by the factory**: ${verifySummary(f.sha, f.commands).summary}`];
  if (o) parts.push(`**Tests added**, as stated by the agent:\n${testsList(o)}`);
  const shots = [...(f.captures ?? [])].sort((a, b) => a.width - b.width);
  // A proof `visual_paths` required has captures without the ticket asking at intake: they show all the same (ORC-407).
  if (shots.length) parts.push(`**Screens**:\n${shots.map((c) => `![${entry(c.caption).replace(/[[\]]/g, '')} (${c.width} px)](${linkUrl(c.url)})`).join('\n')}`);
  else if (f.unhosted) parts.push(`**Screens**: taken by the factory, not shown here: ${entry(f.unhosted)}`);
  else if (f.visualProof === 'required') parts.push('**Screens**: the visual proof is required for this ticket, and no capture was taken.');
  // Set by `verify` whenever the proof was required, by `visual_paths` as by intake.
  if (f.start) parts.push(`**Start command**: ${START_SAID[f.start]}`);
  return parts.join('\n\n');
}

/**
 * The PR's title and body (ORC-195), composed by the factory in the reviewer's fixed order (`PR_SECTIONS`) from the structured
 * output (`submit_result`) and the factory's own facts, never copied from the agent's free text. Pure: the `OutputPolicy`
 * vets what it composes before anything goes out. An empty field keeps its place, said empty. No closing keyword: it would be
 * a claim on the whole ticket, and nothing here can make it.
 */
export function describePr(o: AgentOutput | undefined, f: PrFacts): { title: string; body: string } {
  /** A section of the agent's, or the notice that it returned nothing. */
  const agent = (section: (r: AgentOutput) => string) => (o ? section(o) : NO_RESULT);
  const list = (items: readonly string[]) => bullets(items.map(entry));
  const text: Record<(typeof PR_SECTIONS)[number], string> = {
    Why: agent((r) => prose(r.why.trim()) || NONE),
    'What changes': agent((r) => prose(r.summary.trim())),
    Assumptions: agent((r) => list(r.assumptions)),
    Risks: agent((r) => list(r.risks)),
    Untested: agent((r) => list(r.untested)),
    // The approved spec's section (ORC-212), as the agent carries it: ORC-212 may hand the spec's own once it keeps it.
    'Trusted without verification': agent((r) => list(r.trusted ?? [])),
    'Where to look first': [agent((r) => bullets(r.review_hints.map((h) => `${mdCode(entry(h.file))}: ${entry(h.reason)}`))), ...(f.lookFirst?.length ? [`**Measured by the factory** (\`factory/qualité-diff\`):\n${bullets(f.lookFirst)}`] : [])].join('\n\n'),
    Evidence: evidence(o, f),
  };
  return { title: prTitle(f), body: [`Ticket: ${f.ticketId}`, ...PR_SECTIONS.map((s) => `## ${s}\n\n${text[s]}`)].join('\n\n') };
}

/** One attempt of the ticket as the recap reads it: its measure (ORC-223), never its text. */
export type RecapRun = Pick<RunMeasure, 'turns' | 'tokens' | 'durationMs'>;

const count = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  return m ? `${m} min ${sec} s` : `${sec} s`;
}

/**
 * The recap posted as the ticket goes to Human Review and its PR out of draft (ORC-195): the end of a build as ORC-289 posts it
 * (the summary, then why, risks, untested and what to review when stated), the tests added, and the work of every attempt of the
 * ticket (intake, tests and questions too), each measured as the dashboard measures it (`runMeasure`): turns, tokens, duration
 * (tokens, where the factory once counted dollars). Tokens are what a token cap counts (`spentTokens`), cache reads apart. What is
 * not known is said, never shown as a zero.
 */
export function formatRecap(o: Pick<AgentOutput, 'summary' | 'why' | 'risks' | 'untested' | 'review_hints' | 'tests_added'>, runs: readonly RecapRun[]): string {
  const section = (title: string, items: readonly string[]) => (items.length ? [`**${title}**\n${bullets(items)}`] : []);
  /** The sum of what is known of the attempts, and how many are unknown. */
  const known = (pick: (r: RecapRun) => number | null) => {
    const values = runs.map(pick).filter((v): v is number => v !== null);
    return { sum: values.reduce((a, b) => a + b, 0), any: values.length > 0, missing: runs.length - values.length };
  };
  const unknown = (n: number, what: string) => (n ? `${count(n, 'attempt')} ${what}` : '');
  const tokens = known((r) => (r.tokens ? spentTokens(r.tokens) : null));
  const took = known((r) => r.durationMs);
  const tokenText = tokens.any ? `${count(tokens.sum, 'token')} (${['cache reads apart', unknown(tokens.missing, 'reported none')].filter(Boolean).join('; ')})` : 'tokens not reported';
  const tookText = took.any ? `${duration(took.sum)}${took.missing ? ` (${unknown(took.missing, 'not measured')})` : ''}` : 'duration not measured';
  const turns = runs.reduce((sum, r) => sum + r.turns, 0);
  return [
    prose(o.summary),
    ...(o.why.trim() ? [`**Why**: ${entry(o.why)}`] : []),
    ...section('Risks', o.risks.map(entry)),
    ...section('Untested', o.untested.map(entry)),
    ...section('To review', o.review_hints.map((h) => `${mdCode(entry(h.file))}: ${entry(h.reason)}`)),
    `**Tests added**\n${testsList(o)}`,
    `**Work**: ${count(runs.length, 'attempt')}, ${count(turns, 'turn')}, ${tokenText}, ${tookText}.`,
  ].join('\n\n');
}
