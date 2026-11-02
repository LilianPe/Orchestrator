import { describe, expect, it } from 'vitest';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { createHarness } from '../helpers/harness.js';

const done: AgentOutput = {
  status: 'done',
  summary: 'Export CSV ajouté à la liste des audits.',
  tests_added: ['export.test.ts'],
  why: 'Le bouton réutilise le service existant.',
  assumptions: [],
  risks: ['Gros volumes non mesurés.'],
  untested: ['Excel sous Windows.'],
  review_hints: [{ file: 'src/export.ts', reason: "l'échappement des virgules" }],
};

function delegated() {
  const h = createHarness();
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  return h;
}

/** Delegates REL-1 with a held dev run, records what its `submit_result` would (ORC-288), then ends it. */
async function devRun(output: unknown) {
  const h = delegated();
  h.runner.enqueue({ hold: true, events: [{ kind: 'text', text: 'Texte libre de fin.' }] });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
  const runId = (await h.ticket()).activeRunId!;
  await h.store.setMeta(`agent-output:${runId}`, JSON.stringify(output));
  h.runner.release(runId);
  await h.advance(0);
  return h;
}

const lastBody = (h: ReturnType<typeof createHarness>) => (h.tracker.activities('ls-1').at(-1) as { body: string }).body;

describe('the closed outcome of an attempt decides its end (ORC-289)', () => {
  it('needs_input: Bloqué, the question posted', async () => {
    const h = await devRun({ ...done, status: 'blocked', question: 'Quel séparateur : virgule ou point-virgule ?' });
    expect(await h.ticket()).toMatchObject({ logical: 'dev', blocked: true });
    expect((await h.tracker.getIssue('REL-1')).labels).toContain('Bloqué');
    expect(h.tracker.activities('ls-1').at(-1)).toMatchObject({ type: 'elicitation', body: expect.stringContaining('Quel séparateur') });
  });

  it('spec_impossible: Bloqué, the justification posted', async () => {
    const h = await devRun({ ...done, status: 'blocked', reason: 'spec_impossible', question: 'Les critères 2 et 3 se contredisent.' });
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: expect.stringContaining('conteste') });
    expect(lastBody(h)).toContain('Les critères 2 et 3 se contredisent.');
  });

  it('errored: Bloqué on the infrastructure, no correction run', async () => {
    const h = delegated();
    h.runner.enqueue({ fail: 'stream closed' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(600_000);
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: expect.stringContaining("panne d'infrastructure, l'agent n'est pas en cause") });
  });

  it('succeeded: the posted message is composed from the output, not the last text', async () => {
    const h = await devRun(done);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect(lastBody(h)).not.toContain('Texte libre');
    for (const part of [done.summary, done.why, ...done.risks, ...done.untested, 'src/export.ts', "l'échappement des virgules"]) expect(lastBody(h)).toContain(part);
  });

  it('an invalid stored output is no output: a success stays one, posted from the last text', async () => {
    const h = await devRun({ status: 'done' });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect(h.tracker.activities('ls-1').at(-1)).toEqual({ type: 'response', body: 'Texte libre de fin.' });
  });
});
