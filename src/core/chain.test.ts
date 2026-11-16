import { describe, expect, it } from 'vitest';
import { fantome } from '../presets/fantome.js';
import { compilePreset, isAgentStep, type Preset } from '../presets/preset.js';
import { BINDINGS } from '../presets/runtime-bindings.js';
import { defaultWorkflow, preset, presetWorkflow } from '../presets/workflow.js';
import type { AgentOutput } from './agent-output.js';
import { blockingFix, humanRoundJob, nextOf, startMove } from './chain.js';
import { decide } from './engine.js';
import { newTicketState, type FactoryEvent, type TicketState } from './types.js';
import type { Workflow } from './workflow.js';

/** What the end of each job of `wf` starts, moves and posts, the step it stops at by its id. */
function ends(wf: Workflow) {
  return Object.fromEntries(
    Object.values(wf.jobs).map((j) => {
      const { run, move, post, step } = nextOf(wf, j);
      return [j.name, { ...(run ? { run: run.name } : {}), ...(move ? { move } : {}), ...(post ? { post } : {}), ...(step !== undefined ? { at: step?.id ?? null } : {}) }];
    }),
  );
}

describe('the chain walks the preset (ORC-391)', () => {
  it("factory/default: each job's end, as the jobs' `on_success` of the former pack said it", () => {
    expect(ends(defaultWorkflow())).toEqual({
      // The chain's entry (ORC-395): past clarify, which has no job, to the spec.
      intake: { run: 'spec', at: 'spec_draft' },
      dev: { run: 'review', move: 'ai_review', post: 'summary', at: 'review' },
      // Its end waits at the spec gate; `/approve` passes it.
      spec: { at: 'spec_review' },
      // Past the red check and the freeze, to the build, whose status the ticket takes.
      tests: { run: 'dev', move: 'dev', at: 'build' },
      'dev-feedback': { run: 'review', move: 'ai_review', post: 'reply', at: 'review' },
      'fix-ci': { run: 'review', move: 'ai_review', post: 'reply', at: 'review' },
      'fix-review': { run: 'review', move: 'ai_review', post: 'reply', at: 'review' },
      'fix-human': { run: 'review', move: 'ai_review', post: 'reply', at: 'review' },
      // A relayed answer ends where it is (ORC-375).
      'answer-relayed': { at: null },
      // No AI review after a rebase (decided 14/11): its publication ends the run.
      rebase: { at: null },
      review: { run: 'review-security', at: 'review' },
      'review-security': { move: 'human_review', post: 'review', at: 'human_review' },
      ask: { post: 'reply' },
    });
    const wf = defaultWorkflow();
    expect(nextOf(wf, wf.jobs['spec']!, true).run?.name).toBe('tests');
  });

  it('factory/default: only the entry moves at its launch, the review fix and the human round come from the edges', () => {
    const wf = defaultWorkflow();
    const jobs = Object.values(wf.jobs);
    // Its entry, intake, has no status: the ticket stays in Todo until the end that reaches the build (ORC-395).
    expect(jobs.flatMap((j) => (startMove(wf, j) ? [[j.name, startMove(wf, j)]] : []))).toEqual([]);
    const atBuild = presetWorkflow(preset, {}, 'build');
    expect(Object.values(atBuild.jobs).flatMap((j) => (startMove(atBuild, j) ? [[j.name, startMove(atBuild, j)]] : []))).toEqual([['dev', 'dev']]);
    expect(jobs.flatMap((j) => (blockingFix(wf, j) ? [[j.name, blockingFix(wf, j)!.name]] : []))).toEqual([['review-security', 'fix-review']]);
    expect(jobs.filter((j) => humanRoundJob(wf, j)).map((j) => j.name)).toEqual(['fix-human']);
  });

  it("factory/fantome: driven by its own steps, nothing moved nor posted at the Rapide level", () => {
    expect(ends(presetWorkflow(fantome))).toEqual({
      intake: { run: 'spec', at: 'spec_draft' },
      spec: { run: 'tests', at: 'tests' },
      tests: { run: 'dev', at: 'build' },
      dev: { at: null },
      ask: { post: 'reply' },
    });
  });
});

describe('the runtime bindings (ORC-391)', () => {
  it("name only agent steps of factory/default, and lenses its review has: a typo would drop a job silently", () => {
    for (const [name, b] of Object.entries(BINDINGS)) {
      const step = preset.steps.find((s) => s.id === b.step);
      expect(step && isAgentStep(step), name).toBe(true);
      if (b.lens) expect(step?.type === 'review' && step.lenses.includes(b.lens), name).toBe(true);
      expect(defaultWorkflow().jobs[name], name).toBeDefined();
    }
  });
});

describe('the preset drives where the review ends (ORC-391, criterion 2)', () => {
  /** factory/default whose review leads elsewhere: to the end of the run, with no merge gate on the way. */
  const elsewhere: Preset = compilePreset({
    ...preset,
    name: 'test/review-ends-the-run',
    steps: preset.steps.map((s) => (s.id === 'review' ? { ...s, next: null } : s)),
  }).preset;
  const output: AgentOutput = { status: 'done', summary: 'Security lens.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], findings: [] };
  const finished = { id: 'e-r2', type: 'run.finished', at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload: { runId: 'r2', job: 'review-security', outcome: 'success', costUsd: 0.4, turns: 9, lastText: '', attempt: 'succeeded', output } } as FactoryEvent;
  const reviewing: TicketState = { ...newTicketState('p', 'REL-1', 'Export CSV', 'ai_review', 0), delegated: true, activeRunId: 'r2', activeJob: 'review-security', linearSessionId: 's1', prNumber: 3, verifiedSha: 'abc123' };

  it('the review that factory/default ends in Human Review ends where the preset says: here nowhere, the ticket stays in AI Review', () => {
    const published = { kind: 'review', runId: 'r2', lens: 'security', sha: 'abc123', findings: [], publish: true };
    expect(decide(reviewing, finished, defaultWorkflow()).effects).toEqual([published, { kind: 'move', to: 'human_review' }]);
    expect(decide(reviewing, finished, presetWorkflow(elsewhere, {}, 'build')).effects).toEqual([published]);
  });
});
