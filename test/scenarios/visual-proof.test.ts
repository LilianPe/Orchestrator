import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeShooter, fakePng } from '../../src/adapters/browser/fake.js';
import { VISUAL_PROOF_CHECK, type VisualProof } from '../../src/checks/visual-proof.js';
import type { AgentOutput } from '../../src/core/agent-output.js';
import type { CleanVerifyRequest, CleanVerifyResult } from '../../src/core/clean-verify.js';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-176: the visual proof the factory takes in `verify`. The browser and the check itself are proved by `clean-verify.test.ts`;
 * here, what the orchestrator does with them: the decision's inputs, the journal, the artifacts kept out of the agent's reach, the check.
 */
type Harness = ReturnType<typeof createHarness>;
const INTAKE_FIRST = `version: 1
on:
  ticket.delegated:
    - { when: "state in [todo, dev] && !blocked", run: intake }
`;
const SHA = 'c0ffee'.padEnd(40, '0');
const BASE = 'ba5e'.padEnd(40, '0');
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const intake = (screen: boolean) => ({
  output: { status: 'done', summary: 'Read.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], intake: { size: 's', risk: 'low', complete: true, missing: [], screen } } satisfies AgentOutput,
});
/** The dev run's result, with the page to shoot: `submit_result` has no field that could say `not_applicable` (`visual-proof.test.ts`). */
const dev = {
  output: { status: 'done', summary: 'Button restyled.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], visual_scenario: { url: '/settings', steps: ['open'] } } satisfies AgentOutput,
};

/** Six captures as `runCleanVerify` returns them: before on the base, after on the commit. */
function taken(): NonNullable<CleanVerifyResult['visual']> {
  const files = (['before', 'after'] as const).flatMap((side) =>
    [1280, 768, 375].map((width) => {
      const png = fakePng(`${side}@${width}`);
      return { capture: { side, sha: side === 'before' ? BASE : SHA, width, sha256: sha256(png) }, png };
    }),
  );
  return { proof: { decision: 'required', triggers: ['app/page.tsx'], intake: true, captures: files.map((f) => f.capture) }, files };
}

function visual(result: (req: CleanVerifyRequest) => Partial<CleanVerifyResult> | Promise<Partial<CleanVerifyResult>>, screen = true) {
  const asked: CleanVerifyRequest[] = [];
  const h = createHarness({
    projectYaml: INTAKE_FIRST,
    sandboxed: true,
    visualShooter: new FakeShooter(),
    cleanVerify: async (req) => {
      asked.push(req);
      return { ok: true, failures: [], sha: SHA, tree: 't', commands: [], ...(await result(req)) };
    },
  });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Restyle the button', description: 'Restyle the settings button.\n\nAcceptance criteria:\n1. It is blue.' });
  h.workspaces.heads.set(WORKTREE, SHA);
  h.runner.enqueue(intake(screen), dev);
  return { h, asked };
}

const delegate = (h: Harness) => h.send('ticket.delegated', { linearSessionId: 'ls-1' });
const passed = async (h: Harness) => (await h.store.recentEvents(100, 'REL-1')).filter((e) => e.type === 'verify.passed');
const check = (h: Harness) => h.forge.checkRuns.find((c) => c.name === VISUAL_PROOF_CHECK);

describe('the visual proof in the orchestrator (ORC-176)', () => {
  it("verify gets the intake (ORC-206) and the page the agent named, the only inputs of the decision besides the diff", async () => {
    const { h, asked } = visual(() => ({}));
    await delegate(h);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.visual).toMatchObject({ intake: true, path: '/settings', shooter: expect.any(FakeShooter) });
    expect(h.runner.requests).toHaveLength(2);
  });

  it('criterion 1: the journal carries the decision, its triggers and the six captures by hash; the files are kept as artifacts', async () => {
    const { h } = visual(() => ({ visual: taken() }));
    await delegate(h);
    const [event] = await passed(h);
    const proof = (event!.payload as { visualProof?: VisualProof }).visualProof!;
    expect(proof).toMatchObject({ decision: 'required', triggers: ['app/page.tsx'], intake: true });
    expect(proof.captures!.map((c) => [c.side, c.sha, c.width])).toEqual([
      ['before', BASE, 1280], ['before', BASE, 768], ['before', BASE, 375],
      ['after', SHA, 1280], ['after', SHA, 768], ['after', SHA, 375],
    ]);
    const artifacts = await h.store.artifacts('REL-1');
    expect(artifacts.map((a) => a.sha256)).toEqual(proof.captures!.map((c) => c.sha256));
    for (const a of artifacts) {
      expect(a).toMatchObject({ kind: 'visual-proof', attemptId: expect.any(String) });
      expect(sha256(readFileSync(a.path))).toBe(a.sha256);
    }
    expect(check(h)).toMatchObject({ sha: SHA, conclusion: 'success', summary: expect.stringContaining('app/page.tsx') });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review' });
  });

  it("criterion 2: a diff outside visual_paths: the check says there is no visual proof applicable", async () => {
    const { h } = visual(() => ({ visual: { proof: { decision: 'not_applicable', triggers: [] }, files: [] } }), false);
    await delegate(h);
    expect(check(h)).toMatchObject({ sha: SHA, conclusion: 'neutral', summary: 'No visual proof applicable.' });
    expect(await h.store.artifacts('REL-1')).toEqual([]);
  });

  it('a required proof the instance cannot take is indicative: a neutral check that says why, the ticket goes on', async () => {
    const { h } = visual(() => ({ visual: { proof: { decision: 'required', triggers: ['app/page.tsx'], unavailable: 'this instance has no sandbox with a browser' }, files: [] } }));
    await delegate(h);
    expect(check(h)).toMatchObject({ conclusion: 'neutral', summary: expect.stringContaining('no sandbox with a browser') });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review' });
  });

  it('criterion 3: identical captures, or an application that does not start: back to build, with the verify counter', async () => {
    let first = true;
    const counters: (number | undefined)[] = [];
    const { h } = visual(async () => {
      counters.push((await h.store.getTicket('p', 'REL-1'))?.verifyAttempts);
      if (!first) return {};
      first = false;
      return { ok: false, failures: [{ command: VISUAL_PROOF_CHECK, exitCode: 1, output: 'The captures before and after are identical at every width.' }] };
    });
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Fixed.' }] });
    await delegate(h);
    expect(h.runner.requests).toHaveLength(3);
    expect(h.runner.requests[2]!.prompt).toContain('identical at every width');
    expect(await passed(h)).toHaveLength(1);
    // The second check runs on the relaunch the first one counted.
    expect(counters).toEqual([0, 1]);
    expect(await h.ticket()).toMatchObject({ verifyAttempts: 0, logical: 'human_review' });
  });

  it('criterion 5: no proof file is in what an agent run sees: neither its worktree nor any of its mounts', async () => {
    const { h } = visual(() => ({ visual: taken() }));
    await delegate(h);
    const files = (await h.store.artifacts('REL-1')).map((a) => a.path);
    expect(files).toHaveLength(6);
    expect(files.every((f) => existsSync(f))).toBe(true);
    const runs = new Set(h.runner.requests.map((r) => r.runId));
    const agentBoxes = h.sandboxes.created.filter((c) => runs.has(c.runId));
    expect(agentBoxes.length).toBeGreaterThan(0);
    const inside = (file: string, dir: string) => !relative(dir, file).startsWith('..');
    for (const box of agentBoxes) {
      for (const dir of [box.workspacePath, ...box.mounts.map((m) => m.host)]) expect(files.filter((f) => inside(f, dir))).toEqual([]);
    }
  });
});
