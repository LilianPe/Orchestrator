import type { Preset } from './preset.js';

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
/** Turn cap of the steps the MVP doc leaves open: the former `per_run.turns` of the standard pack. */
const DEFAULT_TURNS = 150;

/** The only preset of the MVP (ORC-187). Its hash freezes the runs that start on it. */
export const factoryDefault: Preset = {
  name: 'factory/default',
  entry: 'intake',
  counters: {
    spec_check: { limit: 1 },
    spec_review: { limit: 3 },
    // The red check's checks in blocking mode, the job's `red.attempts`: the 2nd unverified red blocks (ORC-123).
    red: { limit: 2 },
    verify: { limit: 3 },
    review_ci: { limit: 2 },
    human_review: { limit: 3 },
  },
  sameFailure: { limit: 3, cause: 'boucle' },
  // Longer than any Bash call of Claude Code (10 min at most) and than a slow model call retried: a long test run is no silence.
  silentRun: { minutes: 30 },
  redCi: { goto: 'fix', counter: 'review_ci' },
  // A conflict with the default branch (ORC-146): the rebase step, on the counter of the review and CI loop.
  conflict: { goto: 'rebase', counter: 'review_ci' },
  // The approvers of each diff class (ORC-198): a human's Done for every one; the verification configuration also waits,
  // before publication, for a designated maintainer's `/refreeze`.
  approvers: { normal: ['done_merge'], sensitive: ['done_merge'], 'verification-config': ['refreeze', 'done_merge'] },
  steps: [
    { id: 'intake', type: 'agent_step', writes: 'nothing', readOnly: true, model: SONNET, effort: 'low', maxTurns: DEFAULT_TURNS, network: 'limited', next: 'clarify' },
    { id: 'clarify', type: 'agent_step', writes: 'nothing', readOnly: true, model: SONNET, effort: 'low', maxTurns: DEFAULT_TURNS, network: 'limited', optional: true, next: 'spec_draft' },
    // Read-only (ORC-383): it hands the spec back through `submit_result`, nothing in the worktree.
    { id: 'spec_draft', type: 'agent_step', writes: 'spec', readOnly: true, model: SONNET, effort: 'high', maxTurns: DEFAULT_TURNS, network: 'limited', next: 'spec_check' },
    { id: 'spec_check', type: 'spec_check', network: 'none', next: 'spec_review', onFailure: { goto: 'spec_draft', counter: 'spec_check' } },
    { id: 'spec_review', type: 'human_gate', gate: 'spec', next: 'tests', onFailure: { goto: 'spec_draft', counter: 'spec_review' } },
    { id: 'tests', type: 'agent_step', writes: 'tests', model: SONNET, effort: 'medium', maxTurns: DEFAULT_TURNS, network: 'limited', next: 'red' },
    { id: 'red', type: 'verify', mode: 'red', network: 'none', next: 'freeze_tests', onFailure: { goto: 'tests', counter: 'red' } },
    { id: 'freeze_tests', type: 'verify', mode: 'freeze', network: 'none', next: 'build' },
    {
      id: 'build', type: 'agent_step', skill: 'factory:dev', writes: 'code',
      model: SONNET, effort: 'medium', maxTurns: 150, network: 'limited', next: 'verify',
    },
    { id: 'verify', type: 'verify', mode: 'full', network: 'none', next: 'publish', onFailure: { goto: 'build', counter: 'verify' } },
    // A red CI is the failure of `publish`: it follows `redCi`.
    { id: 'publish', type: 'publish', mode: 'push', next: 'review' },
    {
      id: 'review', type: 'review', skill: 'factory:review', readOnly: true,
      model: OPUS, effort: 'high', maxTurns: 25, network: 'claude-api', next: 'human_review', onFailure: { goto: 'fix', counter: 'review_ci' },
    },
    { id: 'human_review', type: 'human_gate', gate: 'merge', next: 'merge', onFailure: { goto: 'fix', counter: 'human_review' } },
    // Run by the factory once an authorized human moves the ticket to Done (ORC-148).
    { id: 'merge', type: 'publish', mode: 'merge', next: 'after_merge' },
    { id: 'after_merge', type: 'agent_step', writes: 'nothing', model: SONNET, effort: 'medium', maxTurns: DEFAULT_TURNS, network: 'limited', next: null },
    // The loop after publication: fix → verify → publish → AI review, then the human gate again.
    {
      id: 'fix', type: 'fix', skills: { ci: 'factory:fix-ci', review: 'factory:feedback', human: 'factory:feedback' },
      model: SONNET, effort: 'medium', maxTurns: 60, network: 'limited', next: 'verify_fix',
    },
    { id: 'verify_fix', type: 'verify', mode: 'full', network: 'none', next: 'publish', onFailure: { goto: 'fix', counter: 'verify' } },
    // A conflict with the default branch: rebased in the ticket's sandbox, verified, then published over the factory's own head.
    {
      id: 'rebase', type: 'agent_step', skill: 'factory:rebase', writes: 'code',
      model: SONNET, effort: 'medium', maxTurns: 60, network: 'limited', next: 'verify_rebase',
    },
    { id: 'verify_rebase', type: 'verify', mode: 'full', network: 'none', next: 'publish', onFailure: { goto: 'rebase', counter: 'verify' } },
  ],
};
