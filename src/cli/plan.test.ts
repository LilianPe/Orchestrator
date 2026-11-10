import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { FakeWorkspaces } from '../adapters/workspace/fake.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { newTicketState } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { formatPlan, planRows } from './plan.js';

describe('plan', () => {
  it('lists a ticket of a team with several repos once, under its repo, or as not taken when it names none (ORC-291)', async () => {
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'a', labels: ['repo:api'] });
    tracker.addIssue({ identifier: 'REL-2', delegateId: 'a' });
    const projects = ['web', 'api'].map((id) => ({ id, repoPath: `/${id}`, teamKey: 'REL', workflow }));
    tracker.addIssue({ identifier: 'REL-3', delegateId: 'a', labels: ['repo:api'] });
    const store = new SqliteStore(':memory:');
    // Held by the first repo: it stays there, whatever its label says.
    await store.putTicket({ ...newTicketState('web', 'REL-3', 'T', 'dev', 1), delegated: true });
    const rows = await planRows({ tracker, store, projects, workspaces: new FakeWorkspaces() });
    expect(rows.map((r) => [r.identifier, r.status, r.reasons])).toEqual([
      ['REL-1', 'taken', []],
      ['REL-2', 'not taken', ['repository to specify (repo:web, repo:api)']],
      ['REL-3', 'already handled', ['dev']],
    ]);
  });

  it('classifies delegated tickets by priority', async () => {
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', title: 'Bas', delegateId: 'a', priority: 4 });
    tracker.addIssue({ identifier: 'REL-2', title: 'Urgent', delegateId: 'a', priority: 1 });
    tracker.addIssue({ identifier: 'REL-3', title: 'Flou', delegateId: 'a', priority: 2, description: 'court' });
    tracker.addIssue({ identifier: 'REL-4', title: 'En cours', delegateId: 'a', priority: 3 });
    const store = new SqliteStore(':memory:');
    await store.putTicket(newTicketState('p', 'REL-4', 'En cours', 'dev', 1));
    const rows = await planRows({ tracker, store, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], workspaces: new FakeWorkspaces() });
    expect(rows.map((r) => [r.identifier, r.status])).toEqual([
      ['REL-2', 'taken'],
      ['REL-3', 'not taken'],
      ['REL-4', 'already handled'],
      ['REL-1', 'taken'],
    ]);
    expect(formatPlan(rows)).toContain('REL-3  not taken  Flou — The description is shorter than 30 characters.');
  });

  it('previews not_started on git, the daemon reading it on the forge (ORC-207)', async () => {
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'a' });
    const workspaces = new FakeWorkspaces();
    workspaces.remoteBranches.add('factory/rel-1-old');
    const rows = await planRows({ tracker, store: new SqliteStore(':memory:'), projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], workspaces });
    expect(rows.map((r) => [r.status, r.reasons])).toEqual([['not taken', ['A branch of REL-1 already exists on origin.']]]);
  });
});
