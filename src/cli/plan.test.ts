import { describe, expect, it } from 'vitest';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { FakeWorkspaces } from '../adapters/workspace/fake.js';
import { defaultWorkflow } from '../presets/workflow.js';
import type { Workflow } from '../core/workflow.js';
import { newTicketState } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { formatPlan, planRows } from './plan.js';

describe('plan', () => {
  it('lists a ticket of a team with several repos once, under its repo, or as not taken when it names none (ORC-291)', async () => {
    const workflow = defaultWorkflow();
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
    const workflow = defaultWorkflow();
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
      ['REL-3', 'clarify'],
      ['REL-4', 'already handled'],
      ['REL-1', 'taken'],
    ]);
    expect(formatPlan(rows)).toContain('REL-3  clarify  Flou — intake, then clarify asks to complete the ticket: The description is shorter than 30 characters.');
  });

  it('previews not_started on git, the daemon reading it on the forge (ORC-207)', async () => {
    const workflow = defaultWorkflow();
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'a' });
    const workspaces = new FakeWorkspaces();
    workspaces.remoteBranches.add('factory/rel-1-old');
    const rows = await planRows({ tracker, store: new SqliteStore(':memory:'), projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], workspaces });
    expect(rows.map((r) => [r.status, r.reasons])).toEqual([['clarify', ['A branch of REL-1 already exists on origin.']]]);
  });

  it("previews by each repository's own branch naming, read once per project; an invalid one is that project's reason only (ORC-283)", async () => {
    const workflow = defaultWorkflow();
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'a' });
    tracker.addIssue({ identifier: 'REL-2', delegateId: 'a' });
    tracker.addIssue({ identifier: 'BAD-1', delegateId: 'a' });
    const workspaces = new FakeWorkspaces();
    workspaces.remoteBranches.add('agent/rel-1');
    const reads: string[] = [];
    const naming = async (p: { id: string }) => {
      reads.push(p.id);
      if (p.id === 'bad') throw new Error('.factory/config.yml refused:\n- branches.pattern: {id} is required');
      return { pattern: 'agent/{id}', types: [], fallback: 'feat' };
    };
    const projects = [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }, { id: 'bad', repoPath: '/b', teamKey: 'BAD', workflow }];
    const rows = await planRows({ tracker, store: new SqliteStore(':memory:'), projects, workspaces, naming });
    expect(rows.map((r) => [r.identifier, r.status, r.reasons])).toEqual([
      ['REL-1', 'clarify', ['A branch of REL-1 already exists on origin.']],
      ['REL-2', 'taken', []],
      ['BAD-1', 'not taken', ['.factory/config.yml refused:\n- branches.pattern: {id} is required']],
    ]);
    expect(reads.sort()).toEqual(['bad', 'p']);
  });

  it("shows a ticket whose pickup checks fail as going to intake's clarify, which asks to complete it, not as not taken (ORC-423)", async () => {
    const workflow = defaultWorkflow();
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', title: 'Flou', delegateId: 'a', description: 'court' });
    const rows = await planRows({ tracker, store: new SqliteStore(':memory:'), projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], workspaces: new FakeWorkspaces() });
    expect(rows.map((r) => [r.status, r.reasons])).toEqual([['clarify', ['The description is shorter than 30 characters.']]]);
    expect(formatPlan(rows)).toBe(
      'REL-1  clarify  Flou — intake, then clarify asks to complete the ticket: The description is shorter than 30 characters.',
    );
  });

  it('previews the launch of another entry: a job with pickup refuses the ticket, one without takes it; the Rapide level assumes the checks (ORC-423)', async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', title: 'Flou', delegateId: 'a', description: 'court' });
    const preview = async (workflow: Workflow) =>
      (await planRows({ tracker, store: new SqliteStore(':memory:'), projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], workspaces: new FakeWorkspaces() }))[0]!;
    const entered = (entry: string, pickup: boolean): Workflow => {
      const wf = defaultWorkflow();
      return { ...wf, entry, jobs: Object.fromEntries(Object.entries(wf.jobs).map(([name, j]) => [name, j.step === entry ? { ...j, pickup } : j])) };
    };
    expect((await preview(entered('build', true))).status).toBe('not taken');
    expect((await preview(entered('build', false))).status).toBe('taken');
    const rapide = await preview({ ...defaultWorkflow(), level: 'rapide' });
    expect([rapide.status, formatPlan([rapide])]).toEqual(['taken', 'REL-1  taken  Flou — assumed: The description is shorter than 30 characters.']);
  });
});
