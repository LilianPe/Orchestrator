import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { purgeTranscripts } from '../../src/adapters/runner/transcript.js';
import { EventBus } from '../../src/core/bus.js';
import { createApp } from '../../src/server/app.js';
import { createHarness } from '../helpers/harness.js';
import { DEV_TOKENS, firstRun, REVIEW_TOKENS } from '../helpers/measures-scenario.js';

type Harness = ReturnType<typeof createHarness>;

const DAY = 24 * 60 * 60 * 1000;

function detailOf(h: Harness, transcriptsDir: string) {
  const app = createApp({
    store: h.store, bus: new EventBus(), clock: h.clock, submit: () => undefined, isPaused: () => false,
    linearWebhook: () => ({ status: 200 }), githubWebhook: async () => ({ status: 200 }), linearConnected: () => true, tracker: h.tracker,
    capacity: () => ({ dev: { used: 0, total: 1 }, questions: { used: 0, total: 1 } }), transcriptsDir,
  });
  return async (runId: string) => {
    const res = await app.request(`/api/runs/${runId}`);
    expect(res.status).toBe(200);
    return res.json();
  };
}

describe('the run detail on the engine (ORC-298)', () => {
  it('a finished run: its timeline, gates and decisions, findings, checks, cost per step and transcript, then the transcript purged at 30 days', async () => {
    const h = createHarness();
    const transcriptsDir = mkdtempSync(join(tmpdir(), 'factory-tr-'));
    const detail = detailOf(h, transcriptsDir);
    await firstRun(h);
    const runs = await h.store.ticketRuns('p', 'REL-1');
    const dev = runs.find((r) => r.job === 'dev')!;
    writeFileSync(join(transcriptsDir, `${dev.id}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Adding the export.' }] } })}\n`);

    const d = await detail(dev.id);
    expect(d.run).toMatchObject({ id: dev.id, job: 'dev', status: 'success', outcome: 'succeeded', tokens: DEV_TOKENS });
    // The ticket's whole journal, the events of this run marked.
    expect(d.timeline.length).toBeGreaterThan(5);
    expect(d.timeline.filter((e: { ofRun: boolean }) => e.ofRun)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run.finished', what: expect.stringContaining('dev ended: succeeded') })]));
    // The delegation came signed through the webhook; the move to AI review and the merge are the humans'.
    expect(d.decisions.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(['ticket.delegated', 'session.mentioned', 'pr.merged']));
    // Handed over, sent back to AI review by a human, handed over again, then moved to done by the factory once merged.
    expect(d.gates).toEqual([
      expect.objectContaining({ gate: 'merge', to: 'ai_review', closedBy: 't-1' }),
      expect.objectContaining({ gate: 'merge', to: 'done', closedAt: expect.any(Number) }),
    ]);
    // The two review lenses (ORC-183), each a round with the findings it handed back: none here.
    expect(d.findings).toEqual([
      expect.objectContaining({ source: 'ai', job: 'review', status: 'success', outcome: 'succeeded', findings: [] }),
      expect.objectContaining({ source: 'ai', job: 'review-security', status: 'success', outcome: 'succeeded', findings: [] }),
    ]);
    // The dev run's verify; the review lenses write nothing, so nothing is verified after them (ORC-183).
    expect(d.checks).toEqual([expect.objectContaining({ check: 'verify', result: 'passed', runId: dev.id, job: 'dev' })]);
    expect(d.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ job: 'dev', attempts: 1, tokens: DEV_TOKENS }),
      expect.objectContaining({ job: 'review', attempts: 1, tokens: REVIEW_TOKENS }),
    ]));
    expect(d.transcript).toEqual({ status: 'kept', lines: [{ kind: 'text', text: 'Adding the export.' }] });
    // What the agent announced is served as its own output, never in what the factory computed.
    expect(d.output).toMatchObject({ status: 'done', summary: expect.stringContaining('premier coup') });
    expect(JSON.stringify({ ...d, transcript: null, output: null })).not.toContain('premier coup');

    // 30 days on, the daemon's purge removes it: the page says so.
    h.clock.advance(30 * DAY);
    // The purge reads the files' own time, on the machine's clock.
    expect(purgeTranscripts(transcriptsDir, Date.now() + 30 * DAY)).toEqual([`${dev.id}.jsonl`]);
    const later = await detail(dev.id);
    expect(later.transcript).toEqual({ status: 'purged' });
    expect(later.timeline).toEqual(d.timeline);
  });
});
