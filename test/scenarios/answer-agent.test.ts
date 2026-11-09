import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { allowConnect, agentPolicy } from '../../src/network/levels.js';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-182: the `ask` job as the answer agent. A question classified as such starts it at once in the questions queue,
 * read-only, at network claude-api; it reads the run's state, its last diff, the transcript of the session at work and the
 * linked tickets; what it cannot answer goes to the agent that implements through the run inbox, at its next step boundary.
 */
type Harness = ReturnType<typeof createHarness>;

const question = (body: string, patch: Record<string, unknown> = {}) => ({ linearSessionId: 'ls-1', body, author: 'Lilian', ack: true as const, kind: 'question' as const, ...patch });
const output = (patch: Partial<AgentOutput> = {}): AgentOutput => ({ status: 'done', summary: 'Rien dans le code ni la transcription.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...patch });

/** A delegated ticket whose `dev` run is still at work. */
async function atWork(h: Harness): Promise<string> {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.runner.enqueue({ hold: true, events: [{ kind: 'text', text: 'PR ouverte.' }] });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
  return (await h.ticket()).activeRunId!;
}

describe('the answer agent (ORC-182)', () => {
  it('criterion 1: with the dev slot busy (concurrency 1), a question starts the answer at once in its own slot, the run goes on', async () => {
    const h = createHarness({ concurrency: 1 });
    const running = await atWork(h);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Le séparateur est la virgule.' }] });
    await h.send('session.prompted', question('quel séparateur ?'));
    expect(h.runner.requests).toHaveLength(2);
    expect(await h.store.getRun(h.runner.requests[1]!.runId)).toMatchObject({ job: 'ask', queue: 'questions' });
    expect(h.tracker.activities('ls-1').at(-1)).toEqual({ type: 'response', body: 'Le séparateur est la virgule.' });
    expect((await h.store.getRun(running))!.status).toBe('running');
    expect((await h.ticket()).activeRunId).toBe(running);
  });

  it('criteria 2 and 3: read and search tools only, low effort, its caps, in a sandbox the proxy holds to the Claude API', async () => {
    const h = createHarness({ sandboxed: true });
    await atWork(h);
    await h.send('session.prompted', question('quel séparateur ?'));
    const ask = h.runner.requests[1]!;
    // No write tool and no shell: nothing it can run modifies the run or the code; plan mode is not the boundary.
    expect(ask).toMatchObject({ tools: ['Read', 'Grep', 'Glob'], effort: 'low', limits: { turns: 30, tokens: 200_000 } });
    const box = h.sandboxes.created.find((c) => c.runId === ask.runId)!;
    expect(box.network).toBe('claude-api');
    // Whatever the repository allows, the proxy refuses any host but the Claude API.
    const proxy = agentPolicy({ network: { level: 'limited', allow: ['example.com'] } } as never, 'claude-api');
    expect(proxy.level).toBe('claude-api');
    expect(allowConnect(proxy, 'api.anthropic.com').ok).toBe(true);
    for (const host of ['github.com', 'registry.npmjs.org', 'example.com']) expect(allowConnect(proxy, host).ok, host).toBe(false);
  });

  it("reads the run's state, its last diff, the transcript of the session at work and the linked tickets", async () => {
    const transcriptsDir = mkdtempSync(join(tmpdir(), 'factory-transcripts-'));
    const h = createHarness({ transcriptsDir });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Schéma des audits', stateName: 'Done', stateType: 'completed' });
    h.tracker.blocks('REL-2', 'REL-1');
    const running = await atWork(h);
    h.workspaces.ticketDiffs.set('/tmp/factory-fake/p/REL-1', 'diff --git a/src/export.ts b/src/export.ts\n+export const SEPARATOR = ";";');
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Je choisis le point-virgule pour Excel en français.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/export.ts' } }] } },
    ];
    writeFileSync(join(transcriptsDir, `${running}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await h.send('session.prompted', question('pourquoi le point-virgule ?'));
    const prompt = h.runner.requests[1]!.prompt;
    expect(prompt).toContain('## Run state');
    expect(prompt).toContain('Running: dev');
    expect(prompt).toContain('## Last diff');
    expect(prompt).toContain('+export const SEPARATOR = ";";');
    expect(prompt).toContain('## Transcript of the session at work (data)');
    expect(prompt).toContain('Je choisis le point-virgule pour Excel en français.');
    expect(prompt).toContain('Edit');
    expect(prompt).toContain('## Linked tickets (data)');
    expect(prompt).toContain('REL-2');
    expect(prompt).toContain('## Message\npourquoi le point-virgule ?');
  });

  it('criterion 4: a question it cannot answer is relayed through the run inbox at the next step boundary, then its answer relayed back', async () => {
    const h = createHarness();
    const running = await atWork(h);
    h.runner.enqueue({ output: output({ relay: true }) });
    await h.send('session.prompted', question('pourquoi pas du XLSX ?'));
    const asked = h.runner.requests[1]!.runId;
    const said = h.tracker.activities('ls-1').map((a) => (a as { body: string }).body);
    expect(said).toContain('Rien dans le code ni la transcription.');
    expect(said.at(-1)).toMatch(/at the end of its current step/);
    expect((await h.ticket()).relayed).toEqual([expect.objectContaining({ runId: asked })]);
    // The run at work is not interrupted: the agents never speak to each other, the engine routes.
    expect((await h.store.getRun(running))!.status).toBe('running');

    h.runner.enqueue({ output: output({ summary: 'Répondu.', answers: [{ question: asked, answer: 'Le ticket demande du CSV.' }] }) });
    h.runner.release(running);
    await h.orch.drained();
    const next = h.runner.requests[2]!;
    expect(next.claudeSessionId).toBe(h.runner.requests[0]!.claudeSessionId);
    expect(next.prompt).toContain('## Questions relayed from humans');
    expect(next.prompt).toContain(`[${asked}] pourquoi pas du XLSX ?`);
    expect(h.tracker.activities('ls-1')).toContainEqual({ type: 'response', body: 'The agent that implements answers: Le ticket demande du CSV.' });
    expect((await h.ticket()).relayed).toBeUndefined();
  });

  it('criterion 5: someone without a role that may answer clarify gets no answer agent', async () => {
    const h = createHarness({ authz: { githubLogins: { 'user-lilian': 'lilian-gh' } } });
    h.tracker.setTeamMembers('REL', ['user-lilian']);
    h.forge.setRepoPermission('lilian-gh', 'write');
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
    await h.send('session.prompted', question('quel séparateur ?', { author: 'Invité' }), 'REL-1', { actor: 'user-stranger' });
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.activities('ls-1').at(-1)).toEqual({ type: 'response', body: expect.stringMatching(/^Refused/) });
    // A member of the team gets one.
    await h.send('session.prompted', question('quel séparateur ?'), 'REL-1', { actor: 'user-lilian' });
    expect(h.runner.requests).toHaveLength(2);
  });
});
