import { captureArtifactId, scenarioPath, type VisualProof } from '../checks/visual-proof.js';
import { prEventId } from '../adapters/forge/github-webhook.js';
import type { TrackerIssue } from '../adapters/tracker/types.js';
import type { ChangelogEntry, ChangelogProof } from '../store/types.js';
import type { Effect } from './decision.js';
import type { EventPayloads, FactoryEvent, TicketState } from './types.js';

/** What the `after_merge` step (ORC-197) is given of the merge. */
export type MergedPr = Extract<Effect, { kind: 'after_merge' }>;

/** The factory's last publication that reached the forge: an `empty` one pushed nothing (ORC-402). */
export function lastPushed(events: readonly FactoryEvent[]): EventPayloads['publish.done'] | undefined {
  return events.findLast((e): e is FactoryEvent<'publish.done'> => e.type === 'publish.done' && !e.payload.empty)?.payload;
}

/**
 * The factory's last push and the head it went over (ORC-438): a publication of the same commit since, which pushed nothing, names
 * none, so the last that does is read. No `before`: the push made the branch, or was journaled before ORC-438.
 */
export function lastPush(events: readonly FactoryEvent[]): { sha: string; before?: string } | undefined {
  const sha = lastPushed(events)?.sha;
  if (!sha) return undefined;
  const before = events.findLast((e): e is FactoryEvent<'publish.done'> => e.type === 'publish.done' && !e.payload.empty && e.payload.sha === sha && !!e.payload.before)?.payload.before;
  return { sha, ...(before ? { before } : {}) };
}

/** The commits the factory pushed, oldest first: one per `publish.done` that reached the forge, a commit published twice in a row once. */
export function pushedHeads(events: readonly FactoryEvent[]): string[] {
  return events
    .flatMap((e) => (e.type === 'publish.done' && !e.payload.empty ? [e.payload.sha] : []))
    .filter((sha, i, all) => sha !== all[i - 1]);
}

/**
 * The work the merged PR carries, as the ticket's journal has it: the green verdict of the merged head when GitHub names it
 * (a human's push verified since, ORC-159), else of the commit the factory published last (ORC-125), else the last green verdict.
 * A run whose publication was `empty` pushed nothing: its verdict carries no work (ORC-402).
 */
export function mergedWork(events: readonly FactoryEvent[], headSha?: string): EventPayloads['verify.passed'] | undefined {
  const nothingPushed = new Set(events.flatMap((e) => (e.type === 'publish.done' && e.payload.empty ? [e.payload.runId] : [])));
  const published = lastPushed(events)?.runId;
  const passed = events.filter((e): e is FactoryEvent<'verify.passed'> => e.type === 'verify.passed').map((e) => e.payload).filter((p) => !nothingPushed.has(p.runId));
  return (headSha ? passed.findLast((p) => p.sha === headSha) : undefined) ?? passed.findLast((p) => p.runId === published) ?? passed.at(-1);
}

/**
 * The changelog entry of a merged PR (ORC-197), named by its merge as the inbox names the event (`prEventId`): a replay of the
 * effect, or the event decided again, finds it. What changed as the published work said it, where (the
 * page the visual proof shot, the paths of the diff that asked for it), the captures `verify` took (ORC-176), and the PR's link.
 */
export function changelogEntry(t: Pick<TicketState, 'projectId' | 'ticketId' | 'title'>, pr: MergedPr, work: EventPayloads['verify.passed'] | undefined): ChangelogEntry {
  const proof = changelogProof(work?.visualProof, work?.runId);
  return {
    id: prEventId(t.ticketId, pr.number, 'merged'),
    projectId: t.projectId,
    ticketId: t.ticketId,
    title: t.title,
    summary: work?.output?.summary ?? t.title,
    prNumber: pr.number,
    prUrl: pr.url,
    ...(pr.mergeSha ? { mergeSha: pr.mergeSha } : {}),
    ...(proof.status === 'taken' ? { page: scenarioPath(work?.output?.visual_scenario?.url) } : {}),
    paths: work?.visualProof?.triggers ?? [],
    visualProof: proof,
    at: pr.at,
  };
}

/** No proof recorded is no proof applicable; a required one with no capture says why. */
function changelogProof(proof: VisualProof | undefined, runId: string | undefined): ChangelogProof {
  if (!proof || proof.decision === 'not_applicable') return { status: 'not_applicable' };
  if (proof.captures?.length && runId) return { status: 'taken', captures: proof.captures.map((c) => ({ ...c, artifactId: captureArtifactId(runId, c) })) };
  return { status: 'unavailable', reason: proof.unavailable ?? 'no capture was kept' };
}

/** What the requester reads in the ticket's session once the PR is merged (ORC-197): their profile's link mentions them in Linear. */
export function deliveredBody(creator: TrackerIssue['creator'], pr: Pick<MergedPr, 'number' | 'url'>): string {
  return `Delivered${creator ? `, ${creator.url}` : ''}: [PR #${pr.number}](${pr.url}) is merged.`;
}
