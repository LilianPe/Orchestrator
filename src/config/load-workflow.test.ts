import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factoryDefault } from '../presets/factory-default.js';
import { loadWorkflow, presetBound, WorkflowError } from './load-workflow.js';

const packDir = join(import.meta.dirname, '../../packs/standard');
/** A job a project adds out of the preset, with nothing of its own but its limits. */
const OWN_JOB = 'version: 1\njobs:\n  own: { queue: questions, model: haiku, workspace: trunk-readonly, skill: "factory:ask", limits: { turns: 40 } }\n';

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
    expect(wf.limits.humanReviewRounds).toBe(3);
    expect(wf.on['session.prompted']).toHaveLength(3);
    // In Human Review a reply is a round of human feedback (ORC-190), on its counter.
    expect(wf.on['session.prompted']![1]).toMatchObject({ run: 'fix-human', debounceMs: 180_000 });
    expect(wf.jobs['fix-human']).toMatchObject({ counter: 'human_review', input: 'feedback', onSuccess: { move: 'ai_review', post: 'reply', run: 'review' } });
    expect(wf.on['status.changed']!.some((r) => r.from === 'human_review' && r.to === 'dev')).toBe(false);
    // The memory in writing sleeps (ORC-193): no `retiens` nor `fais-le`, no `learn` nor `remember`.
    expect(wf.commands).toEqual([]);
    expect(Object.keys(wf.jobs)).not.toContain('learn');
    expect(Object.keys(wf.jobs)).not.toContain('remember');
  });

  it('refuses a knowledge workspace and the fais-le answer: the memory in writing sleeps (ORC-193)', () => {
    expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  ask: { workspace: knowledge }\n') })).toThrow(/jobs\.ask\.workspace/);
    expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\non:\n  command:\n    - { say: "fais-le", do: propose_delegate }\n') })).toThrow(/do/);
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
    // No dollars (ORC-216): a budget is tokens and turns.
    expect(wf.jobs['ask']!.limits).toEqual({ turns: 30, durationMs: 5 * 60_000, tokens: 200_000 });
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

    it('leaves the jobs out of the preset alone: their own limits, no effort, no network, every tool', () => {
      const { jobs } = loadWorkflow({ packDir, projectFile: projectFile(OWN_JOB) });
      expect(jobs['own']!.limits.turns).toBe(40);
      for (const k of ['effort', 'network', 'tools']) expect(jobs['own'], k).not.toHaveProperty(k);
      // `claude.effort.default` of factory.yml is for them.
      expect(loadWorkflow({ packDir, projectFile: projectFile(OWN_JOB), settings: { effort: { default: 'low' } } }).jobs['own']).toMatchObject({ effort: 'low' });
    });

    it('runs the answer agent read-only, at network claude-api, low effort, 30 turns and 200,000 tokens (ORC-182)', () => {
      const { jobs } = loadWorkflow({ packDir });
      expect(jobs['ask']).toMatchObject({ queue: 'questions', workspace: 'trunk-readonly', effort: 'low', network: 'claude-api', tools: ['Read', 'Grep', 'Glob'], limits: { turns: 30, tokens: 200_000 } });
      // Its own effort, not factory.yml's default, which is for the jobs that set none.
      expect(loadWorkflow({ packDir, settings: { effort: { default: 'high' } } }).jobs['ask']).toMatchObject({ effort: 'low' });
    });

    it("refuses a job's own effort, network, read_only or tokens on a job of a preset step: the step sets them (ORC-182)", () => {
      for (const own of ['effort: low', 'network: none', 'read_only: true', 'limits: { tokens: 10 }']) {
        expect(() => loadWorkflow({ packDir, projectFile: projectFile(`version: 1\njobs:\n  dev: { ${own} }\n`) }), own).toThrow(/jobs\.dev\./);
      }
    });

    it('refuses a job of its own at network full, or read-only anywhere but a clone of its own (ORC-182)', () => {
      expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  ask: { network: full }\n') })).toThrow(/jobs\.ask\.network/);
      const writer = 'version: 1\njobs:\n  own: { queue: questions, model: haiku, workspace: worktree, skill: "factory:ask", read_only: true }\n';
      expect(() => loadWorkflow({ packDir, projectFile: projectFile(writer) })).toThrow(/jobs\.own\.read_only/);
    });

    it('asks a submit_result of the build only, until ORC-191 rewrites the other skills', () => {
      const { jobs } = loadWorkflow({ packDir });
      expect(jobs['dev']!.structuredOutput).toBe(true);
      for (const name of ['tests', 'dev-feedback', 'fix-ci', 'ask']) expect(jobs[name]!.structuredOutput).toBeFalsy();
      // The fix of the review loop hands back what it did with each finding (ORC-184).
      expect(jobs['fix-review']!.structuredOutput).toBe(true);
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

    it('answers a blocking finding with fix-review, which goes back through verify, publish and the review, as fix-ci does (ORC-184)', () => {
      const { jobs } = loadWorkflow({ packDir });
      expect(jobs['review-security']!.onBlocking).toEqual({ run: 'fix-review' });
      expect(jobs['review']!.onBlocking).toBeUndefined();
      expect(jobs['fix-review']).toMatchObject({ step: 'fix', session: 'resume', skill: 'factory:feedback', input: 'findings', structuredOutput: true, repoChecks: true, effort: 'medium', limits: { turns: 60 }, network: 'limited', onStart: {} });
      for (const name of ['fix-review', 'fix-ci']) expect(jobs[name]!.onSuccess, name).toEqual({ move: 'ai_review', post: 'reply', run: 'review' });
    });

    it('refuses on_blocking on a job that does not publish the review, or naming a job that does not read the findings (ORC-184)', () => {
      expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  review: { on_blocking: { run: fix-review } }\n') })).toThrow(/jobs\.review\.on_blocking/);
      expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  review-security: { on_blocking: { run: fix-ci } }\n') })).toThrow(/jobs\.review-security\.on_blocking\.run/);
      expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\njobs:\n  review-security: { on_blocking: { run: nowhere } }\n') })).toThrow(/jobs\.review-security\.on_blocking\.run/);
    });

    it("gives each job its step's network level, the answer agent its own (ORC-183, ORC-182)", () => {
      const { jobs } = loadWorkflow({ packDir });
      expect(jobs['dev']!.network).toBe('limited');
      expect(jobs['dev-feedback']!.network).toBe('limited');
      expect(jobs['ask']!.network).toBe('claude-api');
    });

    it('gives a read-only step (intake, clarify) and the AI review the read and search tools only; every other job all of them (ORC-367)', () => {
      const { jobs } = loadWorkflow({ packDir });
      expect(jobs['intake']).toMatchObject({ step: 'intake', workspace: 'trunk-readonly', tools: ['Read', 'Grep', 'Glob'] });
      for (const name of ['review', 'review-security']) expect(jobs[name]!.tools, name).toEqual(['Read', 'Grep', 'Glob']);
      for (const name of ['dev', 'tests', 'dev-feedback']) expect(jobs[name], name).not.toHaveProperty('tools');
      // A step that writes no code is not read-only for that: after_merge keeps its shell.
      const after = 'version: 1\njobs:\n  after: { step: after_merge, queue: dev, model: sonnet, workspace: worktree, skill: "factory:dev" }\n';
      expect(loadWorkflow({ packDir, projectFile: projectFile(after) }).jobs['after']).not.toHaveProperty('tools');
    });

    it('takes the after_merge step on a merge only: no other event carries a merged PR (ORC-197)', () => {
      expect(loadWorkflow({ packDir }).on['pr.merged']).toEqual([{ move: 'done', do: 'after_merge' }]);
      expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\non:\n  pr.closed:\n    - { do: after_merge }\n') })).toThrow(/on\.pr\.closed\[0\]\.do: after_merge/);
    });

    it("refuses a read-only step anywhere but a clone of its own: never the ticket's worktree (ORC-367)", () => {
      for (const ws of ['worktree', 'knowledge']) {
        expect(() => loadWorkflow({ packDir, projectFile: projectFile(`version: 1\njobs:\n  intake: { workspace: ${ws} }\n`) }), ws).toThrow(/jobs\.intake\.workspace/);
      }
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
      // `default` is for what neither the preset nor the job sets: the answer agent keeps its own.
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

  it('names the job that answers relayed questions alone, light: no move, post, check, review nor counter (ORC-375)', () => {
    const wf = loadWorkflow({ packDir });
    expect(wf.relayJob).toBe('answer-relayed');
    const job = wf.jobs['answer-relayed']!;
    expect(job).toMatchObject({ queue: 'dev', session: 'resume', workspace: 'worktree', input: 'feedback', verify: [], onStart: {}, onSuccess: {} });
    expect(job).not.toHaveProperty('repoChecks');
    expect(job).not.toHaveProperty('counter');
    // A project may leave it out: the reply rules' job answers then, as before ORC-375.
    expect(loadWorkflow({ packDir, projectFile: projectFile('version: 1\nrelay_job: dev-feedback\n') }).relayJob).toBe('dev-feedback');
  });

  it('refuses a relay job that is unknown, or does not resume the session of the agent that implements (ORC-375)', () => {
    expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\nrelay_job: nope\n') })).toThrow(/relay_job: unknown job "nope"/);
    expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\nrelay_job: ask\n') })).toThrow(/relay_job: "ask" must resume the ticket session/);
    expect(() => loadWorkflow({ packDir, projectFile: projectFile('version: 1\nrelay_job: review\n') })).toThrow(/relay_job: "review" must resume the ticket session/);
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
