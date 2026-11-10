import { describe, expect, it } from 'vitest';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { createHarness } from '../helpers/harness.js';

const WORKTREE = '/tmp/factory-fake/p/REL-1';
const BRANCH = 'factory/rel-1-export-csv';
const SHA = 'c0ffee'.padEnd(40, '0');
const PR = { number: 3, url: 'https://github.com/acme/app/pull/3' };

const lens = (summary: string): AgentOutput => ({ status: 'done', summary, tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], findings: [] });

const reviewed = (sha: string) => ({ ...PR, state: 'OPEN' as const, headSha: sha, checks: 'pass' as const, failedChecks: [] });
const built = () => [{ events: [{ kind: 'text' as const, text: 'Built.' }] }, { output: lens('Correctness lens.') }, { output: lens('Security lens.') }];

/** The ticket written in Todo, its PR on `SHA`, the agents' runs scripted for `dev` and both lenses; `lilian` may merge. */
function delegable() {
  const h = createHarness({ aiReview: true, authz: { githubLogins: { 'user-lilian': 'lilian-gh' } } });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits to CSV from their list.' });
  h.tracker.setTeamMembers('REL', ['user-lilian']);
  h.forge.setRepoPermission('lilian-gh', 'write');
  h.forge.setPr(BRANCH, reviewed(SHA));
  h.workspaces.heads.set(WORKTREE, SHA);
  h.runner.enqueue(...built());
  return h;
}
const moves = (h: ReturnType<typeof createHarness>) => h.tracker.calls.filter((c) => c.method === 'moveTo').map((c) => c.args[1]);
const skills = (h: ReturnType<typeof createHarness>) => h.runner.requests.map((r) => r.prompt.split('\n')[0]);

/**
 * ORC-170, criterion 1: the statuses of the MVP. A ticket taken to the merge with the pack as it ships, whose Linear history
 * holds only two moves by a human, Todo (the ticket written and delegated) and Done (the merge decision): the factory sets
 * every status in between from its steps.
 */
describe('the statuses of the MVP (ORC-170)', () => {
  it('criterion 1: a ticket taken to the merge was moved by a human to Todo and Done only', async () => {
    const h = delegable();

    // What a human does, all of it: the ticket in Todo is delegated, then, once in Human Review, moved to Done.
    expect(h.tracker.issues.get('REL-1')!.stateName).toBe('Todo');
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', reviewSha: SHA, blocked: false });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([{ number: 3, sha: SHA }]);
    await h.send('pr.merged', { ...PR, branch: BRANCH, mergeSha: 'm1' });

    // Everything else is the factory's: In Progress, AI Review and Human Review, from its steps; never Todo nor Done.
    expect(moves(h)).toEqual(['In Progress', 'AI Review', 'Human Review']);
    expect(await h.ticket()).toMatchObject({ logical: 'done', prState: 'MERGED' });
  });

  it('a commit dev-feedback publishes, on a reply to a block with no step of its own, is reviewed with no human move to AI Review', async () => {
    const h = delegable();
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', reviewSha: SHA });

    // A stop is a block with no step of its own: the reply resumes the session by `dev-feedback`, which commits.
    await h.send('session.stopped', { linearSessionId: 'ls-1' });
    expect(await h.ticket()).toMatchObject({ blocked: true });
    const fixed = 'fade'.padEnd(40, '0');
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Fixed.' }] }, ...built().slice(1));
    h.workspaces.heads.set(WORKTREE, fixed);
    h.forge.setPr(BRANCH, reviewed(fixed));
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'Go on, and rename the export button.', author: 'L' }, 'REL-1', { actor: 'user-lilian' });

    // Its commit went through the AI review on its own, and Human Review shows it: the next Done merges it.
    expect(skills(h)).toEqual(['/factory:dev', '/factory:review', '/factory:review', '/factory:feedback', '/factory:review', '/factory:review']);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', reviewSha: fixed, blocked: false });
    expect(moves(h)).toEqual(['In Progress', 'AI Review', 'Human Review', 'AI Review', 'Human Review']);
  });

  it('a reply that commits nothing leaves the ticket in Human Review, on the commit already reviewed: no review again', async () => {
    const h = delegable();
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
    await h.send('session.stopped', { linearSessionId: 'ls-1' });

    h.runner.enqueue({ events: [{ kind: 'text', text: 'I was building the export; nothing to change.' }] });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'What were you doing?', author: 'L' }, 'REL-1', { actor: 'user-lilian' });

    expect(skills(h)).toEqual(['/factory:dev', '/factory:review', '/factory:review', '/factory:feedback']);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', reviewSha: SHA, blocked: false });
    expect(moves(h)).toEqual(['In Progress', 'AI Review', 'Human Review']);
  });
});
