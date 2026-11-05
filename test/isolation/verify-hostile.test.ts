import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCleanVerify, type CleanVerifyResult } from '../../src/core/clean-verify.js';
import { cli, enabled, useSandboxes } from './helpers.js';

/**
 * ORC-151: a `verify` command is hostile agent code. It tries the engine socket, the daemon's env, the agent's
 * worktree and the network; each attempt prints what it got, next to a witness that the same probe works
 * (a socket it made itself is found, a variable of the repository is read, a file of its own is written, its
 * own loopback answers). A probe that never ran fails the test, as one that succeeded does.
 */
const IMAGE = process.env['FACTORY_RUNNER_IMAGE'] ?? 'docker.io/library/node:24.22.1-bookworm';
const CANARY = 'factory-canary-of-the-daemon';
const BRANCH = 'factory/iso-1';

const ATTACK = `#!/bin/bash
echo "ran:yes"
echo "setup-witness:$(cat .setup-ran 2>/dev/null || echo missing)"

# The engine: every socket of the container, this one's own as the witness.
node -e "require('net').createServer().listen('/tmp/witness.sock', () => setTimeout(() => process.exit(0), 3000))" &
sleep 1
echo "sockets:$(find / \\( -path /proc -o -path /sys \\) -prune -o -type s -print 2>/dev/null | sort | tr '\\n' ' ')"
echo "mounts-engine:$(grep -cE 'docker\\.sock|podman\\.sock' /proc/mounts)"
wait

# The daemon's env: this process's, and PID 1's.
echo "env-witness:$REPO_VISIBLE"
echo "env-canary:$(env | grep -c '${CANARY}')"
echo "pid1-canary:$(tr '\\0' '\\n' < /proc/1/environ 2>/dev/null | grep -c '${CANARY}')"

# The agent's worktree, under its host path, and what git would point at.
echo own > own-file && echo "write-witness:$(cat own-file)"
(echo pwned > "$AGENT_WORKTREE/pwned") 2>/dev/null && echo "worktree-write:yes" || echo "worktree-write:no"
echo "worktree-seen:$(test -e "$AGENT_WORKTREE" && echo yes || echo no)"
echo "gitdir:$(git -c safe.directory=* rev-parse --git-common-dir 2>/dev/null)"

# The network: its loopback as the witness, then an address and a name.
node -e "
const net = require('net');
const server = net.createServer((c) => c.end()).listen(4999, '127.0.0.1', () => {
  net.connect(4999, '127.0.0.1').on('connect', () => { console.log('loopback-witness:yes'); server.close(); }).on('error', () => { console.log('loopback-witness:no'); server.close(); });
});
"
echo "interfaces:$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ' ')"
(timeout 5 bash -c 'echo > /dev/tcp/1.1.1.1/443') 2>/dev/null && echo "tcp-out:yes" || echo "tcp-out:no"
(timeout 5 getent hosts example.com >/dev/null) 2>/dev/null && echo "dns:yes" || echo "dns:no"
echo "done:yes"
# A failing verdict: the factory hands back the output of a failure only.
exit 7
`;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Each `key:value` line of the attack's output. */
const report = (output: string): Record<string, string> =>
  Object.fromEntries(output.split('\n').filter((l) => /^[a-z0-9-]+:/.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));

describe.skipIf(!enabled)(`a hostile verify command (${cli})`, () => {
  const { provider } = useSandboxes('verify-hostile', { image: IMAGE });
  const base = mkdtempSync(join(tmpdir(), 'factory-verify-'));
  // Set in this process, as a daemon's secret would be: the engine CLI sees it, the container must not.
  const previous = process.env['FACTORY_DAEMON_SECRET'];
  let worktree: string;
  let result: CleanVerifyResult;
  let out: Record<string, string>;

  beforeAll(async () => {
    process.env['FACTORY_DAEMON_SECRET'] = CANARY;
    execFileSync(cli, ['pull', '-q', IMAGE], { stdio: 'ignore', timeout: 300_000 });

    const repo = join(base, 'repo');
    git(base, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    // A repository with its git dir inside, as the agent's workspace is (ORC-317).
    worktree = repo;
    git(repo, 'checkout', '-q', '-b', BRANCH);
    writeFileSync(join(worktree, 'attack.sh'), ATTACK);
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-q', '-m', 'the agent writes its attack');

    const workDir = join(base, 'work');
    mkdirSync(workDir);
    result = await runCleanVerify({
      sandboxes: provider,
      runId: `isolation-verify-hostile-${Date.now()}`,
      ticketId: 'ISO-1',
      branch: BRANCH,
      worktree,
      originUrl: repo,
      workDir,
      // The public image has none; the suite below has it.
      gitleaks: false,
      setup: ['echo setup-ran > .setup-ran'],
      commands: ['bash attack.sh'],
      env: async () => ({ REPO_VISIBLE: 'repo-variable', AGENT_WORKTREE: worktree }),
      log: () => {},
    });
    out = report(result.failures[0]?.output ?? '');
  }, 420_000);

  afterAll(() => {
    if (previous === undefined) delete process.env['FACTORY_DAEMON_SECRET'];
    else process.env['FACTORY_DAEMON_SECRET'] = previous;
    rmSync(base, { recursive: true, force: true });
  });

  it('runs: the command is reached, in a clone at the frozen SHA, and its failure comes back as a verdict', () => {
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ command: 'bash attack.sh', exitCode: 7 });
    expect(out).toMatchObject({ ran: 'yes', done: 'yes' });
    expect(result.sha).toBe(git(worktree, 'rev-parse', BRANCH));
  });

  it('runs the setup first, in the same clone', () => {
    expect(out['setup-witness']).toBe('setup-ran');
  });

  it('finds no engine socket: only the socket the attack made itself', () => {
    expect(out['sockets']).toBe('/tmp/witness.sock');
    expect(out['mounts-engine']).toBe('0');
  });

  it("cannot read the daemon's env, though it reads the repository's variable", () => {
    expect(out['env-witness']).toBe('repo-variable');
    expect(out['env-canary']).toBe('0');
    expect(out['pid1-canary']).toBe('0');
  });

  it("cannot write to the agent's worktree, though it writes in its clone", () => {
    expect(out['write-witness']).toBe('own');
    expect(out['worktree-write']).toBe('no');
    expect(out['worktree-seen']).toBe('no');
    // Its git is the clone's, not the repository's.
    expect(out['gitdir']).toBe('.git');
    expect(existsSync(join(worktree, 'pwned'))).toBe(false);
    expect(existsSync(join(worktree, 'own-file'))).toBe(false);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(result.sha);
  });

  it('cannot reach the network, though its loopback answers', () => {
    expect(out['loopback-witness']).toBe('yes');
    expect(out['interfaces']).toBe('lo');
    expect(out['tcp-out']).toBe('no');
    expect(out['dns']).toBe('no');
  });

  it('leaves no container and no clone behind', async () => {
    const left = (await provider.list()).filter((x) => x.runId.startsWith('isolation-verify-hostile-'));
    expect(left).toEqual([]);
    expect(existsSync(join(base, 'work', 'clone'))).toBe(false);
  });

  // The negative control: the same probes, outside any sandbox, do find what they look for.
  it.skipIf(process.platform === 'win32')('finds the env and writes the worktree when it runs on the host, as verify did', () => {
    const scratch = join(base, 'on-host');
    mkdirSync(scratch);
    writeFileSync(join(scratch, 'attack.sh'), readFileSync(join(worktree, 'attack.sh')));
    const onHost = spawnSync('bash', ['attack.sh'], { cwd: scratch, encoding: 'utf8', env: { ...process.env, FACTORY_DAEMON_SECRET: CANARY, REPO_VISIBLE: 'x', AGENT_WORKTREE: worktree } });
    const seen = report(onHost.stdout);
    expect(seen['env-canary']).toBe('1');
    expect(seen['worktree-write']).toBe('yes');
    rmSync(join(worktree, 'pwned'), { force: true });
    // Its `find /` walks the host's whole disk.
  }, 300_000);
});

/** The real gitleaks of `docker/runner.Dockerfile`, by its own pinned line, on a public image with git. */
describe.skipIf(!enabled)(`gitleaks in verify (${cli})`, () => {
  const TAG = `factory-verify-gitleaks:${Date.now()}`;
  const { provider } = useSandboxes('verify-gitleaks', { image: TAG });
  const base = mkdtempSync(join(tmpdir(), 'factory-gitleaks-'));
  // Written in two parts: this file is not to be found by a scan of the factory's own repository.
  const SECRET = `ghp_${'0123456789'.repeat(3)}012345`;
  let origin: string;
  let repo: string;

  const check = async (name: string) => {
    const workDir = join(base, name);
    mkdirSync(workDir);
    return runCleanVerify({
      sandboxes: provider,
      runId: `isolation-verify-gitleaks-${name}-${Date.now()}`,
      ticketId: 'ISO-2',
      branch: BRANCH,
      worktree: repo,
      originUrl: origin,
      workDir,
      gitleaks: true,
      setup: [],
      commands: [],
      env: async () => ({}),
      log: () => {},
    });
  };

  beforeAll(() => {
    const dockerfile = readFileSync(join(import.meta.dirname, '../../docker/runner.Dockerfile'), 'utf8');
    const install = /^RUN node -e "fetch\('https:\/\/github\.com\/gitleaks[\s\S]*?rm \/tmp\/gitleaks\.tgz$/m.exec(dockerfile)?.[0];
    if (!install) throw new Error('docker/runner.Dockerfile no longer installs gitleaks');
    // A file, not `-f -`: Node hands stdin as a socket, and Podman opens /dev/stdin, which a socket refuses.
    const context = join(base, 'image');
    mkdirSync(context);
    const dockerfilePath = join(context, 'Dockerfile');
    writeFileSync(dockerfilePath, `FROM ${IMAGE}\n${install}\n`);
    execFileSync(cli, ['build', '-q', '-t', TAG, '-f', dockerfilePath, context], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000 });

    // The forge, on its default branch, and the agent's clone: the base is what the branch adds to.
    origin = join(base, 'origin');
    git(base, 'init', '-q', '-b', 'main', origin);
    git(origin, 'config', 'user.email', 't@t');
    git(origin, 'config', 'user.name', 't');
    writeFileSync(join(origin, 'README.md'), 'base\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'base');
    repo = join(base, 'repo');
    git(base, 'clone', '-q', origin, repo);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'checkout', '-q', '-b', BRANCH);
    writeFileSync(join(repo, 'clean.ts'), 'export const a = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'clean');
  }, 420_000);

  afterAll(() => {
    spawnSync(cli, ['rmi', '-f', TAG], { stdio: 'ignore' });
    rmSync(base, { recursive: true, force: true });
  });

  it('passes commits with no secret: the witness that it reads them comes next', async () => {
    expect(await check('clean')).toMatchObject({ ok: true, failures: [] });
  });

  it("finds a secret the branch committed, redacted, through what the branch writes to silence it", async () => {
    writeFileSync(join(repo, 'leak.ts'), `export const token = "${SECRET}"; // gitleaks:allow\n`);
    writeFileSync(join(repo, '.gitleaks.toml'), 'title = "x"\n[allowlist]\npaths = [".*"]\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'the agent commits a secret and its silence');
    // A later commit that removes it does not take it out of the history.
    rmSync(join(repo, 'leak.ts'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'and removes it');
    const res = await check('leak');
    expect(res.ok).toBe(false);
    const found = res.failures.find((f) => f.command === 'factory/secrets');
    expect(found?.output).toContain('leak.ts:1 (github-pat)');
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it('finds a secret added by a merge commit alone, which a plain git log shows no patch for', async () => {
    const hidden = `ghp_${'9876543210'.repeat(3)}987654`;
    git(repo, 'reset', '-q', '--hard', 'HEAD~2');
    git(repo, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'side.ts'), 'export const s = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'side');
    git(repo, 'checkout', '-q', BRANCH);
    git(repo, 'merge', '-q', '--no-commit', '--no-ff', 'side');
    writeFileSync(join(repo, 'merged.ts'), `export const token = "${hidden}";\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'merge side');
    const found = (await check('merge')).failures.find((f) => f.command === 'factory/secrets');
    expect(found?.output).toContain('merged.ts');
  });
});
