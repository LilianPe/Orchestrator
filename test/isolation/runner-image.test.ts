import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCleanVerify } from '../../src/core/clean-verify.js';
import { cli, enabled, image, useSandboxes } from './helpers.js';

const built = enabled && !!process.env['FACTORY_RUNNER_IMAGE'];

/** docker/runner.Dockerfile (ORC-203): skipped on the public node image the other isolation tests default to. */
describe.skipIf(!built)(`the runner image (${cli})`, () => {
  const inImage = (script: string) => execFileSync(cli, ['run', '--rm', '--network', 'none', image, 'sh', '-c', script], { encoding: 'utf8', timeout: 60_000 }).trim();

  it.each([
    ['node', 'node --version', /^v24\./],
    ['pnpm', 'pnpm --version', /^10\.20\.0$/],
    ['python', 'python3 --version', /^Python 3\./],
    ['uv', 'uv --version', /^uv 0\.13\.7/],
    ['git', 'git --version', /^git version/],
    ['gitleaks', 'gitleaks version', /^v?8\.30\.1/],
    ['semgrep', 'SEMGREP_ENABLE_VERSION_CHECK=0 semgrep --version', /^1\.182\.1$/],
    ['claude', 'claude --version', /^2\.1\.316/],
  ])('has %s', (_name, command, expected) => {
    expect(inImage(command)).toMatch(expected);
  });

  it('has neither gh nor an engine CLI, nor any daemon code', () => {
    // One name at a time: dash's `command -v` looks at its first operand only.
    expect(inImage('for c in gh docker podman; do command -v "$c"; done; echo end')).toBe('end');
    expect(inImage('ls /app 2>/dev/null || echo none')).toBe('none');
  });
});

/** ORC-333, criterion 2: the image's Semgrep and the factory's rules, in `verify`, through what the branch writes to silence them. */
describe.skipIf(!built)(`semgrep in verify on the runner image (${cli})`, () => {
  const { provider } = useSandboxes('verify-semgrep');
  const base = mkdtempSync(join(tmpdir(), 'factory-semgrep-'));
  const BRANCH = 'factory/iso-3';
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commit = (cwd: string, files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', message);
  };
  let origin: string;
  let repo: string;

  const check = async (name: string) => {
    const workDir = join(base, name);
    mkdirSync(workDir);
    return runCleanVerify({
      sandboxes: provider, runId: `isolation-verify-semgrep-${name}-${Date.now()}`, ticketId: 'ISO-3', branch: BRANCH, worktree: repo, originUrl: origin, workDir,
      gitleaks: false, semgrep: true, setup: [], commands: [], env: async () => ({}), log: () => {},
    });
  };

  beforeAll(() => {
    origin = join(base, 'origin');
    git(base, 'init', '-q', '-b', 'main', origin);
    for (const c of [['user.email', 't@t'], ['user.name', 't']] as const) git(origin, 'config', ...c);
    // A finding on a line the branch does not write stays the base's.
    commit(origin, { 'src/old.js': 'eval(legacy);\n' }, 'base');
    repo = join(base, 'repo');
    git(base, 'clone', '-q', origin, repo);
    for (const c of [['user.email', 't@t'], ['user.name', 't']] as const) git(repo, 'config', ...c);
    git(repo, 'checkout', '-q', '-b', BRANCH);
    commit(repo, { 'src/old.js': 'eval(legacy);\nexport const a = 1;\n' }, 'clean');
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('passes a branch that breaks no rule: the witness that it scans comes next', async () => {
    expect(await check('clean')).toMatchObject({ ok: true, failures: [] });
  }, 300_000);

  it('blocks eval on an added line, through a nosemgrep comment and a .semgrepignore', async () => {
    commit(repo, { 'src/run.js': 'export const run = (input) => eval(input); // nosemgrep\n', '.semgrepignore': 'src/\n' }, 'eval, silenced');
    const res = await check('eval');
    expect(res.ok).toBe(false);
    expect(res.failures).toEqual([{ command: 'factory/semgrep', exitCode: 1, output: expect.stringMatching(/`src\/run\.js`:1 \([\w.]*js-eval\)/) }]);
    expect(res.failures[0]!.output).not.toContain('old.js');
  }, 300_000);
});
