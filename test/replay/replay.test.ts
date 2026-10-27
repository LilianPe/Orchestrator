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

  it.each(files)('%s replays identical bit for bit', (file) => {
    const report = replayJournal(readJournal(readFileSync(join(dir, file), 'utf8'), file));
    expect(report.divergences).toEqual([]);
    expect(report.replayed).toBeGreaterThan(0);
  });

  // Regression replays each decision on the workflow version it was frozen on, kept in the journal: a
  // change of the pack or of a preset shows only against the workflow of today, hence this what-if pass.
  it.each(files)('%s decides the same under the standard pack and its preset as they are today', (file) => {
    const scenario = file.replace(/(\.v1)?\.json$/, '');
    expect(Object.keys(SCENARIOS)).toContain(scenario);
    const report = replayJournal(readJournal(readFileSync(join(dir, file), 'utf8'), file), { mode: 'what-if', workflow: scenarioWorkflow(scenario) });
    expect(report.divergences).toEqual([]);
  });
});
