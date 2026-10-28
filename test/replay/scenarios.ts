import { runRepair } from '../../src/cli/repair.js';
import type { TicketState } from '../../src/core/types.js';
import { exportJournal, type ExportedJournal } from '../../src/runtime/replay.js';
import type { Workflow } from '../../src/config/workflow-schema.js';
import { createHarness, loadTestWorkflow } from '../helpers/harness.js';
import { testPreset, type TestPreset } from '../helpers/test-preset.js';

type Harness = ReturnType<typeof createHarness>;

async function delegated(h: Harness): Promise<void> {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.runner.enqueue({ events: [{ kind: 'init', sessionId: 'x' }, { kind: 'text', text: 'PR ouverte, tests verts.' }] });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
}

/**
 * Harness scenarios whose journals `record.ts` writes to `journals/` (ORC-174): the recorded
 * journals the CI replays until real ones are exported from an instance (docs/tests.md).
 */
export const SCENARIOS: Record<string, { preset?: TestPreset; run(h: Harness): Promise<void> }> = {
  /** Delegation, a failed check, a resumed run, human review, two replies within the debounce window. */
  'check-failed-then-feedback': {
    preset: testPreset(),
    run: async (h) => {
      h.checks.failNext('1 failed');
      await delegated(h);
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Corrigé.' }] });
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'boutons mal alignés', author: 'Lilian' });
      await h.advance(60_000);
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'bug quand la liste est vide', author: 'Lilian' });
      await h.advance(180_000);
    },
  },
  /** AI review, merge, cleanup and learn. */
  'review-merge-done': {
    run: async (h) => {
      await delegated(h);
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Synthèse : 2 rounds, CI verte.' }] });
      await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
      await h.send('pr.merged', { number: 3, url: 'https://gh/pr/3', branch: 'factory/rel-1-export-csv' });
    },
  },
  /** Red CI past its bound blocks the ticket; a human stop. */
  'red-ci-then-stop': {
    preset: testPreset({ ciFixAttempts: 1 }),
    run: async (h) => {
      await delegated(h);
      const red = { number: 7, url: 'https://forge/pr/7', branch: 'factory/rel-1-export-csv', failures: ['test'] };
      await h.send('pr.checks_failed', red);
      await h.send('pr.checks_failed', red);
      await h.send('label.changed', { label: 'agent:stop', change: 'added' });
    },
  },
  /**
   * A reply whose decision throws (a corrupt projection) is dead-lettered and blocks the ticket; once the
   * projection is fixed, `factory run repair replay` decides it again and unblocks the ticket (ORC-175).
   */
  'dead-letter-then-repair': {
    run: async (h) => {
      await delegated(h);
      const good = await h.ticket();
      await h.store.putTicket({ ...good, pendingFeedback: null as unknown as TicketState['pendingFeedback'] });
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'et le mobile ?', author: 'Lilian' });
      await h.store.putTicket({ ...(await h.ticket()), pendingFeedback: [] });
      await runRepair({ store: h.store, target: 'REL-1', action: 'replay', by: 'ops', now: h.clock.now(), print: () => {} });
      await h.orch.drained();
    },
  },
};

/** The workflow a scenario runs on today: the standard pack under its preset. */
export function scenarioWorkflow(name: string): Workflow {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  return loadTestWorkflow(scenario.preset?.yaml);
}

/** Runs a scenario and exports the journal of its ticket. */
export async function record(name: string): Promise<ExportedJournal> {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  const h = createHarness({ preset: scenario.preset });
  await scenario.run(h);
  h.orch.stopAll();
  await h.orch.drained();
  const journal = await exportJournal(h.store, 'p', 'REL-1');
  await h.store.close();
  return journal;
}

/**
 * The journal as an engine before schema version 2 wrote it: `status.changed` rows as `ticket.moved`,
 * without version nor taint (`src/core/upcast.ts`). The recorded decisions are unchanged: they were
 * taken on the upcast event.
 */
export function asVersion1(journal: ExportedJournal): ExportedJournal {
  return {
    ...journal,
    entries: journal.entries.map((entry) => {
      if (entry.event.type !== 'status.changed') return entry;
      const { schemaVersion: _v, taint: _t, ...v1 } = entry.event;
      return { ...entry, event: { ...v1, type: 'ticket.moved' } };
    }),
  };
}
