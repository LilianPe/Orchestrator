import { describe, expect, it } from 'vitest';
import { checkBudgets, worstCase, type BudgetCaps } from './budget.js';
import { factoryDefault } from './factory-default.js';
import { compilePreset, isAgentStep, PresetError, type Preset } from './preset.js';

const AGENTS = factoryDefault.steps.filter(isAgentStep).map((s) => s.id);
const every = (tokens: number): Record<string, number> => Object.fromEntries(AGENTS.map((s) => [s, tokens]));

/** build → verify (back to build, `v`) → review (back to fix, `r`); fix → verify_fix (back to fix, `v`) → review. */
const loop: Preset = {
  name: 'test/loop',
  entry: 'build',
  counters: { v: { limit: 2 }, r: { limit: 1 } },
  sameFailure: { limit: 3, cause: 'boucle' },
  silentRun: { minutes: 30 },
  redCi: { goto: 'fix', counter: 'r' },
  conflict: { goto: 'fix', counter: 'r' },
  approvers: { normal: ['done_merge'], sensitive: ['done_merge'], 'verification-config': ['refreeze', 'done_merge'] },
  steps: [
    { id: 'build', type: 'agent_step', writes: 'code', model: 'm', effort: 'low', maxTurns: 10, network: 'limited', next: 'verify' },
    { id: 'verify', type: 'verify', mode: 'full', network: 'none', next: 'review', onFailure: { goto: 'build', counter: 'v' } },
    { id: 'review', type: 'review', skill: 's', readOnly: true, model: 'm', effort: 'low', maxTurns: 5, network: 'claude-api', next: null, onFailure: { goto: 'fix', counter: 'r' } },
    { id: 'fix', type: 'fix', skills: { ci: 'a', review: 'b', human: 'c' }, model: 'm', effort: 'low', maxTurns: 4, network: 'limited', next: 'verify_fix' },
    { id: 'verify_fix', type: 'verify', mode: 'full', network: 'none', next: 'review', onFailure: { goto: 'fix', counter: 'v' } },
  ],
};

describe('the worst case of a preset (ORC-216)', () => {
  it('takes every way back as often as its counter allows, a check that passes refilling its own', () => {
    // `v` spent on the build (3 × 100), refilled when `verify` passes (as the engine's `verify.passed`), spent again on the fix (3 × 50).
    expect(worstCase(loop, { perStepTokens: { build: 100, review: 10, fix: 50 } })).toEqual({ tokens: 300 + 10 + 150 + 10, turns: 30 + 5 + 12 + 5, attempts: { build: 3, review: 2, fix: 3 } });
  });

  it('a counter that is not refilled is shared by all its ways back: spent where it costs the most', () => {
    const shared: Preset = { ...loop, steps: loop.steps.map((s) => (s.type === 'verify' ? { ...s, type: 'spec_check' as const } : s)) };
    expect(worstCase(shared, { perStepTokens: { build: 100, review: 10, fix: 50 } })).toMatchObject({ tokens: 300 + 10 + 50 + 10, attempts: { build: 3, review: 2, fix: 1 } });
    expect(worstCase(shared, { perStepTokens: { build: 10, review: 10, fix: 50 } })).toMatchObject({ tokens: 10 + 10 + 150 + 10, attempts: { build: 1, review: 2, fix: 3 } });
  });

  it('names a way back no counter bounds', () => {
    // The review sends back to the build, whose check refills the counter the review spends: no end.
    const refilling: Preset = { ...loop, steps: loop.steps.map((s) => (s.id === 'review' ? { ...s, onFailure: { goto: 'build', counter: 'v' } } : s)) };
    expect(worstCase(refilling, { perStepTokens: { build: 1, review: 1, fix: 1 } })).toMatchObject({ unbounded: expect.any(String) });
  });

  it('counts the turns of a step as `max_turns` lowers them, never raises them', () => {
    const caps = { perStepTokens: { build: 1, review: 1, fix: 1 } };
    expect(worstCase(loop, { ...caps, maxTurns: { build: 2 } })).toMatchObject({ turns: 3 * 2 + 5 + 3 * 4 + 5 });
    expect(worstCase(loop, { ...caps, maxTurns: { build: 999 } })).toMatchObject({ turns: 3 * 10 + 5 + 3 * 4 + 5 });
  });

  it('on factory/default: 41 agent attempts at most, the review loop twice and the human one three times', () => {
    // Each of the 5 entries into `fix` gets its 3 retries of `verify` again, as the build does.
    expect(worstCase(factoryDefault, { perStepTokens: every(1) })).toEqual({
      tokens: 41, turns: 3600, attempts: { intake: 1, clarify: 1, spec_draft: 5, tests: 3, build: 4, review: 6, after_merge: 1, fix: 20, rebase: 0 },
    });
  });

  it('on factory/default: counts the rebases a conflict starts, on the review and CI counter, where they cost more than a fix (ORC-146)', () => {
    // The 2 runs of `review_ci` go to `rebase` (each with its 3 retries of `verify_rebase`) instead of `fix`; the human loop keeps its 3 entries into `fix`.
    expect(worstCase(factoryDefault, { perStepTokens: { ...every(1), rebase: 2 } })).toMatchObject({
      tokens: 41 - 8 + 8 * 2, attempts: { review: 6, fix: 12, rebase: 8 },
    });
  });

  it('has no bound while a step has no cap in tokens: it names each one', () => {
    expect(worstCase(loop, { perStepTokens: { build: 100 } })).toEqual({ missing: ['budgets.per_step_tokens.review', 'budgets.per_step_tokens.fix'] });
  });
});

describe('the invariant « budget caps » of the core (ORC-216)', () => {
  const capped = (perTicketTokens?: number): BudgetCaps => ({ perStepTokens: every(1_000), ...(perTicketTokens ? { perTicketTokens } : {}) });

  it('passes a worst case under the ticket cap, the cap itself included', () => {
    expect(checkBudgets(factoryDefault, capped(41_000))).toMatchObject({ violations: [], worst: { tokens: 41_000 } });
  });

  it('refuses a worst case over the ticket cap, saying by how much', () => {
    expect(checkBudgets(factoryDefault, capped(40_999)).violations).toEqual([
      'worst case 41000 tokens per ticket exceeds budgets.per_ticket_tokens 40999: lower a step\'s per_step_tokens or a counter of factory/default',
    ]);
  });

  it('refuses while a cap is still to set, rather than passing', () => {
    expect(checkBudgets(factoryDefault, {}).violations).toEqual([
      ...AGENTS.map((s) => `budgets.per_step_tokens.${s}: not set; the worst case of factory/default has no bound without it`),
      'budgets.per_ticket_tokens: not set; the worst case of factory/default has no bound without it',
    ]);
  });

  it('is checked when the preset compiles with its budgets', () => {
    expect(() => compilePreset(factoryDefault, { budgets: capped(41_000) })).not.toThrow();
    expect(() => compilePreset(factoryDefault, { budgets: capped(1_000) })).toThrow(PresetError);
    // Without budgets, as the daemon loads it: the caps are to calibrate, the structure alone is checked.
    expect(() => compilePreset(factoryDefault)).not.toThrow();
  });
});
