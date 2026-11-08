import type { GoldenTicket } from '../../src/golden/golden-set.js';
import type { GoldenPass, RunGoldenPass } from '../../src/golden/replay.js';
import { hashCanonical } from '../../src/runtime/workflow-version.js';
import { createHarness, trackHarnesses } from '../helpers/harness.js';

/** Each pass's harness is shut down before the next one starts: no pass sees another's runs or timers. */
const shutdown = trackHarnesses();

/**
 * A golden pass on the fake adapters and the fake runner (ORC-236): no model, no network, no external effect.
 * The ticket is delegated on the pack (`packDir`, the standard one by default) and the current preset; the fake
 * agent does its job and commits, and the PR the factory would open stays in the fake publisher, kept as the pass's
 * artifact. Its inputs are what the engine recorded its runs received (ORC-226): prompt, skills, workflow,
 * settings and plugin files, model and effort.
 */
export function fakeGoldenPass({ packDir }: { packDir?: string } = {}): RunGoldenPass {
  return async (ticket: GoldenTicket): Promise<GoldenPass> => {
    const h = createHarness({ packDir });
    try {
      const id = ticket.ticket;
      h.tracker.addIssue({ identifier: id, title: ticket.title, description: `${ticket.title}. Replayed from ${ticket.repo} at ${ticket.startCommit}.` });
      h.workspaces.heads.set(`/tmp/factory-fake/p/${id}`, 'golden-head');
      await h.send('ticket.delegated', { linearSessionId: `ls-${id}` }, id);
      await h.advance(60_000);
      const state = await h.ticket(id);
      const labels = await Promise.all(h.runner.requests.map(async (r) => (await h.store.getRun(r.runId))?.labels));
      const published = h.publisher.published.at(-1);
      return {
        verdict: published ? 'pr' : state.blocked ? 'blocked' : 'no_pr',
        inputs: hashCanonical(labels.map((l) => l && { model: l.model, effort: l.effort, fingerprints: l.fingerprints })),
        ...(published ? { pr: { branch: published.branch, title: published.title } } : {}),
      };
    } finally {
      await shutdown();
    }
  };
}
