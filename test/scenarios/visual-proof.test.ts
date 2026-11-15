import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeShooter, fakePng } from '../../src/adapters/browser/fake.js';
import { VISUAL_PROOF_CHECK, type VisualProof } from '../../src/checks/visual-proof.js';
import { CAPTURES_KEPT_MS } from '../../src/core/orchestrator.js';
import type { AgentOutput } from '../../src/core/agent-output.js';
import type { CleanVerifyRequest, CleanVerifyResult } from '../../src/core/clean-verify.js';
import { createHarness } from '../helpers/harness.js';
import { delegationStarts } from '../helpers/workflow-with.js';

/**
 * ORC-176: the visual proof the factory takes in `verify`. The browser and the check itself are proved by `clean-verify.test.ts`;
 * here, what the orchestrator does with them: the decision's inputs, the journal, the artifacts kept out of the agent's reach, the check.
 */
type Harness = ReturnType<typeof createHarness>;
const INTAKE_FIRST = delegationStarts('intake');
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
    workflow: INTAKE_FIRST,
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
    // Kept together, at one time: their order among themselves is the store's.
    expect(artifacts.map((a) => a.sha256).sort()).toEqual(proof.captures!.map((c) => c.sha256).sort());
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

describe('the captures in the PR (ORC-407)', () => {
  const body = (h: Harness) => h.publisher.published.at(-1)!.body;

  it("criterion 1: the PR's description shows the six captures, each linked to the commit of factory/artifacts that holds it", async () => {
    const { h } = visual(() => ({ visual: taken() }));
    await delegate(h);
    const files = [...h.forge.artifacts.keys()];
    expect(files).toHaveLength(6);
    expect(files.every((f) => /^REL-1\/(before|after)-(1280|768|375)-[0-9a-f]{16}\.png$/.test(f))).toBe(true);
    // The bytes kept by verify, as they are.
    const kept = new Map((await h.store.artifacts('REL-1')).map((a) => [a.sha256.slice(0, 16), readFileSync(a.path)]));
    for (const [path, content] of h.forge.artifacts) expect(Buffer.from(content)).toEqual(kept.get(path.slice(-20, -4)));
    expect(body(h)).toContain(`![Before, ${BASE.slice(0, 12)} (375 px)](https://github.test/acme/app/blob/c1/REL-1/before-375-`);
    expect(body(h)).toContain(`![After, ${SHA.slice(0, 12)} (1280 px)](https://github.test/acme/app/blob/c1/REL-1/after-1280-`);
    expect(body(h).match(/!\[/g)).toHaveLength(6);
  });

  it('a forge that refuses to host them: the PR opens all the same, and says the captures were taken and why they are not shown', async () => {
    const { h } = visual(() => ({ visual: taken() }));
    h.forge.artifactsRefusal = 'GitHub refuses to write factory/artifacts: 422 Repository rule violations found';
    await delegate(h);
    expect(h.forge.artifacts.size).toBe(0);
    expect(body(h)).toContain('**Screens**: taken by the factory, not shown here: GitHub refuses to write factory/artifacts: 422 Repository rule violations found');
    expect(await h.ticket()).toMatchObject({ logical: 'human_review' });
  });

  it('criterion 3: the captures of a PR merged 30 days ago are removed, those of a PR merged since stay', async () => {
    const { h } = visual(() => ({ visual: taken() }));
    await delegate(h);
    const pr = h.forge.opened.at(-1)!;
    h.forge.artifacts.set('REL-404/after-375-0000000000000000.png', fakePng('unknown'));
    expect(await h.orch.pruneCaptures(h.clock.now() + CAPTURES_KEPT_MS)).toEqual([]);
    const mergedAt = h.clock.now();
    await h.send('pr.merged', { number: pr.number, url: 'https://github.test/pr/1', branch: pr.branch, mergedAt });
    expect(await h.orch.pruneCaptures(mergedAt + CAPTURES_KEPT_MS - 1)).toEqual([]);
    expect(await h.orch.pruneCaptures(mergedAt + CAPTURES_KEPT_MS)).toEqual(['/repo: REL-1']);
    // A ticket the factory does not know keeps its folder.
    expect([...h.forge.artifacts.keys()]).toEqual(['REL-404/after-375-0000000000000000.png']);
    // A repository the forge refuses is logged, never a failure of the whole purge.
    h.forge.artifactsRefusal = 'GitHub refuses to write factory/artifacts: 403';
    expect(await h.orch.pruneCaptures(mergedAt + CAPTURES_KEPT_MS)).toEqual([]);
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('captures of /repo not pruned'))).toBe(true);
  });

  it("a capture gone from the factory's disk: the PR says so, without the server's path", async () => {
    const { h } = visual(() => ({ visual: taken() }));
    const keep = h.store.putArtifact.bind(h.store);
    // Kept, then lost: the row names a file no longer there.
    h.store.putArtifact = async (a) => keep({ ...a, path: `${a.path}.gone` });
    await delegate(h);
    expect(h.forge.artifacts.size).toBe(0);
    expect(body(h)).toContain("**Screens**: taken by the factory, not shown here: a capture is no longer kept on the factory's disk.");
    expect(body(h)).not.toContain('.gone');
  });
});

