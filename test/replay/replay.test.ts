import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatReplay, readJournal, replayJournal, type ExportedJournal } from '../../src/runtime/replay.js';
import { loadTestWorkflow } from '../helpers/harness.js';
import { testPreset } from '../helpers/test-preset.js';
import { asVersion1, record as recordScenario, scenarioWorkflow, SCENARIOS } from './scenarios.js';

const dir = join(import.meta.dirname, 'journals');

/** A deep copy, to change a journal without touching the recorded one. */
const copy = (j: ExportedJournal): ExportedJournal => JSON.parse(JSON.stringify(j)) as ExportedJournal;

/** Each scenario runs once; every test gets its own copy of the journal. */
const recorded = new Map<string, Promise<ExportedJournal>>();
async function record(name: string): Promise<ExportedJournal> {
  if (!recorded.has(name)) recorded.set(name, recordScenario(name));
  return copy(await recorded.get(name)!);
}

describe('replay oracle (ORC-174)', () => {
  it('replays a journal recorded by the unchanged engine: projection and effects identical bit for bit', async () => {
    const journal = await record('check-failed-then-feedback');
    const report = replayJournal(journal);
    expect(report.replayed).toBe(journal.entries.length);
    expect(report).toMatchObject({ mode: 'regression', unrecorded: 0, upcast: 0, divergences: [] });
    expect(formatReplay(report)).toMatch(/identiques bit à bit$/);
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
    expect(formatReplay(report)).toContain(`événement ${failed.event.id} (verify.failed`);
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
    expect(repaired.decision!.ticket).toMatchObject({ blocked: false, pendingFeedback: [expect.objectContaining({ body: 'et le mobile ?' })] });
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
    expect(files.some((f) => f.includes('.v1.'))).toBe(true);
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

  it.each(files)('%s replays identical bit for bit', (file) => {
    const report = replayJournal(readJournal(readFileSync(join(dir, file), 'utf8'), file));
    expect(report.divergences).toEqual([]);
    expect(report.replayed).toBeGreaterThan(0);
  });

  // Regression replays each decision on the workflow version it was frozen on, kept in the journal: a
  // change of the pack or of a preset shows only against the workflow of today, hence this what-if pass.
  it.each(files)('%s decides the same under the standard pack and its preset as they are today', (file) => {
    const scenario = file.replace(/(\.v\d+)?\.json$/, '');
    expect(Object.keys(SCENARIOS)).toContain(scenario);
    const report = replayJournal(readJournal(readFileSync(join(dir, file), 'utf8'), file), { mode: 'what-if', workflow: scenarioWorkflow(scenario) });
    expect(report.divergences).toEqual([]);
  });
});
