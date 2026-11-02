import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUIREMENTS, PACK_TARGET, SANDBOX_HOME, WORKSPACE_TARGET } from '../../src/adapters/sandbox/types.js';
import { createHarness, packDir } from '../helpers/harness.js';

const SETUP = 'version: 1\nworkspace:\n  setup: ["npm ci"]\n  ports: { base: 4200 }\n';

function delegate(h: ReturnType<typeof createHarness>) {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
  return h.send('ticket.delegated', { linearSessionId: 'ls-1' });
}

/** ORC-204: each attempt runs in a sandbox made for it and destroyed after it. */
describe('a disposable sandbox per attempt', () => {
  it('runs the attempt in its own sandbox, with only what it needs mounted, then destroys it', async () => {
    const h = createHarness({ sandboxed: true });
    await delegate(h);
    expect(h.sandboxes.created).toHaveLength(1);
    const [req] = h.sandboxes.created;
    const sessionDir = join(h.sessionsDir!, 'p', 'REL-1');
    expect(req).toEqual({
      runId: h.runner.requests[0]!.runId,
      ticketId: 'REL-1',
      workspacePath: '/tmp/factory-fake/p/REL-1',
      network: 'claude-api',
      requirements: DEFAULT_REQUIREMENTS,
      mounts: [
        { host: '/repo/.git', target: '/repo/.git', readOnly: false },
        { host: sessionDir, target: `${SANDBOX_HOME}/.claude`, readOnly: false },
        { host: packDir, target: PACK_TARGET, readOnly: true },
        { host: join(packDir, 'settings.json'), target: '/factory/settings.json', readOnly: true },
      ],
    });
    expect(existsSync(sessionDir)).toBe(true);
    expect(h.runner.requests[0]).toMatchObject({ sandboxId: 'sbx-1', cwd: WORKSPACE_TARGET, pluginDir: PACK_TARGET, settingsPath: '/factory/settings.json' });
    expect(h.sandboxes.destroyed).toEqual(['sbx-1']);
    expect(h.sandboxes.active()).toEqual([]);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
  });

  it('destroys the sandbox of a run that fails or is stopped', async () => {
    const h = createHarness({ sandboxed: true });
    h.runner.enqueue({ outcome: 'failure' });
    await delegate(h);
    expect(h.sandboxes.destroyed).toEqual(['sbx-1']);
    expect(h.sandboxes.active()).toEqual([]);
  });

  it('runs setup in the sandbox of a fresh worktree only', async () => {
    const h = createHarness({ sandboxed: true, projectYaml: SETUP });
    await delegate(h);
    expect(h.sandboxes.execs).toEqual([{ id: 'sbx-1', argv: ['sh', '-c', 'npm ci'] }]);
    expect(h.checks.calls.some((c) => c.commands.includes('npm ci'))).toBe(false);
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    await h.advance(600_000);
    expect(h.runner.requests).toHaveLength(2);
    expect(h.sandboxes.execs).toHaveLength(1);
  });

  it('a failed setup destroys the sandbox, removes the worktree and blocks the ticket, without a run', async () => {
    const h = createHarness({ sandboxed: true, projectYaml: SETUP });
    h.sandboxes.execResult = () => ({ stdout: '', stderr: 'boom', code: 1 });
    await delegate(h);
    expect(h.runner.requests).toEqual([]);
    expect(h.sandboxes.active()).toEqual([]);
    expect(h.workspaces.cleaned).toEqual(['REL-1']);
    expect(await h.ticket()).toMatchObject({ blocked: true });
    expect(h.tracker.activities('ls-1').at(-1)).toMatchObject({ type: 'error', body: 'Erreur au lancement : Le setup du worktree a échoué : npm ci' });
  });

  it('without a sandbox, setup runs on the host as before', async () => {
    const h = createHarness({ projectYaml: SETUP });
    await delegate(h);
    expect(h.checks.calls[0]).toEqual({ cwd: '/tmp/factory-fake/p/REL-1', commands: ['npm ci'] });
    expect(h.runner.requests[0]!.sandboxId).toBeUndefined();
  });

  it('recover destroys the sandboxes of attempts that are no longer running', async () => {
    const h = createHarness({ sandboxed: true });
    const orphan = await h.sandboxes.create({ runId: 'gone', ticketId: 'REL-9', workspacePath: '/w', network: 'claude-api', requirements: DEFAULT_REQUIREMENTS, mounts: [] });
    await h.restart({ mode: 'brutal' });
    expect(h.sandboxes.destroyed).toEqual([orphan.id]);
  });
});
