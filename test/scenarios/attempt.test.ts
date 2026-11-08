import { describe, expect, it } from 'vitest';
import { agentOutputKey, type AgentOutput } from '../../src/core/agent-output.js';
import type { Store } from '../../src/store/types.js';
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

function delegated(wrapStore?: (s: Store) => Store) {
  const h = createHarness(wrapStore ? { wrapStore } : {});
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  return h;
}

/** Delegates REL-1 with a held dev run, records what its `submit_result` would (ORC-288), then ends it. */
async function devRun(output: unknown, wrapStore?: (s: Store) => Store) {
  const h = delegated(wrapStore);
  h.runner.enqueue({ hold: true, events: [{ kind: 'text', text: 'Texte libre de fin.' }] });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
  const runId = (await h.ticket()).activeRunId!;
  await h.store.setMeta(agentOutputKey(runId), JSON.stringify(output));
  h.runner.release(runId);
  await h.advance(0);
  return h;
}

const lastBody = (h: ReturnType<typeof createHarness>) => h.tracker.comments('REL-1').at(-1)!;

describe('the closed outcome of an attempt decides its end (ORC-289)', () => {
  it('needs_input: Bloqué, the question posted', async () => {
    const h = await devRun({ ...done, status: 'blocked', question: 'Quel séparateur : virgule ou point-virgule ?' });
    expect(await h.ticket()).toMatchObject({ logical: 'dev', blocked: true });
    expect((await h.tracker.getIssue('REL-1')).labels).toContain('Bloqué');
    expect(lastBody(h)).toContain('Question: Quel séparateur');
  });

  it('spec_impossible: Bloqué, the justification posted', async () => {
    const h = await devRun({ ...done, status: 'blocked', reason: 'spec_impossible', question: 'Les critères 2 et 3 se contredisent.' });
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: expect.stringContaining('disputes') });
    expect(lastBody(h)).toContain('Les critères 2 et 3 se contredisent.');
  });

  it('errored: Bloqué on the infrastructure, no correction run', async () => {
    const h = delegated();
    h.runner.enqueue({ fail: 'stream closed' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(600_000);
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: expect.stringContaining("infrastructure failure, not the agent's fault") });
  });

  it('succeeded: the posted message is composed from the output, not the last text', async () => {
    const h = await devRun(done);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    const body = (h.tracker.activities('ls-1').at(-1) as { body: string }).body;
    expect(body).not.toContain('Texte libre');
    for (const part of [done.summary, done.why, ...done.risks, ...done.untested, 'src/export.ts', "l'échappement des virgules"]) expect(body).toContain(part);
  });

  it('an invalid stored output is no output: the build asks for one, so it failed (ORC-136)', async () => {
    const h = await devRun({ status: 'done' });
    expect(await h.ticket()).toMatchObject({ logical: 'dev', blocked: true, blockReason: 'The run dev failed.' });
    expect(lastBody(h)).toContain('🔴 Blocked');
  });

  it('a reply (a feedback run) posts the summary it submitted, not the output template, nor its last text (ORC-214)', async () => {
    const h = await devRun(done);
    h.runner.enqueue({ hold: true, submit: false, events: [{ kind: 'text', text: 'Corrigé : les boutons sont alignés.' }] });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'boutons mal alignés', author: 'L' });
    await h.advance(180_000); // the reply's debounce
    const runId = h.runner.requests[1]!.runId;
    await h.store.setMeta(agentOutputKey(runId), JSON.stringify(done));
    h.runner.release(runId);
    await h.advance(0);
    expect(h.tracker.activities('ls-1').at(-1)).toEqual({ type: 'response', body: done.summary });
    expect(JSON.stringify(h.tracker.activities('ls-1'))).not.toContain('Corrigé');
  });

  it('an unreadable output store is the infrastructure: errored, not « no output »', async () => {
    const h = await devRun(done, (inner) =>
      Object.assign(Object.create(inner) as Store, {
        getMeta: (k: string) => (k.startsWith('agent-output:') ? Promise.reject(new Error('database down')) : inner.getMeta(k)),
      }),
    );
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: expect.stringContaining('infrastructure failure') });
  });

  it('a failure after the run ended (recording it) does not turn a finished attempt into errored', async () => {
    const h = await devRun(done, (inner) =>
      Object.assign(Object.create(inner) as Store, {
        putRun: (r: Parameters<Store['putRun']>[0]) => (r.endedAt !== undefined ? Promise.reject(new Error('database down')) : inner.putRun(r)),
      }),
    );
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
  });
});
