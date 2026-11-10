import { describe, expect, it } from 'vitest';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { createHarness } from '../helpers/harness.js';

const WORKTREE = '/tmp/factory-fake/p/REL-1';
const BRANCH = 'factory/rel-1-export-csv';
const SHA = 'c0ffee'.padEnd(40, '0');
const PR = { number: 3, url: 'https://github.com/acme/app/pull/3' };

const lens = (summary: string): AgentOutput => ({ status: 'done', summary, tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], findings: [] });

/**
 * ORC-170, criterion 1: the statuses of the MVP. A ticket taken to the merge with the pack as it ships, whose Linear history
 * holds only two moves by a human, Todo (the ticket written and delegated) and Done (the merge decision): the factory sets
 * every status in between from its steps.
 */
describe('the statuses of the MVP (ORC-170)', () => {
  it('criterion 1: a ticket taken to the merge was moved by a human to Todo and Done only', async () => {
    const h = createHarness({ aiReview: true, authz: { githubLogins: { 'user-lilian': 'lilian-gh' } } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits to CSV from their list.' });
    h.tracker.setTeamMembers('REL', ['user-lilian']);
    h.forge.setRepoPermission('lilian-gh', 'write');
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: SHA, checks: 'pass', failedChecks: [] });
    h.workspaces.heads.set(WORKTREE, SHA);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Built.' }] }, { output: lens('Correctness lens.') }, { output: lens('Security lens.') });

    // What a human does, all of it: the ticket in Todo is delegated, then, once in Human Review, moved to Done.
    expect(h.tracker.issues.get('REL-1')!.stateName).toBe('Todo');
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', reviewSha: SHA, blocked: false });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([{ number: 3, sha: SHA }]);
    await h.send('pr.merged', { ...PR, branch: BRANCH, mergeSha: 'm1' });

    // Everything else is the factory's: In Progress, AI Review and Human Review, from its steps; never Todo nor Done.
    expect(h.tracker.calls.filter((c) => c.method === 'moveTo').map((c) => c.args[1])).toEqual(['In Progress', 'AI Review', 'Human Review']);
    expect(await h.ticket()).toMatchObject({ logical: 'done', prState: 'MERGED' });
  });
});
