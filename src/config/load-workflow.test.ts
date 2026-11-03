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
    expect(wf.jobs['ask']!.limits.usd).toBe(0.5);
    expect(wf.jobs['dev']!.limits.turns).toBe(150);
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
    expect(wf.jobs['review']!.onSuccess.move).toBe('human_review');
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
