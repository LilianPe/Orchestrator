import { describe, expect, it } from 'vitest';
import { factoryDefault } from '../presets/factory-default.js';
import { checkBudgets } from '../presets/budget.js';
import { isAgentStep } from '../presets/preset.js';
import { configProblems, type ConfigFacts } from './config-check.js';

/** Budgets within the worst case of factory/default: every agent step capped, the ticket's cap above the worst case. */
const perStepTokens = Object.fromEntries(factoryDefault.steps.filter(isAgentStep).map((s) => [s.id, 1000]));
const budgets = { perStepTokens, perTicketTokens: checkBudgets(factoryDefault, { perStepTokens, perTicketTokens: Number.MAX_SAFE_INTEGER }).worst!.tokens };

const sound: ConfigFacts = { fakeRunner: false, sandboxes: true, hostVerify: false, publisher: true, budgets };

describe('configProblems (ORC-350)', () => {
  it('finds none in a configuration that can carry a ticket to its end', () => {
    expect(configProblems(sound)).toEqual([]);
  });

  it('names each setting under which every ticket would be blocked after its agent runs', () => {
    const host = { ...sound, sandboxes: false, publisher: false };
    expect(configProblems(host)).toEqual([
      'verify cannot run: no sandbox (FACTORY_CONTAINER_CLI) and no FACTORY_ALLOW_HOST_VERIFY=1',
      'publication impossible: it needs the sandboxes and the GitHub App',
    ]);
    expect(configProblems({ ...host, hostVerify: true })).toEqual(['publication impossible: it needs the sandboxes and the GitHub App']);
    expect(configProblems({ ...sound, publisher: false })).toEqual(['publication impossible: it needs the sandboxes and the GitHub App']);
  });

  it("refuses the budgets `factory validate` refuses, each violation named", () => {
    expect(configProblems({ ...sound, budgets: undefined })).toEqual(
      Object.keys(perStepTokens).map((id) => `factory.yml: budgets.per_step_tokens.${id}: not set; the worst case of factory/default has no bound without it`),
    );
    // The ticket's cap may come from each repository's .factory/config.yml, read at launch.
    expect(configProblems({ ...sound, budgets: { perStepTokens } })).toEqual([]);
    expect(configProblems({ ...sound, budgets: { ...budgets, perTicketTokens: 1 } })).toEqual([
      expect.stringMatching(/^factory\.yml: worst case \d+ tokens per ticket exceeds budgets\.per_ticket_tokens 1/),
    ]);
  });

  it('finds none with the fake runner, which reaches no model, spends no token and publishes nothing real', () => {
    expect(configProblems({ fakeRunner: true, sandboxes: false, hostVerify: true, publisher: true, budgets: undefined })).toEqual([]);
  });
});
