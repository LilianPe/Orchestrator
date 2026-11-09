import { parseStreamLine } from '../adapters/runner/stream-parser.js';
import type { Blocker, TicketState } from './types.js';

/**
 * What the answer agent reads of the run beside the question (ORC-182): its state as the projection has it, the transcript
 * of the session at work, the linked tickets. Pure; `Orchestrator.launch` reads their sources.
 */

/** Characters of the transcript the prompt carries, its end kept: the reasoning that led to where the agent is now. */
export const TRANSCRIPT_MAX = 12_000;

/** The run's state: the step at work, the attempts each bound counts, the block and what the ticket waits for. */
export function formatRunState(t: TicketState): string {
  const lines = [`State: ${t.logical}`];
  if (t.activeJob) lines.push(`Running: ${t.activeJob}`);
  else if (t.verifyingRunId) lines.push('Running: verification');
  else lines.push('Running: nothing');
  if (t.blocked) lines.push(`Blocked: ${t.blockReason ?? 'no recorded reason'}`);
  if (t.waitingOn) lines.push(`Waiting for: ${t.waitingOn.blockers.join(', ')} to be done`);
  const attempts = [
    ['failed checks in a row', t.verifyAttempts],
    ['rounds of the review and CI loop', t.ciFixAttempts],
    ['rounds of human review', t.humanReviewRounds ?? 0],
  ] as const;
  lines.push(`Attempts: ${attempts.map(([what, n]) => `${n} ${what}`).join(', ')}`);
  if (t.prUrl) lines.push(`PR: ${t.prUrl}${t.prChecks ? ` (CI ${t.prChecks})` : ''}`);
  return lines.join('\n');
}

/**
 * The transcript of a run as text, its end within `max` characters: what the agent wrote and the tools it called, each tool
 * by what it acted on. Nothing of the tools' results, which the transcript does not keep. Undefined when nothing is left.
 */
export function formatTranscript(lines: readonly string[], max = TRANSCRIPT_MAX): string | undefined {
  const said = lines.flatMap(parseStreamLine).flatMap((e) => {
    if (e.kind === 'text' && e.text.trim()) return [e.text.trim()];
    if (e.kind === 'tool') return [`[${e.name}] ${e.input}`];
    return [];
  });
  if (!said.length) return undefined;
  const all = said.join('\n');
  return all.length > max ? `[… ${all.length - max} earlier characters left out]\n${all.slice(-max)}` : all;
}

/** The tickets this one is « blocked by » in the tracker (ORC-363), as the launch read them. */
export function formatLinked(blockers: readonly Blocker[] | undefined): string | undefined {
  return blockers?.length ? blockers.map((b) => `- ${b.identifier} (${b.stateName}), blocks this ticket`).join('\n') : undefined;
}
