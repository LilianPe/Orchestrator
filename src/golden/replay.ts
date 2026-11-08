import type { GoldenSet, GoldenTicket, Risk } from './golden-set.js';

/**
 * The replay of the golden tickets (ORC-236): each ticket of the frozen set run `passes` times, the report
 * giving every pass, and the tickets of which a pass changed since the baseline. A pass is a ticket
 * through the pipeline with no external effect: in CI, on the fake adapters and a fake runner
 * (`test/golden/`); with a real model, through the `fantome` preset and the outbox without effect of ORC-231.
 */

/** What a pass ended on: the PR the factory would open (kept as an artifact, never opened), a block, or neither. */
export type GoldenVerdict = 'pr' | 'blocked' | 'no_pr';

export interface GoldenPass {
  verdict: GoldenVerdict;
  /** Fingerprint of what the runs received (prompt, skill, model, settings): changes with a prompt, a skill or a preset. */
  inputs: string;
  /** The PR the pass would have opened, kept as an artifact of the replay. */
  pr?: { branch: string; title: string };
}

export interface GoldenReport {
  /** Fingerprint of the set replayed. */
  set: string;
  passes: number;
  tickets: { ticket: string; risk: Risk; passes: GoldenPass[] }[];
}

export interface GoldenChange {
  ticket: string;
  /** The passes whose verdict changed; `before` (`after`) undefined when the baseline (the replay) did not have it. */
  passes: { pass: number; before: GoldenVerdict | undefined; after: GoldenVerdict | undefined }[];
  inputsChanged: boolean;
}

export type RunGoldenPass = (ticket: GoldenTicket, pass: number) => Promise<GoldenPass>;

/** Runs every pass of every ticket, one after the other: a pass never sees another's state. */
export async function replayGoldenSet(set: GoldenSet, runPass: RunGoldenPass): Promise<GoldenReport> {
  const tickets: GoldenReport['tickets'] = [];
  for (const t of set.tickets) {
    const passes: GoldenPass[] = [];
    for (let n = 1; n <= set.passes; n++) passes.push(await runPass(t, n));
    tickets.push({ ticket: t.ticket, risk: t.risk, passes });
  }
  return { set: set.fingerprint, passes: set.passes, tickets };
}

/**
 * The tickets with at least one pass whose verdict differs from the same pass in `before`, a pass gone or new
 * included, or whose runs received other inputs; then the tickets of `before` the replay no longer has. A
 * baseline of another set compares nothing: each ticket is then new.
 */
export function compareGoldenReports(before: GoldenReport, after: GoldenReport): GoldenChange[] {
  const old = new Map(before.set === after.set ? before.tickets.map((t) => [t.ticket, t]) : []);
  const changes: GoldenChange[] = [];
  const compare = (ticket: string, was: GoldenPass[], now: GoldenPass[]) => {
    const count = Math.max(was.length, now.length);
    const passes = Array.from({ length: count }, (_, i) => ({ pass: i + 1, before: was[i]?.verdict, after: now[i]?.verdict })).filter((p) => p.before !== p.after);
    const inputsChanged = Array.from({ length: count }, (_, i) => was[i]?.inputs !== now[i]?.inputs).some(Boolean);
    if (passes.length || inputsChanged) changes.push({ ticket, passes, inputsChanged });
  };
  for (const t of after.tickets) {
    compare(t.ticket, old.get(t.ticket)?.passes ?? [], t.passes);
    old.delete(t.ticket);
  }
  for (const t of old.values()) compare(t.ticket, t.passes, []);
  return changes;
}

/** The report of a replay, in Markdown: ticket by ticket with each pass, then what changed since the baseline. */
export function formatGoldenReport(report: GoldenReport, changes: GoldenChange[]): string {
  const passes = Array.from({ length: report.passes }, (_, i) => `Pass ${i + 1}`);
  const lines = [
    `# Golden tickets replay`,
    '',
    `Set ${report.set.slice(0, 12)}, ${report.tickets.length} tickets, ${report.passes} passes each.`,
    '',
    `| Ticket | Risk | ${passes.join(' | ')} |`,
    `|---|---|${passes.map(() => '---|').join('')}`,
    ...report.tickets.map((t) => `| ${t.ticket} | ${t.risk} | ${t.passes.map((p) => p.verdict).join(' | ')} |`),
    '',
  ];
  if (!changes.length) return [...lines, 'Changed since the baseline: none.', ''].join('\n');
  lines.push(`Changed since the baseline: ${changes.length} ticket${changes.length > 1 ? 's' : ''}`, '');
  for (const c of changes) {
    const what = c.passes.map((p) => `pass ${p.pass} ${p.before ?? '(none)'} → ${p.after ?? '(none)'}`);
    if (c.inputsChanged) what.push('its runs received other inputs');
    lines.push(`- ${c.ticket}: ${what.join('; ')}`);
  }
  return [...lines, ''].join('\n');
}
