import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow, WorkflowError } from './load-workflow.js';

const packDir = join(import.meta.dirname, '../../packs/standard');

function projectFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'relais-wf-'));
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
    expect(wf.on['session.prompted']).toHaveLength(2);
    expect(wf.on['session.prompted']![1]!.debounceMs).toBe(180_000);
    expect(wf.commands).toEqual(['retiens', 'fais-le']);
  });

  it('resolves extends field by field', () => {
    const wf = loadWorkflow({ packDir });
    const fb = wf.jobs['dev-feedback']!;
    expect(fb.queue).toBe('dev');
    expect(fb.model).toBe('sonnet');
    expect(fb.session).toBe('resume');
    expect(fb.skill).toBe('relais:feedback');
    expect(fb.onStart).toEqual({});
    expect(wf.jobs['fix-ci']!.input).toBe('ci_failures');
    expect(wf.jobs['fix-ci']!.skill).toBe('relais:fix-ci');
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

  it('rejects a rule that runs an unknown job', () => {
    expect(() =>
      loadWorkflow({ packDir, projectFile: projectFile('version: 1\non:\n  ticket.delegated:\n    - { run: nope }\n') }),
    ).toThrow(WorkflowError);
  });
});
