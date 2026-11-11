import { describe, expect, it } from 'vitest';
import { parseRepoConfig } from '../../src/config/repo-config.js';
import { createHarness } from '../helpers/harness.js';

/** ORC-283: the ticket's branch by the team's convention, or the repository's, given once and kept. */
describe("the ticket's branch name", () => {
  /** Sandboxed, its clean check green: the factory publishes, so the branch it pushes shows. */
  const publishing = (opts: Parameters<typeof createHarness>[0] = {}) =>
    createHarness({ ...opts, sandboxed: true, cleanVerify: async () => ({ ok: true, failures: [], sha: 'head', tree: 'tree-head', commands: [] }) });
  const DONE = { status: 'done' as const, summary: 'Audits export to CSV.', tests_added: ['src/export.test.ts'], why: '', assumptions: [], risks: [], untested: [], review_hints: [] };

  async function delegated(h: ReturnType<typeof createHarness>, labels: string[] = []) {
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.', labels });
    h.runner.enqueue({ output: DONE });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
  }

  it("follows the team's convention: feat/ for a feature, fix/ for a Bug label, then the identifier and the title", async () => {
    const feature = publishing();
    await delegated(feature, ['Feature']);
    expect(await feature.ticket()).toMatchObject({ branch: 'feat/rel-1-export-csv' });
    expect(feature.runner.requests[0]!.prompt).toContain('Branch: feat/rel-1-export-csv');
    expect(feature.publisher.published.map((p) => p.branch)).toEqual(['feat/rel-1-export-csv']);

    const bug = createHarness();
    await delegated(bug, ['Bug']);
    expect(await bug.ticket()).toMatchObject({ branch: 'fix/rel-1-export-csv' });
  });

  it("follows the repository's own naming, read on its default branch", async () => {
    const h = createHarness({ repoConfig: async () => parseRepoConfig('branches: { pattern: "agent/{type}/{id}", types: { Bug: bugfix, default: work } }\n') });
    await delegated(h, ['bug']);
    expect(await h.ticket()).toMatchObject({ branch: 'agent/bugfix/rel-1' });
  });

  it('keeps the legacy factory/ branch of a ticket whose PR is already open on it: no second branch, no second PR', async () => {
    const h = publishing();
    h.workspaces.remoteBranches.add('factory/rel-1-export-csv');
    await delegated(h);
    expect(await h.ticket()).toMatchObject({ branch: 'factory/rel-1-export-csv' });
    expect(h.workspaces.prepared.map((p) => p.branch)).toEqual(['feat/rel-1-export-csv']);
    expect(h.publisher.published.map((p) => p.branch)).toEqual(['factory/rel-1-export-csv']);
  });

  it('keeps the branch recorded on the ticket when its labels change since: the next run asks for the same one', async () => {
    const h = createHarness();
    await delegated(h, ['Feature']);
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.', labels: ['Bug'] });
    h.runner.enqueue({ output: DONE });
    await h.send('pr.checks_failed', { number: 7, url: 'https://forge/pr/7', branch: 'feat/rel-1-export-csv', failures: ['test'] });
    const worktrees = h.workspaces.prepared.filter((p) => p.kind === 'worktree');
    expect(worktrees.length).toBeGreaterThanOrEqual(2);
    expect(worktrees.map((p) => p.branch)).toEqual(worktrees.map(() => 'feat/rel-1-export-csv'));
  });

  it('keeps a branch recorded under an earlier naming: the next run asks for the same one', async () => {
    const h = createHarness();
    await delegated(h, ['Feature']);
    await h.store.putTicket({ ...(await h.ticket()), branch: 'agent/rel-1' });
    h.runner.enqueue({ output: DONE });
    await h.send('pr.checks_failed', { number: 7, url: 'https://forge/pr/7', branch: 'agent/rel-1', failures: ['test'] });
    expect(h.workspaces.prepared.filter((p) => p.kind === 'worktree').at(-1)!.branch).toBe('agent/rel-1');
  });

  it("never asks for a recorded branch that is not one of the ticket's: a detached HEAD or a branch the agent checked out", async () => {
    for (const recorded of ['HEAD', 'release/1.0']) {
      const h = createHarness();
      await delegated(h, ['Feature']);
      await h.store.putTicket({ ...(await h.ticket()), branch: recorded });
      h.runner.enqueue({ output: DONE });
      await h.send('pr.checks_failed', { number: 7, url: 'https://forge/pr/7', branch: 'feat/rel-1-export-csv', failures: ['test'] });
      const worktrees = h.workspaces.prepared.filter((p) => p.kind === 'worktree');
      expect(worktrees.length, recorded).toBeGreaterThanOrEqual(2);
      expect(worktrees.at(-1)!.branch, recorded).toBe('feat/rel-1-export-csv');
    }
  });

  it("leaves the ticket's own branch and PR out of intake's duplicates by the repository's naming, `not_started` checked or not", async () => {
    const h = createHarness({
      projectYaml: 'version: 1\ntracker:\n  pickup:\n    checks: [has_description]\non:\n  ticket.delegated:\n    - { when: "state in [todo, dev] && !blocked", run: intake }\n',
      repoConfig: async () => parseRepoConfig('branches: { pattern: "agent/{id}" }\n'),
    });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.forge.branchNames = ['main', 'agent/rel-1', 'wip/other'];
    h.forge.openPullRequests = [{ number: 4, url: 'https://github.com/acme/app/pull/4', title: 'REL-1', branch: 'agent/rel-1', fork: false, files: ['a.ts'], filesTotal: 1 }];
    h.runner.enqueue({ output: { ...DONE, tests_added: [], intake: { size: 's', risk: 'low', complete: true, missing: [], screen: false } } });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const prompt = h.runner.requests[0]!.prompt;
    expect(prompt).toContain('wip/other');
    expect(prompt).not.toContain('agent/rel-1');
    expect(prompt).not.toContain('pull/4');
  });

  it("refuses the launch on a naming the repository cannot use, as any invalid configuration", async () => {
    const h = createHarness({ repoConfig: async () => parseRepoConfig('branches: { pattern: "{type}/{slug}" }\n') });
    await delegated(h);
    expect(h.runner.requests).toEqual([]);
    expect(h.workspaces.prepared.filter((p) => p.kind === 'worktree')).toEqual([]);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: expect.stringContaining('{id} is required') });
  });
});
