import { describe, expect, it } from 'vitest';
import { factoryDefault } from './factory-default.js';
import { compilePreset, type Step } from './preset.js';
import { narrowTools, READ_TOOLS, stepTools, toolRefusal, WRITE_TOOLS } from './tools.js';

const step = (id: string): Step => factoryDefault.steps.find((s) => s.id === id)!;

describe('tools of a step (ORC-383)', () => {
  it('gives the steps that read the read and search tools, and the steps that write the write tools, by default', () => {
    for (const id of ['intake', 'clarify', 'spec_draft', 'review']) expect(stepTools(step(id)), id).toEqual(READ_TOOLS);
    for (const id of ['tests', 'build', 'fix', 'rebase']) expect(stepTools(step(id)), id).toEqual(WRITE_TOOLS);
    // No agent, no tools: spec_check is the factory's own check.
    for (const id of ['spec_check', 'verify', 'publish', 'human_review']) expect(stepTools(step(id)), id).toBeUndefined();
  });

  it('writes with no subagent and no web tool: neither is a default', () => {
    expect(READ_TOOLS).toEqual(['Read', 'Grep', 'Glob']);
    expect(WRITE_TOOLS).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']));
    for (const tool of ['Task', 'Agent', 'WebFetch', 'WebSearch']) expect(WRITE_TOOLS).not.toContain(tool);
  });

  it('keeps factory/default valid with spec_draft read-only: it writes the spec through submit_result, nothing in the worktree', () => {
    expect(() => compilePreset(factoryDefault)).not.toThrow();
    expect(step('spec_draft')).toMatchObject({ readOnly: true, writes: 'spec' });
  });

  it('refuses a write tool or a shell for a read-only step', () => {
    for (const tool of ['Edit', 'Write', 'Bash', 'NotebookEdit']) expect(toolRefusal(step('review'), tool), tool).toMatch(/read-only/);
    for (const tool of READ_TOOLS) expect(toolRefusal(step('review'), tool), tool).toBeUndefined();
  });

  it('refuses WebFetch below network limited, WebSearch always, and a tool the factory does not know', () => {
    expect(toolRefusal(step('build'), 'WebFetch')).toBeUndefined();
    expect(toolRefusal(step('build'), 'WebFetch', 'none')).toMatch(/WebFetch.*network limited.*none/);
    expect(toolRefusal(step('build'), 'WebFetch', 'claude-api')).toMatch(/claude-api/);
    expect(toolRefusal(step('build'), 'WebSearch')).toMatch(/WebSearch/);
    expect(toolRefusal(step('build'), 'Task')).toMatch(/not a tool/);
    expect(toolRefusal(step('build'), 'bash')).toMatch(/not a tool/);
  });

  it("narrows a step's tools to the repository's list, and drops WebFetch where the network does not reach", () => {
    expect(narrowTools(WRITE_TOOLS, ['Read', 'Edit', 'Bash'], 'limited')).toEqual(['Read', 'Edit', 'Bash']);
    // The repository restricts: what the factory does not give, it cannot add.
    expect(narrowTools(READ_TOOLS, ['Read', 'Edit'], 'limited')).toEqual(['Read']);
    expect(narrowTools([...WRITE_TOOLS, 'WebFetch'], undefined, 'none')).toEqual(WRITE_TOOLS);
    expect(narrowTools([...WRITE_TOOLS, 'WebFetch'], undefined, 'limited')).toEqual([...WRITE_TOOLS, 'WebFetch']);
    // A version frozen before ORC-383 has every tool for a step that writes: the repository's list, alone, holds it.
    expect(narrowTools(undefined, ['Read', 'Bash'], 'limited')).toEqual(['Read', 'Bash']);
    expect(narrowTools(undefined, undefined, 'limited')).toBeUndefined();
  });
});
