import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { upcastTicket } from '../../src/core/upcast.js';
import { formatReplay, readJournal, replayJournal, type ExportedJournal } from '../../src/runtime/replay.js';
import { loadTestWorkflow } from '../helpers/harness.js';
import { testPreset } from '../helpers/test-preset.js';
import { asVersion1, record as recordScenario, recordedFiles, scenarioWorkflow, SCENARIOS } from './scenarios.js';

// Replay must never reach the small model of messages (ORC-336): any call to it fails this file.
vi.mock('../../src/adapters/runner/message-classifier.js', () => {
  const never = () => {
    throw new Error('the small model was called on replay');
  };
  return { messageClassifier: never, apiClassifier: never, cliClassifier: never };
});

const dir = join(import.meta.dirname, 'journals');

/** A deep copy, to change a journal without touching the recorded one. */
const copy = (j: ExportedJournal): ExportedJournal => JSON.parse(JSON.stringify(j)) as ExportedJournal;

const shown = (v: unknown) => {
  const s = JSON.stringify(v) ?? 'absent';
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * The first place where two parsed journals differ, as `entries[3].decision.before.status`. Objects whose
 * keys differ are reported by those keys (a new projection field, a changed workflow hash), not walked.
 */
function firstDifference(committed: unknown, recorded: unknown, path = ''): string {
  const at = path || 'the root';
  if (isObject(committed) && isObject(recorded) && Array.isArray(committed) === Array.isArray(recorded)) {
    const only = (a: object, b: object) => Object.keys(a).filter((k) => !Object.hasOwn(b, k));
    const [gone, added] = [only(committed, recorded), only(recorded, committed)];
    if (!Array.isArray(recorded) && gone.length + added.length > 0) {
      return `keys differ at ${at}: only committed has ${shown(gone)}, only recorded has ${shown(added)}`;
    }
    for (const key of new Set([...Object.keys(committed), ...Object.keys(recorded)])) {
      const diff = firstDifference(committed[key], recorded[key], Array.isArray(recorded) ? `${path}[${key}]` : path ? `${path}.${key}` : key);
      if (diff) return diff;
    }
    return '';
  }
  if (JSON.stringify(committed) === JSON.stringify(recorded)) return '';
  return `first difference at ${at}: committed ${shown(committed)}, recorded ${shown(recorded)}`;
}

/** Why a committed journal is not the recorded one. */
function drift(committed: string | undefined, recorded: string): string {
  if (committed === undefined) return 'missing';
  let was: unknown;
  try {
    was = JSON.parse(committed);
  } catch {
    return 'not valid JSON';
  }
  return firstDifference(was, JSON.parse(recorded)) || 'same content, written differently';
}

/** Each scenario runs once; every test gets its own copy of the journal. */
const recorded = new Map<string, Promise<ExportedJournal>>();
async function record(name: string): Promise<ExportedJournal> {
  if (!recorded.has(name)) recorded.set(name, recordScenario(name));
  return copy(await recorded.get(name)!);
}

describe('replay oracle (ORC-174)', () => {
  it('replays a message by the class journaled with it, never asking a model again (ORC-336)', () => {
    const journal = readJournal(readFileSync(join(dir, 'human-reply-during-run.json'), 'utf8'));
    expect(replayJournal(journal).divergences).toEqual([]);
    // Another class in the journal is another decision: the class read is the journaled one, not a new verdict.
    const asked = journal.entries.find((e) => e.event.type === 'session.prompted' && (e.event.payload as { kind?: string }).kind === 'question')!;
    (asked.event.payload as { kind: string }).kind = 'instruction';
    expect(replayJournal(journal).divergences.length).toBeGreaterThan(0);
  });

  it('replays a journal recorded by the unchanged engine: projection and effects identical bit for bit', async () => {
    const journal = await record('check-failed-then-feedback');
    const report = replayJournal(journal);
    expect(report.replayed).toBe(journal.entries.length);
    expect(report).toMatchObject({ mode: 'regression', unrecorded: 0, upcast: 0, divergences: [] });
    expect(formatReplay(report)).toMatch(/identical bit for bit$/);
  });

  it('reports a decision that no longer comes out as recorded, at its exact event', async () => {
    const journal = await record('review-merge-done');
    const at = journal.entries.findIndex((e) => e.event.type === 'pr.merged');
    const recorded = journal.entries[at]!.decision!;
    // As if the engine that recorded it had decided another move: today's engine no longer does.
    const k = recorded.effects.findIndex((e) => e.kind === 'move');
    recorded.effects[k] = { kind: 'move', to: 'human_review' };
    const report = replayJournal(journal);
    expect(report.divergences).toEqual([
      {
        seq: recorded.seq,
        eventId: recorded.eventId,
        eventType: 'pr.merged',
        field: 'effects',
        path: `effects[${k}].to`,
        recorded: '"human_review"',
        replayed: '"done"',
      },
    ]);
  });

  it('what-if: stops at the first event whose decision differs under a modified preset, and names it', async () => {
    const journal = await record('check-failed-then-feedback');
    // Recorded with two check attempts: the failed check resumed the run. With one, it blocks the ticket.
    const report = replayJournal(journal, { mode: 'what-if', workflow: loadTestWorkflow(testPreset({ verifyAttempts: 1 }).yaml) });
    const failed = journal.entries.find((e) => e.event.type === 'verify.failed')!;
    expect(new Set(report.divergences.map((d) => d.eventId))).toEqual(new Set([failed.event.id]));
    expect(report.divergences[0]).toMatchObject({ eventType: 'verify.failed', seq: failed.decision!.seq });
    // Stopped there: the decisions before it, and this one, were replayed; none after.
    expect(report.replayed).toBe(journal.entries.indexOf(failed) + 1);
    expect(report.divergences.map((d) => d.field)).toContain('ticket');
    expect(formatReplay(report)).toContain(`event ${failed.event.id} (verify.failed`);
  });

  it('what-if under the same preset finds no divergence', async () => {
    const journal = await record('check-failed-then-feedback');
    const report = replayJournal(journal, { mode: 'what-if', workflow: loadTestWorkflow(testPreset().yaml) });
    expect(report.divergences).toEqual([]);
    expect(report.replayed).toBe(journal.entries.length);
  });

  it('reads a journal written in an older schemaVersion through the upcasters before decide', async () => {
    const journal = asVersion1(await record('review-merge-done'));
    const old = journal.entries.filter((e) => e.event.schemaVersion === undefined);
    expect(old.map((e) => e.event.type)).toEqual(['ticket.moved']);
    const report = replayJournal(journal);
    expect(report).toMatchObject({ upcast: 1, divergences: [] });
    expect(report.replayed).toBe(journal.entries.length);
  });

  it('counts journal rows without a recorded decision, and compares the others', async () => {
    const journal = await record('review-merge-done');
    delete journal.entries[0]!.decision;
    expect(replayJournal(journal)).toMatchObject({ unrecorded: 1, replayed: journal.entries.length - 1, divergences: [] });
  });

  it('replays a dead letter and its repair: the block, then the replayed event on the unblocked ticket (ORC-175)', async () => {
    const journal = await record('dead-letter-then-repair');
    const added = journal.entries.find((e) => e.event.type === 'dead_letter.added')!;
    const repaired = journal.entries.find((e) => e.event.type === 'dead_letter.repaired')!;
    expect(added.decision!.ticket).toMatchObject({ blocked: true });
    expect(repaired.decision!.ticket).toMatchObject({ blocked: false, humanInbox: [expect.objectContaining({ body: 'et le mobile ?' })] });
    // The dead-lettered reply itself is not journaled: only its repair, which carries it.
    expect(journal.entries.map((e) => e.event.id)).not.toContain((repaired.event.payload as { eventId: string }).eventId);
    expect(replayJournal(journal)).toMatchObject({ divergences: [], replayed: journal.entries.length });
    // A repair recorded as a skip that replays as a replay is caught at its exact event.
    (repaired.event.payload as { action: string }).action = 'skip';
    expect(new Set(replayJournal(journal).divergences.map((d) => d.eventId))).toEqual(new Set([repaired.event.id]));
  });

  it('refuses a journal whose workflow version is missing, and a file of another format', async () => {
    const journal = await record('review-merge-done');
    journal.workflows = {};
    expect(() => replayJournal(journal)).toThrow(/is not in the journal/);
    expect(() => readJournal('{"format":2}', 'x.json')).toThrow(/x.json/);
  });
});

describe('recorded journals (test/replay/journals)', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('has journals to replay, one in schema version 1', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.some((f) => f.includes('.v1.') && !f.includes('.pre-orc-'))).toBe(true);
  });

  // Kept as the engine before ORC-161 recorded it; `npm run replay:record` does not write it again.
  it('replays a journal of schema version 2: its debounce.fired and job-bound timers read as the generic timer (ORC-161)', () => {
    const journal = readJournal(readFileSync(join(dir, 'check-failed-then-feedback.v2.json'), 'utf8'));
    const fired = journal.entries.filter((e) => e.event.type === 'debounce.fired');
    expect(fired).toHaveLength(1);
    expect(journal.entries.flatMap((e) => e.decision?.timers ?? []).every((t) => 'job' in t && !('kind' in t))).toBe(true);
    const report = replayJournal(journal);
    expect(report).toMatchObject({ upcast: journal.entries.length, divergences: [] });
    expect(report.replayed).toBe(journal.entries.length);
    // As the journal recorded today has it.
    const today = readJournal(readFileSync(join(dir, 'check-failed-then-feedback.json'), 'utf8'));
    expect(today.entries.filter((e) => e.event.type === 'timer.fired').map((e) => e.event.payload)).toEqual([{ kind: 'debounce', payload: { job: 'dev-feedback' } }]);
  });

  it("keeps a signed actor and an untrusted event's taint through the journal, and their decisions (ORC-160)", () => {
    const journal = readJournal(readFileSync(join(dir, 'signed-actor-then-untrusted.json'), 'utf8'));
    const by = (type: string) => journal.entries.find((e) => e.event.type === type)!;
    expect(by('ticket.delegated').event).toMatchObject({ taint: 'trusted', actor: 'user-lilian' });
    expect(by('session.prompted').event).toMatchObject({ taint: 'untrusted' });
    expect(by('session.prompted').event).not.toHaveProperty('actor');
    expect(by('timer.fired').decision?.effects).toEqual([expect.objectContaining({ kind: 'start_run', job: 'dev-feedback', sensitivePaths: expect.any(Array) })]);
    expect(by('command').decision?.trace).toContain('taint: refused remember');
    expect(replayJournal(journal).divergences).toEqual([]);
  });

  it('journals the roles each human event was decided on, and replays a refusal and an allowed action the same (ORC-186)', () => {
    const journal = readJournal(readFileSync(join(dir, 'authz-refused-then-allowed.json'), 'utf8'));
    const delegations = journal.entries.filter((e) => e.event.type === 'ticket.delegated');
    expect(delegations.map((e) => [e.event.actor, e.event.roles])).toEqual([
      ['user-armand', ['team_member']],
      ['user-lilian', ['team_member', 'repo_writer', 'repo_merger']],
    ]);
    expect(delegations[0]!.decision?.trace).toContainEqual(expect.stringMatching(/^authz: refused trigger to user-armand/));
    expect(delegations[0]!.decision?.effects).toEqual([expect.objectContaining({ kind: 'activity', linearSessionId: 'ls-1', body: expect.stringMatching(/^Refused:/) })]);
    expect(delegations[1]!.decision?.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'dev' }));
    const replies = journal.entries.filter((e) => e.event.type === 'session.prompted');
    expect(replies.map((e) => e.event.actor)).toEqual(['user-stranger', 'user-armand']);
    expect(replies[0]!.decision?.trace).toContainEqual(expect.stringMatching(/^authz: refused answer_clarify to user-stranger/));
    expect(upcastTicket(replies[1]!.decision!.ticket!).humanInbox.map((f) => f.body)).toEqual(['le bouton export est mal placé']);
    expect(replayJournal(journal)).toMatchObject({ divergences: [], replayed: journal.entries.length });
    // A refusal recorded on other roles is caught at its exact event: the roles are part of what is replayed.
    delegations[0]!.event.roles = ['team_member', 'repo_writer'];
    expect(new Set(replayJournal(journal).divergences.map((d) => d.eventId))).toEqual(new Set([delegations[0]!.event.id]));
  });

  it('reads a decision recorded before ORC-180 through the ticket upcaster: its pendingFeedback is the human inbox', () => {
    // The copy of the .v1 journal: its ticket.moved goes through the event upcaster on the same replay.
    const journal = readJournal(readFileSync(join(dir, 'review-merge-done.v1.pre-orc-310.json'), 'utf8'));
    expect(journal.entries.some((e) => e.event.type === 'ticket.moved')).toBe(true);
    const tickets = journal.entries.flatMap((e) => [e.decision?.before, e.decision?.ticket]).filter((t) => t !== undefined && t !== null);
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every((t) => 'pendingFeedback' in t && !('humanInbox' in t))).toBe(true);
    expect(replayJournal(journal)).toMatchObject({ upcast: 1, divergences: [] });
    // Upcast, not ignored: a value that differs is still caught.
    (journal.entries.find((e) => e.decision?.ticket)!.decision!.ticket as unknown as { pendingFeedback: unknown[] }).pendingFeedback = [{ body: 'x' }];
    expect(replayJournal(journal).divergences.map((d) => d.field)).toContain('ticket');
  });

  it('a message of today, classified and acked, replays bit for bit: instruction held at the regrouping, handed over at the end of the step (ORC-180)', () => {
    const journal = readJournal(readFileSync(join(dir, 'human-reply-during-run.json'), 'utf8'));
    const prompted = journal.entries.filter((e) => e.event.type === 'session.prompted');
    expect(prompted.map((e) => e.decision?.effects.map((x) => x.kind))).toEqual([['ack'], ['ack', 'start_run']]);
    expect(journal.entries.find((e) => e.event.type === 'timer.fired')!.decision?.effects).toEqual([]);
    expect(journal.entries.flatMap((e) => e.decision?.effects ?? []).filter((x) => x.kind === 'start_run').map((x) => (x as { job: string }).job)).toEqual(['dev', 'ask', 'dev-feedback']);
    expect(replayJournal(journal)).toMatchObject({ divergences: [], replayed: journal.entries.length });
  });

  it('journals CI run attempts, the merge commit and the default-branch pushes, decided as facts only (ORC-278)', () => {
    const journal = readJournal(readFileSync(join(dir, 'merge-revert-ci.json'), 'utf8'));
    const of = (type: string) => journal.entries.filter((e) => e.event.type === type);
    expect(of('ci.run_completed').map((e) => e.event.id)).toEqual(['ci:REL-1:101:1', 'ci:REL-1:101:2']);
    expect(of('pr.merged')[0]!.event.payload).toMatchObject({ mergeSha: 'a'.repeat(40), headSha: 'head1' });
    expect(of('default_branch.pushed').map((e) => (e.event.payload as { commits: object[] }).commits)).toMatchObject([[{ merges: 3 }], [{ reverts: 3 }]]);
    for (const e of [...of('ci.run_completed'), ...of('default_branch.pushed')]) {
      expect(e.decision).toMatchObject({ effects: [], timers: [], trace: [`${e.event.type}: recorded for the measures`] });
    }
    expect(replayJournal(journal)).toMatchObject({ divergences: [], replayed: journal.entries.length });
  });

  // Nothing else reads most of the frozen copies by name: a deleted one would take its coverage away silently.
  it('keeps the frozen copies of the 13 journals main held before the freshness check (ORC-310)', () => {
    // The journals main held then, not today's SCENARIOS: a scenario added later has no copy to keep.
    const expected = [
      'authz-refused-then-allowed', 'blocked-then-comment-resumes', 'build-loop-blocked', 'check-failed-then-feedback',
      'crash-loop-bound', 'dead-letter-then-repair', 'human-reply-during-run', 'merge-revert-ci',
      'publish-refused-then-published', 'red-ci-then-stop', 'review-merge-done', 'review-merge-done.v1', 'signed-actor-then-untrusted',
    ].map((name) => `${name}.pre-orc-310.json`);
    expect(files.filter((f) => f.endsWith('.pre-orc-310.json')).sort()).toEqual(expected.sort());
  });

  // The oracle replays a journal from its own recorded inputs, so a stale journal stays green there:
  // this compares it with what its scenario records today (ORC-310).
  it.each(Object.keys(SCENARIOS))('%s: the committed journals are what the scenario records today', async (name) => {
    for (const { file, text } of recordedFiles(name, await record(name))) {
      const committed = files.includes(file) ? readFileSync(join(dir, file), 'utf8') : undefined;
      if (committed !== text) {
        expect.fail(
          `test/replay/journals/${file} is not what its scenario records today (${drift(committed, text)}). ` +
            'If the change of the pack, a projection or an event payload is meant, run `npm run replay:record` and commit the journals\' diff.',
        );
      }
    }
  });

  it.each(files)('%s replays identical bit for bit', (file) => {
    const report = replayJournal(readJournal(readFileSync(join(dir, file), 'utf8'), file));
    expect(report.divergences).toEqual([]);
    expect(report.replayed).toBeGreaterThan(0);
  });

  it('a block of a version frozen before ORC-196 replays with its free text, a block of today with the comment', () => {
    const entries = (file: string) => readJournal(readFileSync(join(dir, file), 'utf8'), file).entries;
    const told = (file: string) => entries(file).flatMap((e) => e.decision?.effects ?? []).map((e) => e.kind);
    expect(told('build-loop-blocked.pre-orc-196.json')).toContain('activity');
    expect(told('build-loop-blocked.pre-orc-196.json')).not.toContain('block_comment');
    expect(told('build-loop-blocked.json')).toContain('block_comment');
  });

  // Regression replays each decision on the workflow version it was frozen on, kept in the journal: a
  // change of the pack or of a preset shows only against the workflow of today, hence this what-if pass.
  // Journals kept as an older engine recorded them (before ORC-196, or as main held them before ORC-310): they pin
  // those versions, today's differ by design.
  it.each(files.filter((f) => !/\.pre-orc-(196|310)\./.test(f)))('%s decides the same under the standard pack and its preset as they are today', (file) => {
    const scenario = file.replace(/(\.v\d+)?\.json$/, '');
    expect(Object.keys(SCENARIOS)).toContain(scenario);
    const report = replayJournal(readJournal(readFileSync(join(dir, file), 'utf8'), file), { mode: 'what-if', workflow: scenarioWorkflow(scenario) });
    expect(report.divergences).toEqual([]);
  });
});
