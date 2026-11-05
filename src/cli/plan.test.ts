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
      ['REL-1', 'pris', []],
      ['REL-2', 'pas pris', ['dépôt à préciser (repo:web, repo:api)']],
      ['REL-3', 'déjà géré', ['dev']],
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
      ['REL-2', 'pris'],
      ['REL-3', 'pas pris'],
      ['REL-4', 'déjà géré'],
      ['REL-1', 'pris'],
    ]);
    expect(formatPlan(rows)).toContain('REL-3  pas pris  Flou — La description fait moins de 30 caractères.');
  });
});
