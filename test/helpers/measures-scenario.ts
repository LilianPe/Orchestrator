import { expect } from 'vitest';
import { measureTicket, type TicketMeasures } from '../../src/core/measures.js';
import { addTokens, NO_TOKENS } from '../../src/core/types.js';
import type { createHarness } from './harness.js';
import { linearIngest, signedDelegation, signedMention } from './linear-webhook.js';

type Harness = ReturnType<typeof createHarness>;

/** The ack of a webhook reaches Linear this long after its event is in the inbox (simulated clock). */
export const ACK_MS = 250;
/** How long the ask run of the question takes before it answers (simulated clock). */
export const ANSWER_MS = 5_000;

export const DEV_TOKENS = { input: 1_000, output: 2_000, cacheRead: 30_000, cacheCreation: 4_000 };
export const REVIEW_TOKENS = { input: 500, output: 700, cacheRead: 10_000, cacheCreation: 0 };
export const ASK_TOKENS = { input: 100, output: 50, cacheRead: 2_000, cacheCreation: 0 };

/**
 * The first run of the factory on fake adapters (ORC-235): a delegation and a question come in
 * through the Linear webhook (acked as the daemon acks them), the dev run, the question's ask run,
 * the AI review (its two lenses), the merge and the learn run. Every agent announces a result in its text that the
 * measures must never read.
 */
export async function firstRun(h: Harness): Promise<TicketMeasures> {
  const ingest = linearIngest(
    // The worker takes the event, and posts its ack, this long after the webhook.
    async (e) => {
      h.clock.advance(ACK_MS);
      return h.orch.accept(e);
    },
    { now: () => h.clock.now() },
  );
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.runner.enqueue(
    { events: [{ kind: 'text', text: 'PR prête et mergeable du premier coup, 0 token utilisé.' }], tokens: DEV_TOKENS },
    { events: [{ kind: 'text', text: "C'est pour garder l'ordre des audits." }], tokens: ASK_TOKENS, hold: true },
    { events: [{ kind: 'text', text: 'Synthèse : aucune retouche, relu en 0 minute.' }], tokens: REVIEW_TOKENS },
  );
  const delegation = signedDelegation(h.clock.now());
  expect(await ingest(delegation.raw, delegation.headers)).toEqual({ status: 200 });
  await h.orch.drained();
  expect(await h.ticket()).toMatchObject({ logical: 'human_review' });

  const question = signedMention('as-q', '@factory pourquoi trier par date ?', h.clock.now());
  expect(await ingest(question.raw, question.headers)).toEqual({ status: 200 });
  await h.orch.drained();
  const [ask] = await h.store.runsByStatus('running');
  await h.advance(ANSWER_MS);
  h.runner.release(ask!.id);
  await h.orch.drained();

  await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
  await h.send('pr.merged', { number: 3, url: 'https://gh/pr/3', branch: 'factory/rel-1-export-csv' });
  expect(await h.ticket()).toMatchObject({ logical: 'done' });
  return measureTicket(h.store, 'p', 'REL-1');
}

/** What the first run writes, measure by measure: those with a source are filled, the others empty. */
export function expectFirstRunMeasures(m: TicketMeasures): void {
  expect(m.mergedAt).toEqual(expect.any(Number));
  // Dev, ask, the review's two lenses (ORC-183) and learn: the second lens and the learn run report no usage, and are counted apart.
  expect(m.attempts).toBe(5);
  expect(m.attemptsWithoutTokens).toBe(2);
  expect(m.tokens).toEqual([DEV_TOKENS, ASK_TOKENS, REVIEW_TOKENS].reduce(addTokens, NO_TOKENS));
  expect(m.firstTry).toBe(true);
  expect(m.reworks).toEqual([]);
  expect(m.messages).toEqual([
    expect.objectContaining({ type: 'ticket.delegated', kind: 'delegation', linearSessionId: 'as-1', signOfLifeMs: ACK_MS, answerMs: null }),
    expect.objectContaining({ type: 'session.mentioned', kind: 'question', linearSessionId: 'as-q', signOfLifeMs: ACK_MS }),
  ]);
  expect(m.messages[1]!.answerMs).toBeGreaterThanOrEqual(ANSWER_MS);
  // No source in the store yet: empty, not guessed.
  expect(m).toMatchObject({ usageLimitShare: null, humanReviewMinutes: null, revertedWithin14Days: null, ciCost: null });
  expect(m.revertWindowEndsAt).toBe(m.mergedAt! + 14 * 24 * 60 * 60 * 1000);
}
