import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUIREMENTS, PACK_TARGET, SANDBOX_HOME, WORKSPACE_TARGET } from '../../src/adapters/sandbox/types.js';
import { createHarness, packDir } from '../helpers/harness.js';

const RUN_FLAGS = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
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
    // ORC-284: the ticket's session dir as Claude's whole config dir, no auto-memory, no telemetry; the repo's .claude/ hidden.
    expect(h.runner.requests[0]!.env).toMatchObject({ CLAUDE_CONFIG_DIR: `${SANDBOX_HOME}/.claude`, ...RUN_FLAGS });
    expect(h.workspaces.resetClaude).toEqual(['/tmp/factory-fake/p/REL-1']);
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
    expect(h.sandboxes.execs).toEqual([{ id: 'sbx-1', argv: ['timeout', '900', 'bash', '-lc', 'npm ci'] }]);
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

  it('a setup command over the verify timeout fails the setup as a timeout', async () => {
    const h = createHarness({ sandboxed: true, projectYaml: SETUP });
    h.sandboxes.execResult = () => ({ stdout: '', stderr: '', code: 124 });
    await delegate(h);
    expect(h.runner.requests).toEqual([]);
    expect(h.workspaces.cleaned).toEqual(['REL-1']);
    expect(h.tracker.activities('ls-1').at(-1)).toMatchObject({
      type: 'error',
      body: 'Erreur au lancement : Le setup du worktree a échoué : npm ci (délai de 15 min dépassé)',
    });
  });

  it.each([
    ['the sandbox cannot be opened', (h: ReturnType<typeof createHarness>) => {
      h.sandboxes.create = async () => Promise.reject(new Error('engine down'));
    }],
    ['setup cannot be run in it', (h: ReturnType<typeof createHarness>) => {
      h.sandboxes.exec = async () => Promise.reject(new Error('exec refused'));
    }],
  ])('when %s, a fresh worktree is removed so the next attempt runs setup again', async (_, fault) => {
    const h = createHarness({ sandboxed: true, projectYaml: SETUP });
    const { create, exec } = h.sandboxes;
    fault(h);
    await delegate(h);
    expect(h.runner.requests).toEqual([]);
    expect(h.sandboxes.active()).toEqual([]);
    expect(h.workspaces.cleaned).toEqual(['REL-1']);
    expect(await h.ticket()).toMatchObject({ blocked: true });
    Object.assign(h.sandboxes, { create, exec });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    await h.advance(600_000);
    expect(h.runner.requests).toHaveLength(1);
    expect(h.sandboxes.execs.map((e) => e.argv.at(-1))).toEqual(['npm ci']);
  });

  it('opens no sandbox for a launch that ends before its run, and removes the fresh worktree it did not set up', async () => {
    const h = createHarness({ sandboxed: true, projectYaml: SETUP });
    const moveTo = h.tracker.moveTo.bind(h.tracker);
    h.tracker.moveTo = async () => Promise.reject(new Error('linear down'));
    await delegate(h);
    expect(h.sandboxes.created).toEqual([]);
    expect(h.workspaces.cleaned).toEqual(['REL-1']);
    expect(await h.ticket()).toMatchObject({ blocked: true });
    h.tracker.moveTo = moveTo;
  });

  it('logs a sandbox opened with a network, provisional until ORC-213', async () => {
    const h = createHarness({ sandboxed: true });
    await delegate(h);
    expect(h.logs).toContainEqual({ level: 'warn', message: expect.stringContaining('ORC-213') as string });
  });

  it('without a sandbox, setup runs on the host as before', async () => {
    const h = createHarness({ projectYaml: SETUP });
    await delegate(h);
    expect(h.checks.calls[0]).toEqual({ cwd: '/tmp/factory-fake/p/REL-1', commands: ['npm ci'] });
    expect(h.runner.requests[0]!.sandboxId).toBeUndefined();
    // The daemon's own Claude config dir (and its login) on the host: there is no ticket session dir there.
    expect(h.runner.requests[0]!.env).toMatchObject(RUN_FLAGS);
    expect(h.runner.requests[0]!.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(h.workspaces.resetClaude).toEqual(['/tmp/factory-fake/p/REL-1']);
  });

  it('recover destroys the sandboxes of attempts that are no longer running', async () => {
    const h = createHarness({ sandboxed: true });
    const orphan = await h.sandboxes.create({ runId: 'gone', ticketId: 'REL-9', workspacePath: '/w', network: 'claude-api', requirements: DEFAULT_REQUIREMENTS, mounts: [] });
    await h.restart({ mode: 'brutal' });
    expect(h.sandboxes.destroyed).toEqual([orphan.id]);
  });
});

/** ORC-217: the ticket's Claude session lives in its session dir; a review or a question starts afresh. */
describe('the ticket session across attempts', () => {
  const claudeDir = `${SANDBOX_HOME}/.claude`;
  const mountsSessionDir = (h: ReturnType<typeof createHarness>, i: number) =>
    h.sandboxes.created[i]!.mounts.some((m) => m.host === join(h.sessionsDir!, 'p', 'REL-1') && m.target === claudeDir);
  const roles = (h: ReturnType<typeof createHarness>) => Promise.all(h.runner.requests.map(async (r) => (await h.store.getRun(r.runId))?.sessionRole));

  it('a reply resumes the ticket session, with the same session dir mounted in both attempts', async () => {
    const h = createHarness({ sandboxed: true });
    await delegate(h);
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    await h.advance(180_000);
    const [dev, feedback] = h.runner.requests;
    expect(feedback).toMatchObject({ resume: true, claudeSessionId: dev!.claudeSessionId });
    expect([mountsSessionDir(h, 0), mountsSessionDir(h, 1)]).toEqual([true, true]);
    expect((await h.ticket()).claudeSessionId).toBe(dev!.claudeSessionId);
    expect(await roles(h)).toEqual(['implementer', 'implementer']);
  });

  it('a review starts a new session without the ticket session dir; the feedback after it resumes the ticket session', async () => {
    const h = createHarness({ sandboxed: true });
    await delegate(h);
    await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    await h.advance(180_000);
    const [dev, review, feedback] = h.runner.requests;
    expect(review!.prompt.startsWith('/factory:review\n')).toBe(true);
    expect(review).toMatchObject({ resume: false });
    expect(review!.claudeSessionId).not.toBe(dev!.claudeSessionId);
    // Its config dir is the sandbox's own `~/.claude`, gone with the sandbox: a fresh context.
    expect(mountsSessionDir(h, 1)).toBe(false);
    expect(review!.env).toMatchObject({ CLAUDE_CONFIG_DIR: claudeDir });
    expect(feedback).toMatchObject({ resume: true, claudeSessionId: dev!.claudeSessionId });
    expect(mountsSessionDir(h, 2)).toBe(true);
    expect(await roles(h)).toEqual(['implementer', 'reviewer', 'implementer']);
  });

  it('a question starts a new session without the ticket session dir', async () => {
    const h = createHarness({ sandboxed: true });
    await delegate(h);
    await h.send('session.mentioned', { linearSessionId: 'ls-9', body: 'où est calculé le score ?', author: 'L' });
    const [dev, ask] = h.runner.requests;
    expect(ask!.prompt.startsWith('/factory:ask\n')).toBe(true);
    expect(ask!.claudeSessionId).not.toBe(dev!.claudeSessionId);
    expect(mountsSessionDir(h, 1)).toBe(false);
    expect(await roles(h)).toEqual(['implementer', 'answerer']);
  });
});
