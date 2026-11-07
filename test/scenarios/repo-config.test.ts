import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRepoConfig } from '../../src/app/repo-variables.js';
import { parseRepoConfig, type RepoConfig } from '../../src/config/repo-config.js';
import type { RepoVariables } from '../../src/config/repo-variables.js';
import { blockCause } from '../../src/core/block-cause.js';
import { createHarness } from '../helpers/harness.js';

const VERIFIED = 'version: 1\njobs:\n  dev: { verify: ["npm test"] }\n';
const SETUP = 'version: 1\nworkspace:\n  setup: ["npm ci"]\n  ports: { base: 4200 }\n';
const BASE = 'setup: pnpm install\nnetwork: { level: custom, allow: [docs.exemple.com] }\nenv: [NODE_ENV]\n';

/** The repository's own setup commands, without the rc file of Yarn 1 that comes before them. */
const setups = (h: ReturnType<typeof createHarness>) => h.sandboxes.execs.filter((e) => e.argv[0] === 'timeout');
/** The agents' sandboxes, not the setup's. */
const agents = (h: ReturnType<typeof createHarness>) => h.sandboxes.created.filter((c) => !c.runId.endsWith('-setup'));

function delegate(h: ReturnType<typeof createHarness>) {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
  return h.send('ticket.delegated', { linearSessionId: 'ls-1' });
}

/** The default branch's file, read at each launch; `reads` says whether each read fetched the forge first. */
function onDefaultBranch(yaml: string) {
  const reads: { fetch: boolean }[] = [];
  return { reads, repoConfig: async (_: unknown, o?: { fetch?: boolean }) => (reads.push({ fetch: o?.fetch ?? true }), parseRepoConfig(yaml)) };
}

/** ORC-209 C: `.factory/config.yml` read once at each launch, on the default branch; the run takes it whole. */
describe("the repository's config at the launch", () => {
  it("opens the agent's sandbox at the repository's level, with its hosts for custom", async () => {
    const h = createHarness({ sandboxed: true, ...onDefaultBranch(BASE) });
    await delegate(h);
    expect(agents(h)).toMatchObject([{ network: 'limited', allow: ['docs.exemple.com'] }]);
  });

  it('keeps the Claude API for a repository at none: its agent runs at claude-api', async () => {
    const h = createHarness({ sandboxed: true, ...onDefaultBranch('network: { level: none }\n') });
    await delegate(h);
    expect(agents(h)).toMatchObject([{ network: 'claude-api' }]);
    expect(agents(h)[0]).not.toHaveProperty('allow');
  });

  it("runs the file's setup, not the workflow's", async () => {
    const h = createHarness({ sandboxed: true, projectYaml: SETUP, ...onDefaultBranch(BASE) });
    await delegate(h);
    expect(setups(h).map((e) => e.argv.at(-1))).toEqual(['pnpm install']);
  });

  it('runs the setup of a file on a workflow that declares none', async () => {
    const h = createHarness({ sandboxed: true, ...onDefaultBranch(BASE) });
    await delegate(h);
    expect(setups(h).map((e) => e.argv.at(-1))).toEqual(['pnpm install']);
  });

  it('gives the repository variables the config it read, without reading it again', async () => {
    const given: RepoConfig[] = [];
    const repoVariables = async (_: unknown, config: RepoConfig): Promise<RepoVariables> => (given.push(config), { env: { NODE_ENV: 'test' }, setupSecrets: {}, missing: [] });
    const base = onDefaultBranch(BASE);
    const h = createHarness({ sandboxed: true, repoVariables, ...base });
    await delegate(h);
    // A fresh worktree: `prepare` has just fetched the forge.
    expect(base.reads).toEqual([{ fetch: false }]);
    expect(given).toEqual([parseRepoConfig(BASE)]);
    expect(h.runner.requests[0]!.env).toMatchObject({ NODE_ENV: 'test' });
  });

  it.each([false, true])('checks a run with the config its launch read, kept on the run: a merge on the default branch meanwhile changes nothing (sandboxed: %s)', async (sandboxed) => {
    const before = 'env: [NODE_ENV]\n';
    const merged = 'env: [API_URL]\n';
    let reads = 0;
    const repoConfig = async () => parseRepoConfig(reads++ === 0 ? before : merged);
    const given: string[][] = [];
    const repoVariables = async (_: unknown, config: RepoConfig): Promise<RepoVariables> => (given.push(config.env), { env: {}, setupSecrets: {}, missing: [] });
    const h = createHarness({ sandboxed, repoConfig, repoVariables, projectYaml: 'version: 1\non:\n  ticket.delegated:\n    - { when: "state in [todo, dev] && !blocked", run: tests }\njobs:\n  tests:\n    red: { mode: measure }\n' });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.workspaces.heads.set('/tmp/factory-fake/p/REL-1', 'base-sha');
    h.workspaces.steps.set('/tmp/factory-fake/p/REL-1', { changed: [{ path: 'src/export.test.ts', deleted: false }] });
    h.checks.failNext('AssertionError: expected 1 to be 2');
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    // The tests step's launch, then its red check on the host: the same config. The dev step's launch reads the merge.
    expect(given.slice(0, 3)).toEqual([['NODE_ENV'], ['NODE_ENV'], ['API_URL']]);
    expect(reads).toBe(2);
    expect((await h.store.getRun(h.runner.requests[0]!.runId))?.repoConfig).toEqual(parseRepoConfig(before));
  });

  it("reads a question's config without a fetch of its own: its trunk was just fetched", async () => {
    const base = onDefaultBranch(BASE);
    const h = createHarness({ sandboxed: true, ...base });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('session.mentioned', { linearSessionId: 'as-q1', body: 'question', author: 'Lilian' });
    expect(h.workspaces.prepared.map((p) => p.kind)).toEqual(['trunk-readonly']);
    expect(base.reads).toEqual([{ fetch: false }]);
  });

  it('refuses the launch on an invalid file, naming the fault: no sandbox, no run, no worktree left', async () => {
    const h = createHarness({
      sandboxed: true,
      repoConfig: async () => parseRepoConfig('network: { level: full }\n'),
    });
    await delegate(h);
    expect(h.sandboxes.created).toEqual([]);
    expect(h.runner.requests).toEqual([]);
    expect(h.workspaces.cleaned).toEqual(['REL-1']);
    expect(await h.ticket()).toMatchObject({ blocked: true });
    expect(h.tracker.activities('ls-1').at(-1)).toMatchObject({ type: 'error', body: expect.stringMatching(/^Configuration du dépôt à corriger : \.factory\/config\.yml refusé :[\s\S]*network\.level/) });
    // The Flux shows it as the repository's to fix, not as a breakdown of the factory.
    expect(blockCause((await h.ticket()).blockReason)).toBe('repo_config');
  });

  it('keeps a config the forge could not give as a breakdown, not as a fault of the repository', async () => {
    const h = createHarness({ sandboxed: true, repoConfig: async () => Promise.reject(new Error('la forge ne répond plus après 120 s')) });
    await delegate(h);
    expect(blockCause((await h.ticket()).blockReason)).toBe('infra');
  });

  it("criterion 5: the agent's change of .factory/config.yml is refused as a forbidden path, and the base's config applies to the next run", async () => {
    // The verdict of `factory/chemins-interdits` is the clean check's (`.factory/**` in the socle, clean-verify.test.ts); here, what the launch does next.
    const verdicts = [
      { ok: false, failures: [{ command: 'factory/chemins-interdits', exitCode: 1, output: 'Chemin interdit modifié : .factory/config.yml' }], sha: 'abc', tree: 't' },
      { ok: true, failures: [], sha: 'def', tree: 't2' },
    ];
    // The read itself is the daemon's, on a real repository: its default branch holds BASE, and the branch checked
    // out in it carries the agent's change, committed and in the worktree too.
    const root = mkdtempSync(join(tmpdir(), 'factory-criterion-5-'));
    try {
      const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      const forge = join(root, 'forge');
      const repo = join(root, 'repo');
      execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', forge]);
      execFileSync('git', ['clone', '--quiet', forge, repo]);
      mkdirSync(join(repo, '.factory'));
      writeFileSync(join(repo, '.factory', 'config.yml'), BASE);
      git(repo, 'add', '.');
      git(repo, 'commit', '--quiet', '-m', 'base');
      git(repo, 'push', '--quiet', 'origin', 'main');
      git(repo, 'remote', 'set-head', 'origin', 'main');
      git(repo, 'checkout', '--quiet', '-b', 'factory/rel-1');
      writeFileSync(join(repo, '.factory', 'config.yml'), 'network: { level: custom, allow: [evil.exemple.com] }\n');
      git(repo, 'commit', '--quiet', '-am', 'widen');
      const read = makeRepoConfig();
      const reads: { fetch: boolean }[] = [];
      const repoConfig = (_: unknown, o?: { fetch?: boolean }) => (reads.push({ fetch: o?.fetch ?? true }), read({ repoPath: repo }, o));
      const h = createHarness({ sandboxed: true, projectYaml: VERIFIED, cleanVerify: async () => verdicts.shift()!, repoConfig });
      h.runner.enqueue({});
      await delegate(h);
      expect(h.runner.requests).toHaveLength(2);
      expect(h.runner.requests[1]!.prompt).toContain('.factory/config.yml');
      // Each launch read the default branch's file again, never the agent's: the second, on a worktree that already
      // exists, fetches the forge first.
      expect(reads).toEqual([{ fetch: false }, { fetch: true }]);
      expect(agents(h).map((c) => [c.network, c.allow])).toEqual([
        ['limited', ['docs.exemple.com']],
        ['limited', ['docs.exemple.com']],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
