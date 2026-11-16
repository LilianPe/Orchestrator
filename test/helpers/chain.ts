import type { FakeScript } from '../../src/adapters/runner/fake.js';
import type { AgentOutput } from '../../src/core/agent-output.js';
import type { Spec } from '../../src/core/spec.js';
import { createHarness, withTestCommand } from './harness.js';

/**
 * The chain a delegation starts on `factory/default` (ORC-395): `intake`, the spec and its human gate, then `tests`, the red
 * check and the freeze, before `build`. What a scenario of these steps, or of what follows them on the shipped chain, scripts.
 */

type Harness = ReturnType<typeof createHarness>;

/** The run's initiator, who delegates, and a designated validator, who approves the spec: never the same person (ORC-212). */
export const REQUESTER = 'user-armand';
export const VALIDATOR = 'user-lilian';
/** The harness's `authz` that lets `VALIDATOR` approve a spec `REQUESTER`'s delegation started. */
export const CHAIN_AUTHZ = { validators: [VALIDATOR], githubLogins: { [REQUESTER]: 'armand-gh', [VALIDATOR]: 'lilian-gh' } };

/** Both in the Linear team, with write access to the repository: either may delegate. */
export function chainTeam(h: Harness): void {
  h.tracker.setTeamMembers('REL', [REQUESTER, VALIDATOR]);
  h.forge.setRepoPermission('armand-gh', 'write');
  h.forge.setRepoPermission('lilian-gh', 'write');
}

export const WORKTREE = '/tmp/factory-fake/p/REL-1';

/**
 * A harness on the chain as it ships (`fullChain`): `CHAIN_AUTHZ` over `o.authz`, its team (`chainTeam`), the repository's test
 * command, which the red check runs, and the tests step's commit adding `src/export.test.ts` over the worktree's head.
 */
export function chainHarness(o: NonNullable<Parameters<typeof createHarness>[0]> = {}): Harness {
  const authz = { ...CHAIN_AUTHZ, ...o.authz, githubLogins: { ...CHAIN_AUTHZ.githubLogins, ...o.authz?.githubLogins } };
  const h = createHarness({ repoConfig: withTestCommand(), ...o, fullChain: true, authz });
  chainTeam(h);
  h.workspaces.heads.set(WORKTREE, 'base-sha');
  h.workspaces.steps.set(WORKTREE, { changed: [{ path: 'src/export.test.ts', deleted: false }] });
  return h;
}

/** `REQUESTER` delegates REL-1. */
export const delegate = (h: Harness, linearSessionId = 'ls-1') => h.send('ticket.delegated', { linearSessionId }, 'REL-1', { actor: REQUESTER });

const result = (summary: string): AgentOutput => ({ status: 'done', summary, tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] });

/** What intake submits: a complete ticket of size `s`, low risk, no screen, unless `patch` says otherwise. */
export const assessment = (patch: Partial<NonNullable<AgentOutput['intake']>> = {}): FakeScript => ({
  output: { ...result('Read.'), intake: { size: 's', risk: 'low', complete: true, missing: [], screen: false, ...patch } },
});

export const SPEC: Spec = {
  goal: 'Export the audits as CSV.',
  out_of_scope: ['XLSX'],
  criteria: ['Given 2 audits, when I click CSV, then a file of 3 lines downloads.'],
  files: ['src/export.ts'],
  architecture: 'None.',
  risks: [],
  assumed: ['The browser saves a text/csv response as a file.'],
};

/** What `spec_draft` submits. */
export const drafted = (spec: Spec = SPEC): FakeScript => ({ output: { ...result('Drafted.'), spec } });

/** The red check verified: the tests step's added test fails on an assertion (ORC-123). */
export const RED_ASSERTION = 'AssertionError: expected 1 to be 2';

/** `/approve` in the ticket's session, by `actor`. */
export const approveSpec = (h: Harness, actor = VALIDATOR, linearSessionId = 'ls-1') =>
  h.send('command', { name: '/approve', body: '', linearSessionId, author: actor === VALIDATOR ? 'Lilian' : 'Armand', kind: 'command' }, 'REL-1', { actor });

/**
 * From the spec's gate to the build: the red check verified (`RED_ASSERTION`), then `checks`, the failures of the checks after
 * it; the tests step's run, then `build`, the runs after it; and the validator's `/approve`.
 */
export async function toBuild(h: Harness, o: { build?: FakeScript[]; checks?: string[]; linearSessionId?: string } = {}): Promise<void> {
  h.checks.failNext(RED_ASSERTION);
  for (const output of o.checks ?? []) h.checks.failNext(output);
  h.runner.enqueue({}, ...(o.build ?? []));
  await approveSpec(h, VALIDATOR, o.linearSessionId);
}
