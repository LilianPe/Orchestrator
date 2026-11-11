import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factoryDefault } from './factory-default.js';
import { compilePreset, PresetError, type CompileOptions, type Preset, type Step } from './preset.js';

const pack = join(import.meta.dirname, '../../packs/standard');

function clone(preset: Preset = factoryDefault): Preset {
  return structuredClone(preset);
}

function step(preset: Preset, id: string): Step {
  const found = preset.steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

/** Removes a step and points its predecessors at its successor, as an edited preset would. */
function without(preset: Preset, id: string): Preset {
  const removed = step(preset, id);
  const steps = preset.steps.filter((s) => s.id !== id).map((s) => (s.next === id ? { ...s, next: removed.next } : s));
  return { ...preset, steps };
}

function violations(preset: Preset, repoNetwork?: CompileOptions['repoNetwork']): string[] {
  try {
    compilePreset(preset, { repoNetwork });
    return [];
  } catch (err) {
    if (err instanceof PresetError) return err.violations;
    throw err;
  }
}

describe('factory/default', () => {
  it('compiles with every invariant of the core present', () => {
    expect(violations(factoryDefault)).toEqual([]);
  });

  it('chains the steps of the MVP doc', () => {
    const order: string[] = [];
    for (let s: Step | undefined = step(factoryDefault, factoryDefault.entry); s; s = s.next ? step(factoryDefault, s.next) : undefined) order.push(s.id);
    expect(order).toEqual([
      'intake', 'clarify', 'spec_draft', 'spec_check', 'spec_review', 'tests', 'red', 'freeze_tests', 'build', 'verify', 'publish',
      'review', 'human_review', 'merge', 'after_merge',
    ]);
  });

  it('bounds every loop with the table of the doc', () => {
    expect(factoryDefault.counters).toEqual({
      spec_check: { limit: 1 },
      spec_review: { limit: 3 },
      red: { limit: 2 },
      verify: { limit: 3 },
      review_ci: { limit: 2 },
      human_review: { limit: 3 },
    });
    expect(factoryDefault.sameFailure).toEqual({ limit: 3, cause: 'boucle' });
    expect(factoryDefault.silentRun).toEqual({ minutes: 30 });
    expect(() => compilePreset({ ...factoryDefault, silentRun: { minutes: 0 } })).toThrow(/silentRun/);
    expect(step(factoryDefault, 'verify').onFailure).toEqual({ goto: 'build', counter: 'verify' });
    expect(step(factoryDefault, 'spec_check').onFailure).toEqual({ goto: 'spec_draft', counter: 'spec_check' });
    expect(step(factoryDefault, 'red').onFailure).toEqual({ goto: 'tests', counter: 'red' });
  });

  it('counts the AI review rounds and a red CI on one counter', () => {
    expect(step(factoryDefault, 'review').onFailure).toEqual({ goto: 'fix', counter: 'review_ci' });
    expect(step(factoryDefault, 'publish').onFailure).toBeUndefined();
    expect(factoryDefault.redCi).toEqual({ goto: 'fix', counter: 'review_ci' });
    expect(step(factoryDefault, 'human_review').onFailure).toEqual({ goto: 'fix', counter: 'human_review' });
  });

  it('sends a fix back through verify, publish and the AI review', () => {
    expect(step(factoryDefault, 'fix').next).toBe('verify_fix');
    expect(step(factoryDefault, 'verify_fix')).toMatchObject({ next: 'publish', onFailure: { goto: 'fix', counter: 'verify' } });
  });

  it('sends a conflict with the default branch to a rebase step, on the review and CI counter, then through verify and publish (ORC-146)', () => {
    expect(factoryDefault.conflict).toEqual({ goto: 'rebase', counter: 'review_ci' });
    expect(step(factoryDefault, 'rebase')).toMatchObject({ type: 'agent_step', writes: 'code', skill: 'factory:rebase', model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 60, network: 'limited', next: 'verify_rebase' });
    expect(step(factoryDefault, 'verify_rebase')).toMatchObject({ type: 'verify', mode: 'full', network: 'none', next: 'publish', onFailure: { goto: 'rebase', counter: 'verify' } });
  });

  it('refuses a conflict edge to an unknown step or on an undeclared counter', () => {
    expect(violations({ ...factoryDefault, conflict: { goto: 'nowhere', counter: 'review_ci' } })).toContain('conflict: goto nowhere is not a step');
    expect(violations({ ...factoryDefault, conflict: { goto: 'rebase', counter: 'rebases' } })).toContain('conflict: counter rebases is not declared');
  });

  it('sets model, effort and turns per step', () => {
    expect(step(factoryDefault, 'build')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 150 });
    expect(step(factoryDefault, 'fix')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 60 });
    expect(step(factoryDefault, 'review')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', maxTurns: 25 });
    expect(step(factoryDefault, 'intake')).toMatchObject({ effort: 'low' });
    expect(step(factoryDefault, 'clarify')).toMatchObject({ effort: 'low' });
    expect(step(factoryDefault, 'spec_draft')).toMatchObject({ effort: 'high' });
  });

  it('only references skills the standard pack ships', () => {
    const skills = factoryDefault.steps.flatMap((s) => (s.type === 'fix' ? Object.values(s.skills) : 'skill' in s && s.skill ? [s.skill] : []));
    expect(skills).toEqual(expect.arrayContaining(['factory:dev', 'factory:fix-ci', 'factory:feedback', 'factory:review', 'factory:rebase']));
    for (const skill of skills) {
      const [plugin, name] = skill.split(':');
      expect(plugin).toBe('factory');
      expect(existsSync(join(pack, 'skills', name!, 'SKILL.md')), skill).toBe(true);
    }
  });
});

describe('compilePreset', () => {
  it('gives a stable hash that ignores key order', () => {
    const a = compilePreset(factoryDefault).hash;
    const reordered = clone();
    reordered.steps = reordered.steps.map((s) => Object.fromEntries(Object.entries(s).reverse()) as Step);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(compilePreset(factoryDefault).hash).toBe(a);
    expect(compilePreset(reordered).hash).toBe(a);
  });

  it('changes the hash when a bound changes', () => {
    const changed = clone();
    changed.counters.verify = { limit: 4 };
    expect(compilePreset(changed).hash).not.toBe(compilePreset(factoryDefault).hash);
  });

  it('refuses a step that widens the network level of the repository', () => {
    expect(violations(factoryDefault, 'claude-api')).toContain('step build: network limited is wider than the repository level claude-api');
  });

  it('refuses full network on any step, even on a full repository', () => {
    const p = clone();
    step(p, 'build').network = 'full';
    expect(violations(p, 'full')).toContain('step build: network full is reserved for setup');
  });

  it('keeps verify offline and the reviewer on the Claude API at most', () => {
    const p = clone();
    step(p, 'verify').network = 'limited';
    step(p, 'review').network = 'limited';
    expect(violations(p)).toEqual(
      expect.arrayContaining(['step verify: a verify step must run with network none', 'step review: a review step runs with network claude-api at most']),
    );
  });

  it('refuses a reviewer that can write', () => {
    const p = clone();
    (step(p, 'review') as { readOnly: boolean }).readOnly = false;
    expect(violations(p)).toContain('step review: a review step must be read-only');
  });

  it('refuses a read-only step that writes in its worktree, and accepts one that hands back a spec (ORC-367, ORC-383)', () => {
    for (const writes of ['tests', 'code']) {
      const p = clone();
      (step(p, 'intake') as { writes: string }).writes = writes;
      expect(violations(p), writes).toContain('step intake: a read-only step writes nothing in its worktree');
    }
    const p = clone();
    (step(p, 'intake') as { writes: string }).writes = 'spec';
    expect(violations(p)).toEqual([]);
  });

  it('refuses a build reachable without freezing the tests', () => {
    expect(violations(without(factoryDefault, 'freeze_tests'))).toContain('step build: reachable without freezing the tests first');
  });

  it('refuses a merge reachable without the human merge gate', () => {
    expect(violations(without(factoryDefault, 'human_review'))).toContain('step merge: reachable from written code without a merge gate');
  });

  it("declares the approvers of each diff class (ORC-198): a human's Done for every class, and a maintainer's /refreeze for the verification configuration", () => {
    expect(factoryDefault.approvers).toEqual({ normal: ['done_merge'], sensitive: ['done_merge'], 'verification-config': ['refreeze', 'done_merge'] });
  });

  it("refuses a diff class approved without a human's Done: no auto-merge, in any form (ORC-198)", () => {
    const p = { ...clone(), approvers: { ...factoryDefault.approvers, normal: [], 'verification-config': ['refreeze' as const] } };
    expect(violations(p)).toEqual(['approvers of normal: a human done_merge is required, the factory never merges on its own', 'approvers of verification-config: a human done_merge is required, the factory never merges on its own']);
  });

  it('refuses an unbounded cycle', () => {
    const p = clone();
    step(p, 'publish').next = 'build';
    expect(violations(p)).toContain('unbounded cycle through build → verify → publish → build');
  });

  it('refuses a failure edge on an undeclared counter', () => {
    const p = clone();
    step(p, 'verify').onFailure = { goto: 'build', counter: 'nope' };
    expect(violations(p)).toContain('step verify: counter nope is not declared');
  });

  it('refuses a counter without a positive limit', () => {
    const p = clone();
    p.counters.verify = { limit: 0 };
    expect(violations(p)).toContain('counter verify: limit must be a positive integer');
  });

  it('refuses an agent step without a turn cap', () => {
    const p = clone();
    (step(p, 'build') as { maxTurns: number }).maxTurns = 0;
    expect(violations(p)).toContain('step build: maxTurns must be a positive integer');
  });

  it('refuses a counter name inherited from Object', () => {
    const p = clone();
    step(p, 'verify').onFailure = { goto: 'build', counter: 'toString' };
    expect(violations(p)).toContain('step verify: counter toString is not declared');
  });

  it('makes every agent step say what it writes', () => {
    const p = clone();
    delete (step(p, 'build') as { writes?: string }).writes;
    expect(violations(p)).toContain('step build: an agent step must declare what it writes');
  });

  it('refuses a step writing code before the tests are frozen', () => {
    const p = clone();
    (step(p, 'tests') as { writes: string }).writes = 'code';
    expect(violations(p)).toContain('step tests: reachable without freezing the tests first');
  });

  it('refuses a link to an unknown step', () => {
    const p = clone();
    step(p, 'build').next = 'nowhere';
    expect(violations(p)).toContain('step build: next nowhere is not a step');
  });
});
