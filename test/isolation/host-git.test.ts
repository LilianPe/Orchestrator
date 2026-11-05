import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKSPACE_TARGET } from '../../src/adapters/sandbox/types.js';
import { GitWorkspaces } from '../../src/adapters/workspace/git-workspaces.js';
import { runCleanVerify, type CleanVerifyResult } from '../../src/core/clean-verify.js';
import { sandboxGit } from '../../src/publish/extract.js';
import { cli, enabled, useSandboxes } from './helpers.js';

/**
 * ORC-317, with the real mounts: in its sandbox an agent does its work, commits and pushes, then leaves in everything
 * it can write what would run on the host. The factory then runs its own git commands, on the host, next to the engine
 * socket. A witness outside the sandbox says what ran. The last test is the negative control: the same writes, through
 * a mount of the repository's git dir, do run.
 */
const IMAGE = process.env['FACTORY_RUNNER_IMAGE'] ?? 'docker.io/library/node:24.22.1-bookworm';
const ORIGIN_TARGET = '/factory/test-origin.git';
const COMMON_TARGET = '/factory/test-common';
/** The public image has not the runner's `safe.directory`, and a host path of the forge means nothing in the sandbox. */
const gitEnv = (hostOrigin: string) => ({
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*',
  GIT_CONFIG_KEY_1: `url.${ORIGIN_TARGET}.insteadOf`,
  GIT_CONFIG_VALUE_1: hostOrigin,
});

/** The agent's work, as any run does it: what it needs of git in its sandbox, one line per step. */
const WORK = `#!/bin/bash
step() { name="$1"; shift; if "$@" >/dev/null 2>&1; then echo "$name:ok"; else echo "$name:failed"; fi; }
echo work > agent.txt
step add git add agent.txt
step commit git commit -q -m 'the agent works'
step log git log -1 --format=%s
step fetch git fetch -q origin
step rebase git rebase -q origin/main
step push git push -q origin HEAD
step branch git branch side
step branch-delete git branch -q -D side
step config git config factory.test yes
step gc git gc -q
step status git status --porcelain
`;

/** What it leaves for the factory's git, in the git dir its own git writes. `$TRAP` leaves a witness on the host, and fails in here. */
const PLANT = `#!/bin/bash
set -e
d="$(git rev-parse --path-format=absolute --git-common-dir)"
mkdir -p "$d/hooks" "$d/info"
for name in post-checkout reference-transaction post-merge pre-auto-gc post-index-change; do
  printf '#!/bin/sh\\n%s\\n' "$TRAP/hook-$name' #" > "$d/hooks/$name"
  chmod +x "$d/hooks/$name"
done
cfg() { git config -f "$d/config" "$1" "$2"; }
cfg core.fsmonitor "$TRAP/fsmonitor' #"
cfg filter.x.smudge "$TRAP/smudge' #"
cfg filter.x.clean "$TRAP/clean' #"
cfg core.sshCommand "$TRAP/ssh-command' #"
cfg remote.origin.uploadpack "$TRAP/uploadpack' #"
cfg credential.helper "!$TRAP/credential' #"
cfg core.pager "$TRAP/pager' #"
echo '* filter=x' > "$d/info/attributes"
echo planted:yes
`;

/** A git dir of the agent's own in the worktree, and its `.git` naming it. */
const POINT_AWAY = `#!/bin/bash
set -e
git init -q --bare own.git
git config -f own.git/config core.bare false
git config -f own.git/config core.fsmonitor "$TRAP/pointed-fsmonitor' #"
git config -f own.git/config core.sshCommand "$TRAP/pointed-ssh' #"
mkdir -p own.git/hooks
printf '#!/bin/sh\\n%s\\n' "$TRAP/pointed-hook' #" > own.git/hooks/post-checkout
chmod +x own.git/hooks/post-checkout
rm -rf .git
printf 'gitdir: %s\\n' "$PWD/own.git" > .git
echo planted:yes
`;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const posix = (p: string) => p.replaceAll('\\', '/');
const report = (output: string): Record<string, string> =>
  Object.fromEntries(output.split('\n').filter((l) => /^[a-z-]+:/.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));

describe.skipIf(!enabled)(`what an agent leaves in its git dir, under the factory's git on the host (${cli})`, () => {
  const { provider, request } = useSandboxes('host-git', { image: IMAGE });
  const base = mkdtempSync(join(tmpdir(), 'factory-host-git-'));
  const witnesses = join(base, 'witnesses');
  const repo = join(base, 'repo');
  const origin = join(base, 'origin.git');
  const trap = `touch '${posix(witnesses)}`;
  const ws = new GitWorkspaces({ root: join(base, 'ws') });
  const ask = (patch: object = {}) => ({ projectId: 'p', repoPath: repo, ticketId: 'ISO-1', title: 'hostile', kind: 'worktree' as const, slot: 0, portBase: 4200, runId: 'aaaaaaaa1111', ...patch });

  const scripted = async (id: string, script: string) => {
    // As its config spells it: the rewrite matches on that, and git rewrites a Windows path.
    const r = await provider.exec(id, ['bash', '-c', script], { env: { ...gitEnv(git(repo, 'config', 'remote.origin.url')), TRAP: trap } });
    return { ...r, out: report(r.stdout) };
  };

  let work: string;
  let start: string;
  let done: Record<string, string>;
  let plantedOut: Record<string, string>;
  let pointedOut: Record<string, string>;
  let head: string | undefined;
  let verified: CleanVerifyResult;
  let changed: string[] = [];
  const attempts: { name: string; error?: string }[] = [];
  let reused: string | undefined;

  beforeAll(async () => {
    execFileSync(cli, ['pull', '-q', IMAGE], { stdio: 'ignore', timeout: 300_000 });
    mkdirSync(witnesses);
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    git(base, 'clone', '-q', origin, repo);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    git(repo, 'remote', 'set-head', 'origin', 'main');

    const agent = await ws.prepare(ask());
    work = agent.path;
    start = (await ws.head(work))!;
    // Its worktree alone holds its git, as `Orchestrator.openSandbox` mounts it (pinned by test/scenarios/sandbox.test.ts); the forge, here a mount, instead of its network.
    const box = await provider.create(request({ workspacePath: work, network: 'none', mounts: [{ host: origin, target: ORIGIN_TARGET, readOnly: false }] }));
    done = (await scripted(box.id, WORK)).out;
    plantedOut = (await scripted(box.id, PLANT)).out;
    await provider.destroy(box.id);

    const pointed = await ws.prepare(ask({ ticketId: 'ISO-2', title: 'pointed' }));
    const boxPointed = await provider.create(request({ workspacePath: pointed.path, network: 'none' }));
    pointedOut = (await scripted(boxPointed.id, POINT_AWAY)).out;
    await provider.destroy(boxPointed.id);

    // The factory's git on the host, each command for itself: an attack may make one fail, only the witness says what ran.
    const attempt = async (name: string, command: () => Promise<unknown>) => {
      try {
        await command();
        attempts.push({ name });
      } catch (err) {
        attempts.push({ name, error: (err as Error).message });
      }
    };
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'on the forge');
    git(repo, 'push', '-q', 'origin', 'HEAD:main');

    await attempt('a next launch of the ticket', async () => {
      reused = (await ws.prepare(ask())).branch;
    });
    await attempt('its head', async () => {
      head = await ws.head(work);
    });
    await attempt('its diff', async () => {
      const diff = await ws.stepDiff(repo, work, start);
      changed = diff?.changed.map((c) => c.path) ?? [];
      await diff?.showAtHead('agent.txt');
    });
    await attempt('another ticket: its fetch, its checkout', () => ws.prepare(ask({ ticketId: 'ISO-3', title: 'next' })));
    await attempt('a pickup: ls-remote', () => ws.remoteBranchExists(repo, 'factory/iso-4-'));
    await attempt('a question: the trunk', () => ws.prepare(ask({ kind: 'trunk-readonly' })));
    await attempt('the next question: the trunk again', () => ws.prepare(ask({ kind: 'trunk-readonly', runId: 'bbbbbbbb2222' })));
    await attempt('the pointed ticket: its next launch', () => ws.prepare(ask({ ticketId: 'ISO-2', title: 'pointed' })));
    await attempt('the pointed ticket: its head', () => ws.head(pointed.path));
    const next = await provider.create(request({ workspacePath: work, network: 'none' }));
    await attempt('the hiding of .claude/ at the next launch, in its sandbox', () => ws.resetClaudeDir(work, sandboxGit(provider, next.id)));
    await provider.destroy(next.id);
    await attempt('the pointed ticket: the hiding of .claude/', () => ws.resetClaudeDir(pointed.path, async () => ({ stdout: '', stderr: '', code: 0 })));

    const workDir = join(base, 'verify');
    mkdirSync(workDir);
    verified = await runCleanVerify({
      sandboxes: provider,
      runId: `isolation-host-git-verify-${Date.now()}`,
      ticketId: 'ISO-1',
      branch: agent.branch!,
      worktree: work,
      originUrl: origin,
      workDir,
      gitleaks: false,
      setup: [],
      commands: ['test "$(cat agent.txt)" = work'],
      env: async () => ({}),
      log: () => {},
    });
  }, 420_000);

  afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 3 }));

  it('the agent still works: it commits, fetches, rebases, pushes, branches, packs, in its sandbox', () => {
    expect(done).toEqual({ add: 'ok', commit: 'ok', log: 'ok', fetch: 'ok', rebase: 'ok', push: 'ok', branch: 'ok', 'branch-delete': 'ok', config: 'ok', gc: 'ok', status: 'ok' });
  });

  it('the attack was written, where its own git writes', () => {
    expect(plantedOut['planted']).toBe('yes');
    expect(pointedOut['planted']).toBe('yes');
  });

  it("nothing it wrote ran next to the engine's socket", () => {
    expect(readdirSync(witnesses)).toEqual([]);
  });

  it('every command of the factory it could have poisoned was indeed run', () => {
    // A launch of the pointed ticket is refused: its `.git` is not the one it was given. Nothing else may fail.
    expect(attempts.filter((a) => a.error && a.name !== 'the pointed ticket: its next launch')).toEqual([]);
    expect(attempts.map((a) => a.name)).toHaveLength(11);
  });

  it('the factory reads its work, from objects it does not trust a config for', () => {
    expect(reused).toBe('factory/iso-1-hostile');
    expect(head).toBe(git(origin, 'rev-parse', 'refs/heads/factory/iso-1-hostile'));
    expect(changed).toEqual(['agent.txt']);
  });

  it('verify gets its commit out of the same git dir, untouched by what it planted', () => {
    expect(verified).toMatchObject({ ok: true, failures: [], sha: head });
  });

  it("the repository the factory reads has neither its config nor its hooks, and the hiding of .claude/ held in its sandbox", () => {
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('fsmonitor');
    expect(readdirSync(join(repo, '.git', 'hooks')).filter((f) => !f.endsWith('.sample'))).toEqual([]);
    expect(existsSync(join(work, '.claude'))).toBe(false);
  });

  it("the setup's mount holds on this engine: its .git read-only over a worktree it writes, and git still reads it", async () => {
    const { path } = await ws.prepare(ask({ ticketId: 'ISO-5', title: 'setup' }));
    const box = await provider.create(request({ workspacePath: path, mounts: [{ host: join(path, '.git'), target: `${WORKSPACE_TARGET}/.git`, readOnly: true }] }));
    const run = (script: string) => provider.exec(box.id, ['bash', '-c', script], { env: gitEnv('unused') });
    const written = await run('touch made-by-setup');
    const hook = await run('mkdir -p .git/hooks && touch .git/hooks/post-checkout');
    const config = await run('git config factory.test yes');
    const read = await run('git log -1 --format=%s');
    await provider.destroy(box.id);
    expect(written.code).toBe(0);
    expect(existsSync(join(path, 'made-by-setup'))).toBe(true);
    expect(hook.code).not.toBe(0);
    expect(config.code).not.toBe(0);
    expect(existsSync(join(path, '.git', 'hooks'))).toBe(false);
    expect(read).toMatchObject({ code: 0 });
    expect(read.stdout.trim()).toBe('on the forge');
  }, 120_000);

  // The negative control: the layout the factory had, whatever the code under test has become.
  it("the same writes through a mount of the repository's git dir do run on the host", async () => {
    const control = join(base, 'control');
    git(base, 'clone', '-q', origin, control);
    const box = await provider.create(request({ mounts: [{ host: join(control, '.git'), target: COMMON_TARGET, readOnly: false }] }));
    const written = await provider.exec(box.id, ['bash', '-c', `printf '#!/bin/sh\\n%s\\n' "$TRAP/control' #" > ${COMMON_TARGET}/hooks/post-checkout && chmod +x ${COMMON_TARGET}/hooks/post-checkout`], { env: { TRAP: trap } });
    await provider.destroy(box.id);
    expect(written).toMatchObject({ code: 0 });
    git(control, 'worktree', 'add', '-q', '--detach', join(base, 'control-wt'), 'origin/main');
    expect(readdirSync(witnesses)).toEqual(['control']);
    rmSync(join(witnesses, 'control'));
  }, 120_000);
});
