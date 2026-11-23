import { describe, expect, it } from 'vitest';
import { DIFF_QUALITY_CHECK, type DiffQuality } from '../../src/checks/diff-quality.js';
import type { AgentOutput } from '../../src/core/agent-output.js';
import type { CleanVerifyRequest, CleanVerifyResult } from '../../src/core/clean-verify.js';
import { assessment, chainHarness, delegate as delegated, drafted, toBuild, WORKTREE } from '../helpers/chain.js';
import type { createHarness } from '../helpers/harness.js';

/**
 * ORC-280: `factory/qualité-diff`, crapper and dryer on the diff in `verify`. The tools and what is read of them are proved by
 * `clean-verify.test.ts` and `diff-quality.test.ts`; here, what the orchestrator does with the measure: asked for, journaled,
 * published as a check that blocks nothing, and its two worst in the PR's « Where to look first ».
 */
type Harness = ReturnType<typeof createHarness>;
const SHA = 'c0ffee'.padEnd(40, '0');
const dev = { output: { status: 'done', summary: 'Grades computed.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] } satisfies AgentOutput };

function measured(result: Partial<CleanVerifyResult>) {
  const asked: CleanVerifyRequest[] = [];
  const h = chainHarness({
    sandboxed: true,
    cleanVerify: async (req) => {
      asked.push(req);
      return { ok: true, failures: [], sha: SHA, tree: 't', commands: [], ...result };
    },
  });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Compute grades', description: 'Compute the grades.\n\nAcceptance criteria:\n1. A grade per score.' });
  h.workspaces.heads.set(WORKTREE, SHA);
  h.runner.enqueue(assessment({ screen: false }), drafted());
  return { h, asked };
}

async function delegate(h: Harness): Promise<void> {
  await delegated(h);
  await toBuild(h, { build: [dev] });
}
const check = (h: Harness) => h.forge.checkRuns.find((c) => c.name === DIFF_QUALITY_CHECK);
const body = (h: Harness) => h.publisher.published.at(-1)!.body;

describe('factory/qualité-diff in the orchestrator (ORC-280)', () => {
  const quality: DiffQuality = {
    functions: [{ path: 'src/grade.ts', name: 'grade', start: 1, end: 30, cc: 12, coverage: 10, crap: 117.4 }],
    pairs: [{ score: 0.95, left: { path: 'src/grade.ts', start: 40, end: 52 }, right: { path: 'src/old.ts', start: 3, end: 15 } }],
  };

  it('verify is asked for the measure', async () => {
    const { h, asked } = measured({});
    await delegate(h);
    expect(asked[0]!.quality).toBe(true);
  });

  it('criteria 1 and 2: the function past CRAP 10 and the copied pair are listed on a neutral check, and the ticket goes on', async () => {
    const { h } = measured({ quality });
    await delegate(h);
    const [event] = (await h.store.recentEvents(100, 'REL-1')).filter((e) => e.type === 'verify.passed');
    expect((event!.payload as { quality?: DiffQuality }).quality).toEqual(quality);
    expect(check(h)).toMatchObject({ sha: SHA, conclusion: 'neutral', summary: expect.stringContaining('`src/grade.ts:1-30` `grade`: CRAP 117.4 (CC 12, coverage 10 %)') });
    expect(check(h)!.summary).toContain('`src/grade.ts:40-52` and `src/old.ts:3-15`: similarity 0.95');
    expect(await h.ticket()).toMatchObject({ logical: 'human_review' });
  });

  it("the PR's « Where to look first » names the two worst", async () => {
    const { h } = measured({ quality });
    await delegate(h);
    expect(body(h)).toContain('**Measured by the factory** (`factory/qualité-diff`):\n- `src/grade.ts:1-30` `grade`: CRAP 117.4');
    expect(body(h)).toContain('- `src/grade.ts:40-52` and `src/old.ts:3-15`: similarity 0.95');
  });

  it('a measure that could not be taken is said on the check, and nothing is added to the PR', async () => {
    const { h } = measured({ quality: { functions: [], pairs: [], unavailable: 'crapper and dryer could not run (code 127)' } });
    await delegate(h);
    expect(check(h)).toMatchObject({ conclusion: 'neutral', summary: expect.stringContaining('code 127') });
    expect(body(h)).not.toContain('Measured by the factory');
  });

  it('without a measure (a commit found green before), no check', async () => {
    const { h } = measured({});
    await delegate(h);
    expect(check(h)).toBeUndefined();
  });
});
