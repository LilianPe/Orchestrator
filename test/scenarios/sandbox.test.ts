import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUIREMENTS, PACK_TARGET, REFUSALS_TARGET, SANDBOX_HOME, WORKSPACE_TARGET } from '../../src/adapters/sandbox/types.js';
import { LOG_EXCERPT_MAX } from '../../src/checks/log-excerpt.js';
import type { CleanVerifyRequest } from '../../src/core/clean-verify.js';
import type { EventPayloads } from '../../src/core/types.js';
import { blockCause } from '../../src/core/block-cause.js';
import { createHarness, packDir } from '../helpers/harness.js';

const RUN_FLAGS = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
const SETUP = 'version: 1\nworkspace:\n  setup: ["npm ci"]\n  ports: { base: 4200 }\n';
const VERIFIED = 'version: 1\njobs:\n  dev: { verify: ["npm test"] }\n';

/** The repository's own setup commands, without the rc file of Yarn 1 that comes before them. */
const setups = (h: ReturnType<typeof createHarness>) => h.sandboxes.execs.filter((e) => e.argv[0] === 'timeout');

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
      network: 'limited',
      requirements: DEFAULT_REQUIREMENTS,
      // No git dir beside its worktree (ORC-317): the repository's, read by git on the host, is never mounted.
      mounts: [
        { host: sessionDir, target: `${SANDBOX_HOME}/.claude`, readOnly: false },
        { host: join(h.runsDir!, req!.runId, 'refusals'), target: REFUSALS_TARGET, readOnly: false },
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

  it("gives a question's trunk back once its sandbox is gone, and never a ticket's worktree (ORC-317)", async () => {
    const h = createHarness({ sandboxed: true });
    await delegate(h);
    expect(h.workspaces.released).toEqual([]);
    const destroy = h.sandboxes.destroy.bind(h.sandboxes);
    const releasedAtDestroy: string[][] = [];
    h.sandboxes.destroy = async (id) => {
      releasedAtDestroy.push([...h.workspaces.released]);
      return destroy(id);
    };
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Une question' });
    await h.send('session.mentioned', { linearSessionId: 'ls-9', body: 'où est calculé le score ?', author: 'L' }, 'REL-2');
    expect(h.runner.requests.at(-1)).toMatchObject({ readOnly: true });
    expect(releasedAtDestroy).toEqual([[]]);
    expect(h.workspaces.released).toEqual([`/tmp/factory-fake/p/_trunk/${h.runner.requests.at(-1)!.runId}`]);
  });

  it("gives a question's trunk back when its launch is cut short: nothing else would (ORC-317)", async () => {
    const h = createHarness({ sandboxed: true });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Une question' });
    h.sandboxes.create = async () => {
      throw new Error('engine down');
    };
    await h.send('session.mentioned', { linearSessionId: 'ls-9', body: 'où est calculé le score ?', author: 'L' }, 'REL-2');
    expect(h.runner.requests).toEqual([]);
    expect(h.workspaces.released).toEqual([`/tmp/factory-fake/p/_trunk/${h.workspaces.prepared.at(-1)!.runId}`]);
  });

  it('destroys the sandbox of a run that fails or is stopped', async () => {
    const h = createHarness({ sandboxed: true });
    h.runner.enqueue({ outcome: 'failure' });
    await delegate(h);
    expect(h.sandboxes.destroyed).toEqual(['sbx-1']);
    expect(h.sandboxes.active()).toEqual([]);
  });

  it('runs setup in a sandbox of its own, gone before the agent gets its, for a fresh worktree only (ORC-211)', async () => {
    const h = createHarness({ sandboxed: true, projectYaml: SETUP });
    const create = h.sandboxes.create.bind(h.sandboxes);
    const aliveAtCreate: string[][] = [];
    h.sandboxes.create = async (req) => {
      aliveAtCreate.push(h.sandboxes.active().map((s) => s.id));
      return create(req);
    };
    await delegate(h);
    expect(setups(h)).toMatchObject([{ id: 'sbx-1', argv: ['timeout', '900', 'bash', '-lc', 'npm ci'] }]);
    const runId = h.runner.requests[0]!.runId;
    expect(h.sandboxes.created.map((c) => c.runId)).toEqual([`${runId}-setup`, runId]);
    expect(aliveAtCreate).toEqual([[], []]);
    expect(h.runner.requests[0]).toMatchObject({ sandboxId: 'sbx-2' });
    expect(h.checks.calls.some((c) => c.commands.includes('npm ci'))).toBe(false);
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    await h.advance(600_000);
    expect(h.runner.requests).toHaveLength(2);
    expect(setups(h)).toHaveLength(1);
  });

  it('verify runs through the clean check, never in the worktree on the host (ORC-151)', async () => {
    const seen: CleanVerifyRequest[] = [];
    const h = createHarness({
      sandboxed: true,
      projectYaml: VERIFIED,
      cleanVerify: async (req) => {
        seen.push(req);
        return { ok: true, failures: [], sha: 'abc', tree: 'tree' };
      },
    });
    await delegate(h);
    expect(seen).toMatchObject([{ commands: ['npm test'], worktree: '/tmp/factory-fake/p/REL-1', runId: h.runner.requests[0]!.runId }]);
    expect(h.checks.calls).toEqual([]);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
  });

  it("a command's output reaches the journal and the agent cut to its useful parts (ORC-151)", async () => {
    const output = `${'line\n'.repeat(5000)}Error: the cause\n${'line\n'.repeat(5000)}`;
    const h = createHarness({
      sandboxed: true,
      projectYaml: VERIFIED,
      cleanVerify: async () => ({ ok: false, failures: [{ command: 'npm test', exitCode: 1, output }], sha: 'abc', tree: 'tree' }),
    });
    h.runner.enqueue({});
    await delegate(h);
    const failed = (await h.store.recentEvents(50, 'REL-1')).find((e) => e.type === 'verify.failed')!;
    const sent = (failed.payload as EventPayloads['verify.failed']).failures[0]!.output;
    expect(sent.length).toBeLessThanOrEqual(LOG_EXCERPT_MAX);
    expect(sent).toContain('Error: the cause');
    expect(h.runner.requests[1]?.prompt).toContain('Error: the cause');
  });

  it('an engine down gives an infrastructure block: no fallback on the host, nothing sent to the agent (ORC-151)', async () => {
    const h = createHarness({
      sandboxed: true,
      projectYaml: VERIFIED,
      cleanVerify: async () => {
        throw new Error('engine down');
      },
    });
    await delegate(h);
    expect(h.checks.calls).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, verifyAttempts: 0 });
    expect(blockCause(t.blockReason)).toBe('infra');
    expect(t.verifyingRunId).toBeUndefined();
    expect(h.tracker.comments('REL-1').at(-1)).toContain('engine down');
  });

  it('without sandboxes and without the explicit flag, verify refuses to run the code on the host (ORC-151)', async () => {
    const h = createHarness({ projectYaml: VERIFIED, hostChecks: false });
    await delegate(h);
    expect(h.checks.calls).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
    const t = await h.ticket();
    expect(t.blocked).toBe(true);
    expect(blockCause(t.blockReason)).toBe('infra');
    expect(h.tracker.comments('REL-1').at(-1)).toContain('FACTORY_ALLOW_HOST_VERIFY');
  });

  it('the explicit flag keeps the host path, in the worktree (ORC-151)', async () => {
    const h = createHarness({ projectYaml: VERIFIED, hostChecks: true });
    await delegate(h);
    expect(h.checks.calls).toMatchObject([{ commands: ['npm test'] }]);
  });

  it('a failed setup destroys the sandbox, removes the worktree and blocks the ticket, without a run', async () => {
    const h = createHarness({ sandboxed: true, projectYaml: SETUP });
    h.sandboxes.execResult = (argv) => ({ stdout: '', stderr: 'boom', code: argv[0] === 'timeout' ? 1 : 0 });
    await delegate(h);
    expect(h.runner.requests).toEqual([]);
    expect(h.sandboxes.active()).toEqual([]);
    expect(h.workspaces.cleaned).toEqual(['REL-1']);
    expect(await h.ticket()).toMatchObject({ blocked: true });
    expect(h.tracker.comments('REL-1').at(-1)).toContain('Raison : Erreur au lancement : Le setup du worktree a échoué : npm ci\n');
  });

  it('a setup command over the verify timeout fails the setup as a timeout', async () => {
    const h = createHarness({ sandboxed: true, projectYaml: SETUP });
    h.sandboxes.execResult = (argv) => ({ stdout: '', stderr: '', code: argv[0] === 'timeout' ? 124 : 0 });
    await delegate(h);
    expect(h.runner.requests).toEqual([]);
    expect(h.workspaces.cleaned).toEqual(['REL-1']);
    expect(h.tracker.comments('REL-1').at(-1)).toContain('Raison : Erreur au lancement : Le setup du worktree a échoué : npm ci (délai de 15 min dépassé)');
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
    expect(setups(h).map((e) => e.argv.at(-1))).toEqual(['npm ci']);
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

  describe('the repository variables and secrets (ORC-211)', () => {
    const VARS = { env: { NODE_ENV: 'test' }, setupSecrets: { REGISTRY_TOKEN: 'registry-secret' }, missing: [] };
    const repoVariables = async () => VARS;

    it('gives the setup the secrets, and the agent only the declared variables', async () => {
      const h = createHarness({ sandboxed: true, projectYaml: SETUP, repoVariables });
      await delegate(h);
      expect(setups(h)[0]!.opts!.env).toMatchObject({ NODE_ENV: 'test', REGISTRY_TOKEN: 'registry-secret', npm_config_ignore_scripts: 'true' });
      const env = h.runner.requests[0]!.env;
      expect(env).toMatchObject({ NODE_ENV: 'test' });
      expect(env).not.toHaveProperty('REGISTRY_TOKEN');
      expect(Object.values(env)).not.toContain('registry-secret');
    });

    it('a run variable of the factory wins over a variable of the repository', async () => {
      const h = createHarness({ sandboxed: true, repoVariables: async () => ({ env: { FACTORY_RUN_TOKEN: 'from-the-repo' }, setupSecrets: {}, missing: [] }) });
      await delegate(h);
      expect(h.runner.requests[0]!.env['FACTORY_RUN_TOKEN']).not.toBe('from-the-repo');
    });

    it('no secret mounted for the setup: its sandbox has the git dir alone, read-only', async () => {
      const h = createHarness({ sandboxed: true, projectYaml: SETUP, repoVariables });
      await delegate(h);
      expect(h.sandboxes.created[0]!.mounts).toEqual([{ host: join('/tmp/factory-fake/p/REL-1', '.git'), target: `${WORKSPACE_TARGET}/.git`, readOnly: true }]);
    });

    it('a setup that fails with secrets removes the worktree and starts no run', async () => {
      const h = createHarness({ sandboxed: true, projectYaml: SETUP, repoVariables });
      h.sandboxes.execResult = () => ({ stdout: '', stderr: 'boom', code: 1 });
      await delegate(h);
      expect(h.runner.requests).toEqual([]);
      expect(h.sandboxes.active()).toEqual([]);
      expect(h.workspaces.cleaned).toEqual(['REL-1']);
    });

    it('a setup whose container cannot be destroyed starts no run: a process could still write the secret', async () => {
      const h = createHarness({ sandboxed: true, projectYaml: SETUP, repoVariables });
      h.sandboxes.destroy = async () => Promise.reject(new Error('engine down'));
      await delegate(h);
      expect(h.runner.requests).toEqual([]);
      expect(await h.ticket()).toMatchObject({ blocked: true });
    });

    it.each([
      ['the secrets are still declared', VARS],
      // Sealing again could not find a value it no longer knows: only a new worktree is sure.
      ['the secrets are gone from the configuration', { env: {}, setupSecrets: {}, missing: [] }],
    ])('a worktree whose setup a crash cut is removed and made anew, when %s', async (_, after) => {
      let declared = VARS as typeof after;
      const h = createHarness({ sandboxed: true, projectYaml: SETUP, repoVariables: async () => declared });
      await delegate(h);
      expect(setups(h)).toHaveLength(1);
      expect(h.workspaces.cleaned).toEqual([]);
      // The mark a daemon killed between the setup's start and its seal leaves behind.
      declared = after;
      await h.store.setMeta('setup-pending:/tmp/factory-fake/p/REL-1', '1');
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
      await h.advance(600_000);
      expect(h.workspaces.cleaned).toEqual(['REL-1']);
      expect(setups(h)).toHaveLength(2);
      expect(await h.store.getMeta('setup-pending:/tmp/factory-fake/p/REL-1')).toBe('');
      // Sealed: the next run does not set up again.
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'encore', author: 'L' });
      await h.advance(600_000);
      expect(setups(h)).toHaveLength(2);
    });

    it('withholds the secrets from a setup on commits a previous agent wrote, and says so', async () => {
      const h = createHarness({ sandboxed: true, projectYaml: SETUP, repoVariables });
      h.workspaces.ahead.add('REL-1');
      await delegate(h);
      expect(setups(h)[0]!.opts!.env).toMatchObject({ NODE_ENV: 'test' });
      expect(setups(h)[0]!.opts!.env).not.toHaveProperty('REGISTRY_TOKEN');
      expect(h.logs.map((l) => l.message).join()).toContain('withheld');
    });

    it('marks the worktree while its setup runs, with or without a secret, and lifts the mark at its end', async () => {
      const h = createHarness({ sandboxed: true, projectYaml: SETUP });
      let during: string | undefined;
      const exec = h.sandboxes.exec.bind(h.sandboxes);
      h.sandboxes.exec = async (id, argv, opts) => {
        during ??= await h.store.getMeta('setup-pending:/tmp/factory-fake/p/REL-1');
        return exec(id, argv, opts);
      };
      await delegate(h);
      expect(during).toBe('1');
      expect(await h.store.getMeta('setup-pending:/tmp/factory-fake/p/REL-1')).toBe('');
    });

    it('a reading of the variables that fails leaves the run without them', async () => {
      const h = createHarness({ sandboxed: true, repoVariables: async () => Promise.reject(new Error('git down')) });
      await delegate(h);
      expect(h.runner.requests).toHaveLength(1);
      expect(h.runner.requests[0]!.env).not.toHaveProperty('NODE_ENV');
    });

    it('never gives the secrets to a setup on the host, without a sandbox', async () => {
      const h = createHarness({ projectYaml: SETUP, repoVariables });
      await delegate(h);
      expect(h.checks.calls[0]).toEqual({ cwd: '/tmp/factory-fake/p/REL-1', commands: ['npm ci'] });
      expect(Object.values(h.runner.requests[0]!.env)).not.toContain('registry-secret');
    });
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
  type H = ReturnType<typeof createHarness>;
  const claudeDir = `${SANDBOX_HOME}/.claude`;
  /** The host dir mounted as `~/.claude` of the i-th sandbox. */
  const claudeHost = (h: H, i: number) => h.sandboxes.created[i]!.mounts.find((m) => m.target === claudeDir)?.host;
  const ticketDir = (h: H) => join(h.sessionsDir!, 'p', 'REL-1');
  const runClaude = (h: H, i: number) => join(h.runsDir!, h.runner.requests[i]!.runId, 'claude');
  const roles = (h: H) => Promise.all(h.runner.requests.map(async (r) => (await h.store.getRun(r.runId))?.sessionRole));

  it('a reply resumes the ticket session, with the same session dir mounted in both attempts', async () => {
    const h = createHarness({ sandboxed: true });
    await delegate(h);
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    await h.advance(180_000);
    const [dev, feedback] = h.runner.requests;
    expect(feedback).toMatchObject({ resume: true, claudeSessionId: dev!.claudeSessionId });
    expect([claudeHost(h, 0), claudeHost(h, 1)]).toEqual([ticketDir(h), ticketDir(h)]);
    expect((await h.ticket()).claudeSessionId).toBe(dev!.claudeSessionId);
    expect(await roles(h)).toEqual(['implementer', 'implementer']);
  });

  it('a review starts a new session in a per-run ~/.claude, removed with its sandbox; the feedback after it resumes the ticket session', async () => {
    const h = createHarness({ sandboxed: true });
    await delegate(h);
    await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    await h.advance(180_000);
    const [dev, review, feedback] = h.runner.requests;
    expect(review!.prompt.startsWith('/factory:review\n')).toBe(true);
    expect(review).toMatchObject({ resume: false });
    expect(review!.claudeSessionId).not.toBe(dev!.claudeSessionId);
    expect(claudeHost(h, 1)).toBe(runClaude(h, 1));
    expect(existsSync(runClaude(h, 1))).toBe(false);
    expect(review!.env).toMatchObject({ CLAUDE_CONFIG_DIR: claudeDir });
    expect(feedback).toMatchObject({ resume: true, claudeSessionId: dev!.claudeSessionId });
    expect(claudeHost(h, 2)).toBe(ticketDir(h));
    expect(await roles(h)).toEqual(['implementer', 'reviewer', 'implementer']);
  });

  it('a review as the first run of a ticket neither mounts nor becomes the ticket session', async () => {
    const h = createHarness({ sandboxed: true });
    // A description too short for the pickup checks: delegated, blocked, no dev run, no session.
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'court' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('status.changed', { from: 'todo', to: 'ai_review' });
    expect(h.runner.requests.map((r) => r.prompt.split('\n')[0])).toEqual(['/factory:review']);
    expect(claudeHost(h, 0)).toBe(runClaude(h, 0));
    expect(existsSync(ticketDir(h))).toBe(false);
    expect((await h.ticket()).claudeSessionId).toBeUndefined();
    expect(await roles(h)).toEqual(['reviewer']);
  });

  it('a re-delegated dev resumes the ticket session', async () => {
    const h = createHarness({ sandboxed: true });
    await delegate(h);
    await h.send('status.changed', { from: 'human_review', to: 'todo' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const [dev, again] = h.runner.requests;
    expect(again!.prompt.startsWith('/factory:dev\n')).toBe(true);
    expect(again).toMatchObject({ resume: true, claudeSessionId: dev!.claudeSessionId });
    expect(claudeHost(h, 1)).toBe(ticketDir(h));
    expect(await roles(h)).toEqual(['implementer', 'implementer']);
  });

  it('a question starts a new session in a per-run ~/.claude', async () => {
    const h = createHarness({ sandboxed: true });
    await delegate(h);
    await h.send('session.mentioned', { linearSessionId: 'ls-9', body: 'où est calculé le score ?', author: 'L' });
    const [dev, ask] = h.runner.requests;
    expect(ask!.prompt.startsWith('/factory:ask\n')).toBe(true);
    expect(ask!.claudeSessionId).not.toBe(dev!.claudeSessionId);
    expect(claudeHost(h, 1)).toBe(runClaude(h, 1));
    expect(await roles(h)).toEqual(['implementer', 'answerer']);
  });

  it('hands a run the paths it reads whole, as the sandbox sees them (ORC-279)', async () => {
    const h = createHarness({ sandboxed: true, fullReadPaths: () => ['src/export.test.ts', 'vitest.config.ts'] });
    await delegate(h);
    expect(JSON.parse(h.runner.requests[0]!.env['FACTORY_FULL_READ_PATHS']!)).toEqual([`${WORKSPACE_TARGET}/src/export.test.ts`, `${WORKSPACE_TARGET}/vitest.config.ts`]);
  });

  it('hands a run on the host the same paths, under its worktree (ORC-279)', async () => {
    const h = createHarness({ fullReadPaths: () => ['src/export.test.ts'] });
    await delegate(h);
    const r = h.runner.requests[0]!;
    expect(JSON.parse(r.env['FACTORY_FULL_READ_PATHS']!)).toEqual([`${resolve(r.cwd)}/src/export.test.ts`]);
  });

  it('starts the run without the list when it cannot be read: a saving never blocks a ticket (ORC-279)', async () => {
    const h = createHarness({
      fullReadPaths: () => {
        throw new Error('boom');
      },
    });
    await delegate(h);
    expect(h.runner.requests[0]!.env).not.toHaveProperty('FACTORY_FULL_READ_PATHS');
    expect(await h.ticket()).toMatchObject({ blocked: false });
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('boom'))).toBe(true);
  });

  it('starts the run without the list when it is too long for the environment (ORC-279)', async () => {
    const h = createHarness({ fullReadPaths: () => Array.from({ length: 5000 }, (_, i) => `packages/some-package-${i}/src/some-feature.test.ts`) });
    await delegate(h);
    expect(h.runner.requests[0]!.env).not.toHaveProperty('FACTORY_FULL_READ_PATHS');
    expect(await h.ticket()).toMatchObject({ blocked: false });
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('too long'))).toBe(true);
  });

  it('hands no list when the factory has no path to read whole (ORC-279)', async () => {
    for (const h of [createHarness({ sandboxed: true }), createHarness({ sandboxed: true, fullReadPaths: () => [] })]) {
      await delegate(h);
      expect(h.runner.requests[0]!.env).not.toHaveProperty('FACTORY_FULL_READ_PATHS');
    }
  });

  it("every sandboxed run's refusals log is on the host, and outlives its sandbox", async () => {
    const h = createHarness({ sandboxed: true });
    await delegate(h);
    await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
    for (const [i, r] of h.runner.requests.entries()) {
      expect(r.env).toMatchObject({ FACTORY_REFUSALS_LOG: `${REFUSALS_TARGET}/refusals.jsonl` });
      const refusals = h.sandboxes.created[i]!.mounts.find((m) => m.target === REFUSALS_TARGET)!;
      expect(refusals).toEqual({ host: join(h.runsDir!, r.runId, 'refusals'), target: REFUSALS_TARGET, readOnly: false });
      writeFileSync(join(refusals.host, 'refusals.jsonl'), '{}\n');
    }
    expect(h.sandboxes.active()).toEqual([]);
    for (const r of h.runner.requests) expect(existsSync(join(h.runsDir!, r.runId, 'refusals', 'refusals.jsonl'))).toBe(true);
  });
});

/** ORC-296: a run's two security journals go into the base when its sandbox is destroyed, a summary of its refusals to the ticket's session. */
describe("a run's security log", () => {
  /** A held dev run of REL-1 whose journals hold `egress` and `refusals` lines when it ends. */
  async function runWith(egress: string[], refusals: string[]) {
    const h = createHarness({ sandboxed: true });
    h.runner.enqueue({ hold: true });
    await delegate(h);
    const runId = (await h.ticket()).activeRunId!;
    writeFileSync(join(h.runsDir!, runId, 'egress.jsonl'), egress.map((l) => `${l}\n`).join(''));
    writeFileSync(join(h.runsDir!, runId, 'refusals', 'refusals.jsonl'), refusals.map((l) => `${l}\n`).join(''));
    h.runner.release(runId);
    await h.advance(0);
    return { h, runId };
  }
  const at = '2026-11-03T10:00:00.000Z';
  const request = (host: string, ok: boolean) => JSON.stringify({ at, method: 'GET', host, path: '/', ok, ...(ok ? {} : { reason: 'host not allowed' }), up: 0, down: 0 });
  const refusal = (rule: string, ticket = 'REL-1') => JSON.stringify({ at, tool: 'Bash', command: 'git push origin main # TOKEN=s3cr3t', rule, ticket });
  const summaries = (h: ReturnType<typeof createHarness>) => h.tracker.activities('ls-1').flatMap((a) => ('body' in a && a.body.startsWith('Refus pendant ce run') ? [{ type: a.type, body: a.body }] : []));

  it('stores the connections and refusals of the run, tied to it and its ticket, and posts a summary without the commands', async () => {
    const { h, runId } = await runWith([request('registry.npmjs.org', true), request('evil.example', false)], [refusal('push-trunk'), refusal('push-trunk')]);
    const log = await h.store.securityLog(runId);
    expect(log).toMatchObject({ runId, projectId: 'p', ticketId: 'REL-1', skipped: { egress: 0, refusals: 0 } });
    expect(log!.egress.map((e) => [e.host, e.ok])).toEqual([['registry.npmjs.org', true], ['evil.example', false]]);
    expect(log!.refusals.map((r) => r.rule)).toEqual(['push-trunk', 'push-trunk']);
    const [summary] = summaries(h);
    expect(summary).toMatchObject({ type: 'thought' });
    expect(summary!.body).toContain('`push-trunk` : 2');
    expect(summary!.body).toContain('`evil.example` (1)');
    expect(JSON.stringify(h.tracker.activities('ls-1'))).not.toContain('s3cr3t');
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
  });

  it('stores a whole read the hook refused and counts its rule, never naming the path in the session (ORC-279)', async () => {
    const line = JSON.stringify({ at, tool: 'Read', command: '/work/src/secret-name.ts', rule: 'full-read', ticket: 'REL-1' });
    const { h, runId } = await runWith([], [line]);
    expect(await h.store.securityLog(runId)).toMatchObject({ refusals: [{ tool: 'Read', rule: 'full-read', command: '/work/src/secret-name.ts' }], skipped: { refusals: 0 } });
    expect(summaries(h)[0]!.body).toContain('`full-read` : 1');
    expect(JSON.stringify(h.tracker.activities('ls-1'))).not.toContain('secret-name');
  });

  it('skips and counts the forged lines, posts nothing for a run without a refusal, and the run ends as it would', async () => {
    const { h, runId } = await runWith([request('registry.npmjs.org', true)], ['{"rule":"push"}', 'garbage', refusal('push', 'REL-9')]);
    expect(await h.store.securityLog(runId)).toMatchObject({ refusals: [], skipped: { refusals: 3 } });
    expect(summaries(h)).toEqual([]);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
  });
});
