import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { worktreeReader } from '../../src/adapters/runner/claude-code.js';
import type { SandboxProvider } from '../../src/adapters/sandbox/types.js';
import { WORKSPACE_TARGET } from '../../src/adapters/sandbox/types.js';
import { GitWorkspaces } from '../../src/adapters/workspace/git-workspaces.js';
import { cli, enabled, podman, useSandboxes } from './helpers.js';

/**
 * What the loop detector reads (ORC-136), as a run reads it: the runner's own reader, the real provider, the worktree
 * `prepare` makes (ORC-317), the agent's user. A read that fails switches the detector off, so every read here says why.
 */
const IMAGE = process.env['FACTORY_RUNNER_IMAGE'] ?? 'docker.io/library/node:24.22.1-bookworm';
const TREE = /^[0-9a-f]{40,64}$/;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Every entry of a directory: its path, its date and, for a file, its size and content. */
function snapshot(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).sort().map((name) => {
    const path = join(dir, name);
    const at = lstatSync(path);
    return `${name} ${at.mtimeMs} ${at.isFile() ? `${at.size} ${createHash('sha256').update(readFileSync(path)).digest('hex')}` : 'dir'}`;
  });
}

describe.skipIf(!enabled)(`the tree of a worktree, in the agent's sandbox (${cli})`, () => {
  const { provider, request } = useSandboxes('worktree-tree', { image: IMAGE });
  const base = mkdtempSync(join(tmpdir(), 'factory-tree-'));
  const repo = join(base, 'repo');
  const warnings: string[] = [];

  /**
   * Podman maps the daemon's uid to the mount's owner: nothing is added, and that is the proof. Docker Desktop shows the
   * mount as someone else's: the runner's image trusts it in its system config, this public one has none.
   */
  const trusting: Pick<SandboxProvider, 'exec'> = podman
    ? provider
    : { exec: (id, argv, opts) => provider.exec(id, argv, { ...opts, env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' } }) };

  let work: string;
  let box: string;
  let read: () => Promise<string | undefined>;
  let trunk: string;
  let first: string | undefined;
  let second: string | undefined;

  /** The agent's own hand: its user, no git. */
  const agent = async (script: string) => {
    const done = await provider.exec(box, ['sh', '-c', script]);
    expect(done.code, done.stderr).toBe(0);
  };
  /** A read that must succeed: if not, the warning is the reason. */
  const tree = async () => {
    const seen = await read();
    expect(warnings).toEqual([]);
    expect(seen).toMatch(TREE);
    return seen!;
  };

  beforeAll(async () => {
    execFileSync(cli, ['pull', '-q', IMAGE], { stdio: 'ignore', timeout: 300_000 });
    const origin = join(base, 'origin.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    git(base, 'clone', '-q', origin, repo);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    // The agent's repository inherits it: a checkout on Windows, in CRLF, would read as modified from the sandbox.
    git(repo, 'config', 'core.autocrlf', 'false');
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n');
    writeFileSync(join(repo, '.claude', 'CLAUDE.md'), 'conventions\n');
    writeFileSync(join(repo, 'same-size.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    git(repo, 'remote', 'set-head', 'origin', 'main');
    trunk = git(repo, 'rev-parse', 'origin/main^{tree}');

    const ws = new GitWorkspaces({ root: join(base, 'ws') });
    ({ path: work } = await ws.prepare({ projectId: 'p', repoPath: repo, ticketId: 'ISO-1', title: 'tree', kind: 'worktree', slot: 0, portBase: 4200, runId: 'aaaaaaaa1111' }));
    ({ id: box } = await provider.create(request({ workspacePath: work, network: 'none' })));
    read = worktreeReader(trusting, { runId: 'iso-tree', sandboxId: box, cwd: WORKSPACE_TARGET }, (m) => warnings.push(m));
    first = await read();
    second = await read();
  }, 420_000);

  afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 3 }));

  it("the layout is prepare's: its own .git in its worktree, sparse, .claude/ hidden but for CLAUDE.md, the agent's user", async () => {
    expect(lstatSync(join(work, '.git')).isDirectory()).toBe(true);
    expect(existsSync(join(work, '.git', 'info', 'sparse-checkout'))).toBe(true);
    expect(readdirSync(join(work, '.claude'))).toEqual(['CLAUDE.md']);
    const id = await provider.exec(box, ['id', '-u']);
    expect(id.stdout.trim()).toBe(String(process.getuid?.() ?? 1000));
  }, 60_000);

  it("gives the commit's tree on a clean worktree: what the sparse checkout hides is no deletion", () => {
    expect(warnings).toEqual([]);
    expect(first).toBe(trunk);
  });

  it('gives the same tree on two reads with no change between them', () => {
    expect(warnings).toEqual([]);
    expect(first).toMatch(TREE);
    expect(second).toBe(first);
  });

  it('changes with an edit of the same size, and of the same date where the mount is the agent\'s', async () => {
    const before = await tree();
    // Only a file's owner sets its date: Docker Desktop's mount is root's, whatever the user.
    await agent(`touch -r same-size.txt /tmp/when && printf 'BASE\\n' > same-size.txt${podman ? ' && touch -r /tmp/when same-size.txt' : ''}`);
    expect(await tree()).not.toBe(before);
  }, 60_000);

  it('changes with an untracked file, and with its content', async () => {
    const before = await tree();
    await agent(`printf 'one\\n' > untracked.txt`);
    const made = await tree();
    expect(made).not.toBe(before);
    await agent(`printf 'two\\n' > untracked.txt`);
    expect(await tree()).not.toBe(made);
  }, 60_000);

  it('still reads, and changes, with a file where the sparse checkout leaves it out: a setup or an agent writes in .claude/', async () => {
    const before = await tree();
    await agent(`printf 'one\\n' > .claude/settings.local.json`);
    const made = await tree();
    expect(made).not.toBe(before);
    await agent(`printf 'two\\n' > .claude/settings.local.json`);
    expect(await tree()).not.toBe(made);
  }, 60_000);

  it('leaves .git as it is, with work waiting to be read', async () => {
    await agent(`printf 'pending\\n' > pending.txt && printf 'BASE\\n' > same-size.txt`);
    const before = snapshot(join(work, '.git'));
    await tree();
    expect(snapshot(join(work, '.git'))).toEqual(before);
  }, 60_000);

  it('says why when it cannot read: the code and the first line of stderr', async () => {
    const said: string[] = [];
    const outside = worktreeReader(trusting, { runId: 'iso-outside', sandboxId: box, cwd: '/tmp' }, (m) => said.push(m));
    expect(await outside()).toBeUndefined();
    expect(await outside()).toBeUndefined();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('iso-outside');
    expect(said[0]).toContain('code 128');
    expect(said[0]).toContain('not a git repository');
  }, 60_000);
});
