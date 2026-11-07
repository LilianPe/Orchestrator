import { describe, expect, it } from 'vitest';
import { parseRepoConfig, type RepoConfig } from '../../src/config/repo-config.js';
import type { RepoVariables } from '../../src/config/repo-variables.js';
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
    expect(h.tracker.activities('ls-1').at(-1)).toMatchObject({ type: 'error', body: expect.stringMatching(/^Erreur au lancement : \.factory\/config\.yml refusé :[\s\S]*network\.level/) });
  });

  it("criterion 5: the agent's change of .factory/config.yml is refused as a forbidden path, and the base's config applies to the next run", async () => {
    // The verdict of `factory/chemins-interdits` is the clean check's (`.factory/**` in the socle, clean-verify.test.ts); here, what the launch does next.
    const verdicts = [
      { ok: false, failures: [{ command: 'factory/chemins-interdits', exitCode: 1, output: 'Chemin interdit modifié : .factory/config.yml' }], sha: 'abc', tree: 't' },
      { ok: true, failures: [], sha: 'def', tree: 't2' },
    ];
    const base = onDefaultBranch(BASE);
    const h = createHarness({ sandboxed: true, projectYaml: VERIFIED, cleanVerify: async () => verdicts.shift()!, ...base });
    h.runner.enqueue({});
    await delegate(h);
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]!.prompt).toContain('.factory/config.yml');
    // Each launch read the default branch's file again, whatever the agent committed on its branch: the second, on
    // a worktree that already exists, fetches the forge first.
    expect(base.reads).toEqual([{ fetch: false }, { fetch: true }]);
    expect(agents(h).map((c) => [c.network, c.allow])).toEqual([
      ['limited', ['docs.exemple.com']],
      ['limited', ['docs.exemple.com']],
    ]);
  });
});
