import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factoryDefault } from '../presets/factory-default.js';
import { loadWorkflow, presetBound, WorkflowError } from './load-workflow.js';

const packDir = join(import.meta.dirname, '../../packs/standard');

function projectFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-wf-'));
  const f = join(dir, 'workflow.yml');
  writeFileSync(f, yaml);
  return f;
}

describe('loadWorkflow', () => {
  it('loads the standard pack alone', () => {
    const wf = loadWorkflow({ packDir });
    expect(wf.states.human_review).toBe('Human Review');
    expect(wf.limits.parallelSessions).toBe(3);
    expect(wf.limits.perRun.durationMs).toBe(90 * 60_000);
    expect(wf.limits.ciFixAttempts).toBe(2);
    expect(wf.on['session.prompted']).toHaveLength(2);
    expect(wf.on['session.prompted']![1]!.debounceMs).toBe(180_000);
    expect(wf.commands).toEqual(['retiens', 'fais-le']);
  });

  it('reads the command that starts the application for the visual proof, absent by default (ORC-176)', () => {
    expect(loadWorkflow({ packDir }).workspace).not.toHaveProperty('preview');
    const wf = loadWorkflow({ packDir, projectFile: projectFile('version: 1\nworkspace:\n  preview: npm run preview\n') });
    expect(wf.workspace.preview).toBe('npm run preview');
  });

  it('accepts the former event names of a project file as aliases', () => {
    const wf = loadWorkflow({
      packDir,
      projectFile: projectFile(`
version: 1
on:
  ticket.moved:
    - { to: human_review, comment: "prêt" }
  label.added:
    - { label: "agent:audit", comment: "audit" }
`),
    });
    expect(wf.on['status.changed']).toEqual([expect.objectContaining({ to: 'human_review', comment: 'prêt' })]);
    expect(wf.on['label.changed']).toEqual([expect.objectContaining({ label: 'agent:audit' })]);
    expect(Object.keys(wf.on)).not.toContain('ticket.moved');
  });

  it('refuses a project file that declares an event under both its former and its current name', () => {
    const file = projectFile('version: 1\non:\n  ticket.moved:\n    - { to: ready, comment: "a" }\n  status.changed:\n    - { to: ready, comment: "b" }\n');
    expect(() => loadWorkflow({ packDir, projectFile: file })).toThrow(/on\.ticket\.moved: same event as on\.status\.changed/);
  });

  it('accepts rules on a human push', () => {
    const wf = loadWorkflow({ packDir, projectFile: projectFile(`version: 1\non:\n  push.human:\n    - { comment: "commit humain" }\n`) });
    expect(wf.on['push.human']).toHaveLength(1);
  });

  it('resolves extends field by field', () => {
    const wf = loadWorkflow({ packDir });
    const fb = wf.jobs['dev-feedback']!;
    expect(fb.queue).toBe('dev');
    expect(fb.model).toBe('sonnet');
    expect(fb.session).toBe('resume');
    expect(fb.skill).toBe('factory:feedback');
    expect(fb.onStart).toEqual({});
    expect(wf.jobs['fix-ci']!.input).toBe('ci_failures');
    expect(wf.jobs['fix-ci']!.skill).toBe('factory:fix-ci');
    expect(wf.jobs['fix-ci']!.session).toBe('resume');
    expect(wf.jobs['remember']!.workspace).toBe('knowledge');
    // No dollars (ORC-216): a budget is tokens and turns.
    expect(wf.jobs['ask']!.limits).toEqual({ turns: 30, durationMs: 5 * 60_000 });
    expect(wf.jobs['dev']!.limits.turns).toBe(150);
  });

  it('loads a project file that still caps a run in dollars, without the cap: nothing reads it (ORC-216)', () => {
    const wf = loadWorkflow({ packDir, projectFile: projectFile('version: 1\nlimits:\n  per_run: { usd: 9 }\njobs:\n  dev: { limits: { usd: 2 } }\n') });
    expect(wf.limits.perRun).toEqual({ turns: 150, durationMs: 90 * 60_000 });
    expect(wf.jobs['dev']!.limits).not.toHaveProperty('usd');
  });

  describe('the preset step of a job (ORC-136)', () => {
    it('gives the pack its effort and its turns: build 150, fix 60, review 25', () => {
      const { jobs } = loadWorkflow({ packDir });
      expect(jobs['dev']).toMatchObject({ effort: 'medium', limits: { turns: 150 } });
      expect(jobs['tests']).toMatchObject({ effort: 'medium', limits: { turns: 150 } });
      expect(jobs['dev-feedback']).toMatchObject({ effort: 'medium', limits: { turns: 60 } });
      expect(jobs['fix-ci']).toMatchObject({ effort: 'medium', limits: { turns: 60 } });
      expect(jobs['review']).toMatchObject({ effort: 'high', limits: { turns: 25 } });
    });

    it('leaves the jobs out of the preset alone: their own limits, no effort', () => {
      const { jobs } = loadWorkflow({ packDir });
      expect(jobs['ask']!.limits.turns).toBe(30);
      expect(jobs['ask']).not.toHaveProperty('effort');
    });

    it('asks a submit_result of the build only, until ORC-191 rewrites the other skills', () => {
      const { jobs } = loadWorkflow({ packDir });
      expect(jobs['dev']!.structuredOutput).toBe(true);
      for (const name of ['tests', 'dev-feedback', 'fix-ci', 'ask']) expect(jobs[name]!.structuredOutput).toBeFalsy();
    });

    it('runs the AI review as two read-only lenses on Opus, on a fresh clone of the published commit, at network claude-api (ORC-183)', () => {
      const { jobs } = loadWorkflow({ packDir });
      for (const [name, lens] of [['review', 'correctness'], ['review-security', 'security']] as const) {
        expect(jobs[name], name).toMatchObject({ step: 'review', model: 'opus', effort: 'high', limits: { turns: 25 }, workspace: 'published', session: 'new', skill: 'factory:review', lens, structuredOutput: true, network: 'claude-api' });
        expect(jobs[name]!.repoChecks, name).toBeUndefined();
        expect(jobs[name]!.verify, name).toEqual([]);
      }
      // The first lens hands over to the second; the second publishes both and shows the PR in Human Review.
      expect(jobs['review']!.onSuccess).toEqual({ run: 'review-security' });
      expect(jobs['review-security']!.onSuccess).toEqual({ move: 'human_review', post: 'review' });
    });

    it("gives each job its step's network level, the jobs out of the preset none (ORC-183)", () => {
      const { jobs } = loadWorkflow({ packDir });
      expect(jobs['dev']!.network).toBe('limited');
      expect(jobs['dev-feedback']!.network).toBe('limited');
      expect(jobs['ask']).not.toHaveProperty('network');
    });

    it('starts the AI review once the build is published, in AI Review (ORC-183)', () => {
      const { jobs } = loadWorkflow({ packDir });
      expect(jobs['dev']!.onSuccess).toEqual({ move: 'ai_review', post: 'summary', run: 'review' });
    });

    it('refuses a lens on a job of no review step, and a published workspace out of one', () => {
      expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  dev: { lens: security }\n') })).toThrow(/jobs\.dev\.lens/);
      expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  dev: { workspace: published }\n') })).toThrow(/jobs\.dev\.workspace/);
      // A review job without its lens, or a review posted by another job, would drop the findings in silence.
      const lensless = 'version: 1\njobs:\n  extra: { step: review, queue: dev, model: opus, workspace: published, skill: "factory:review" }\n';
      expect(() => loadWorkflow({ packDir, projectFile: projectFile(lensless) })).toThrow(/jobs\.extra\.lens/);
      expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  dev: { on_success: { post: review } }\n') })).toThrow(/jobs\.dev\.on_success\.post/);
    });

    it('lets a project narrow the turns of a step, never widen them', () => {
      const wf = loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  dev: { limits: { turns: 10 } }\n  dev-feedback: { limits: { turns: 500 } }\n') });
      expect(wf.jobs['dev']!.limits.turns).toBe(10);
      expect(wf.jobs['dev-feedback']!.limits.turns).toBe(60);
    });

    it('refuses a step that is not an agent step of the preset', () => {
      expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  dev: { step: nope }\n') })).toThrow(/jobs\.dev\.step: .*nope/);
      expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  dev: { step: verify }\n') })).toThrow(/jobs\.dev\.step: .*verify/);
    });

    it('takes the effort and the budgets of factory.yml, by step: the turns only narrow', () => {
      const { jobs } = loadWorkflow({
        packDir,
        settings: {
          effort: { default: 'low', perStep: { build: 'high' } },
          budgets: { maxTurns: { build: 40, fix: 500 }, perStepTokens: { build: 1_000_000 } },
        },
      });
      expect(jobs['dev']).toMatchObject({ effort: 'high', limits: { turns: 40, tokens: 1_000_000 } });
      expect(jobs['dev-feedback']).toMatchObject({ effort: 'medium', limits: { turns: 60 } });
      expect(jobs['dev-feedback']!.limits).not.toHaveProperty('tokens');
      // `default` is for what the preset does not set: the jobs out of it.
      expect(jobs['ask']).toMatchObject({ effort: 'low' });
      expect(jobs['review']).toMatchObject({ effort: 'high' });
    });

    it('refuses a step of factory.yml the preset does not have: it would cap nothing', () => {
      expect(() => loadWorkflow({ packDir, settings: { budgets: { perStepTokens: { dev: 1000 } } } })).toThrow(/budgets\.per_step_tokens\.dev/);
      expect(() => loadWorkflow({ packDir, settings: { budgets: { maxTurns: { verify: 1 } } } })).toThrow(/budgets\.max_turns\.verify/);
      expect(() => loadWorkflow({ packDir, settings: { effort: { perStep: { buid: 'low' } } } })).toThrow(/claude\.effort\.per_step\.buid/);
      expect(() => loadWorkflow({ packDir, settings: { effort: { perStep: { spec_draft: 'high' } } } })).not.toThrow();
    });

    it('sets no token cap by default: the values are to calibrate (ORC-216)', () => {
      expect(loadWorkflow({ packDir }).jobs['dev']!.limits).not.toHaveProperty('tokens');
    });

    it('reports the bounds of the stagnation detector', () => {
      expect(loadWorkflow({ packDir }).limits).toMatchObject({ repeatedFailures: 3, silentAfterMs: 30 * 60_000 });
    });
  });

  it('merges a project file over the pack', () => {
    const wf = loadWorkflow({
      packDir,
      projectFile: projectFile(`
version: 1
tracker: { kind: linear, team: REL }
states: { dev: "En cours" }
limits: { parallel_sessions: 1 }
jobs:
  dev: { verify: ["npm test"] }
on:
  session.mentioned: []
`),
    });
    expect(wf.tracker.team).toBe('REL');
    expect(wf.states.dev).toBe('En cours');
    expect(wf.states.todo).toBe('Todo');
    expect(wf.limits.parallelSessions).toBe(1);
    expect(wf.jobs['dev']!.verify).toEqual(['npm test']);
    expect(wf.jobs['dev-feedback']!.verify).toEqual(['npm test']);
    expect(wf.on['session.mentioned']).toEqual([]);
  });

  it('reports the YAML path of an invalid condition', () => {
    expect(() =>
      loadWorkflow({
        packDir,
        projectFile: projectFile(`
version: 1
on:
  session.prompted:
    - { when: "state == nowhere", run: dev }
`),
      }),
    ).toThrow(/on\.session\.prompted\[0\]\.when/);
  });

  it('has no Ready to Merge status: the AI review hands the PR to the human review (ORC-170)', () => {
    const wf = loadWorkflow({ packDir });
    expect(Object.values(wf.states)).not.toContain('Ready to Merge');
    expect(wf.states.ready).toBeUndefined();
    expect(wf.jobs['review-security']!.onSuccess.move).toBe('human_review');
  });

  it('refuses a move to a status the workflow does not declare', () => {
    const file = projectFile('version: 1\njobs:\n  review: { on_success: { move: ready } }\n');
    expect(() => loadWorkflow({ packDir, projectFile: file })).toThrow(/jobs\.review\.on_success\.move: no status for "ready"/);
  });

  it('refuses a status rule on a status the workflow does not declare', () => {
    const file = projectFile('version: 1\non:\n  status.changed:\n    - { to: ready, run: review }\n');
    expect(() => loadWorkflow({ packDir, projectFile: file })).toThrow(/on\.status\.changed\[\d+\]\.to: no status for "ready"/);
  });

  it('takes its loop bounds from the factory/default preset (ORC-187)', () => {
    const wf = loadWorkflow({ packDir });
    // 3 returns to the run after a failed check: the 4th failure blocks, so 4 attempts in all.
    expect(wf.limits.verifyAttempts).toBe(4);
    expect(wf.limits.ciFixAttempts).toBe(2);
    expect(wf.limits.repeatedFailures).toBe(3);
  });

  it('reads the tests job: the red check in measure mode, 3 checks (the preset counter red: 2 returns), then dev (ORC-123)', () => {
    const tests = loadWorkflow({ packDir }).jobs['tests']!;
    expect(tests).toMatchObject({ skill: 'factory:tests', red: { command: 'npm test --', mode: 'measure', attempts: 3 }, onSuccess: { run: 'dev' } });
    const blocking = loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  tests:\n    red: { mode: blocking }\n') });
    expect(blocking.jobs['tests']!.red).toMatchObject({ command: 'npm test --', mode: 'blocking' });
    expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  tests:\n    on_success: { run: nope }\n') })).toThrow(/on_success.run/);
  });

  it('names the preset counter it cannot find', () => {
    expect(() => presetBound({ ...factoryDefault, counters: {} }, 'verify')).toThrow(/counter verify/);
  });

  it('reads limits.ci_fix_attempts, 0 included, and refuses a negative bound (ORC-270)', () => {
    const bound = (n: number) => loadWorkflow({ packDir, projectFile: projectFile(`version: 1\nlimits: { ci_fix_attempts: ${n} }\n`) }).limits.ciFixAttempts;
    expect(bound(0)).toBe(0);
    expect(bound(5)).toBe(5);
    expect(() => bound(-1)).toThrow(WorkflowError);
  });

  it('rejects a rule that runs an unknown job', () => {
    expect(() =>
      loadWorkflow({ packDir, projectFile: projectFile('version: 1\non:\n  ticket.delegated:\n    - { run: nope }\n') }),
    ).toThrow(WorkflowError);
  });

  it('rejects a questions job that resumes the session: only the implementer resumes the ticket session (ORC-217)', () => {
    expect(() =>
      loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  ask:\n    session: resume\n') }),
    ).toThrow(/jobs\.ask\.session: a questions job cannot resume/);
  });
});
