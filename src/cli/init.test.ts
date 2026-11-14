import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyPythonRepo } from '../../test/helpers/python-repo.js';
import type { Exec } from '../adapters/exec.js';
import { loadInstance, loadSecrets, saveInstance } from '../config/instance.js';
import { parseRepoConfig } from '../config/repo-config.js';
import { PROPOSAL_HEADER, runInit, type InitIO } from './init.js';

function scriptedIO(answers: string[]): InitIO & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    ask: async (_q, def) => answers.shift() || def || '',
    print: (s) => void printed.push(s),
  };
}

const gitTop: (repo: string) => Exec = (repo) => async (cmd, args) =>
  cmd === 'git' && args[0] === 'rev-parse' ? { stdout: `${repo}\n`, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 };

const NPM = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'package-lock.json': '{}' };
const PNPM_LOCK = { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" };

/**
 * Runs init on a repository of `files` (over the Python fixture with `python`): the `.factory/config.yml` it proposed, read as
 * the factory reads one, and whether it wrote a file in the repository.
 */
async function initProposal(files: Record<string, string>, o: { python?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
  if (o.python) copyPythonRepo(repo);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  const io = scriptedIO(['REL', 'cid', 'csecret', 'whsecret']);
  await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec: gitTop(repo) });
  const proposal = io.printed.find((p) => p.startsWith(PROPOSAL_HEADER));
  return { config: proposal === undefined ? undefined : parseRepoConfig(proposal.slice(PROPOSAL_HEADER.length)), wrote: existsSync(join(repo, '.factory')) };
}

describe('factory init', () => {
  it('writes config and secrets, and nothing in the repository: its .factory/config.yml is proposed (ORC-388)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(repo, 'package-lock.json'), '{}');
    const realExec: Exec = async (cmd, args, opts) => {
      try {
        return { stdout: execFileSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8' }), stderr: '', code: 0 };
      } catch {
        return { stdout: '', stderr: 'x', code: 1 };
      }
    };
    const io = scriptedIO(['REL', 'cid', 'csecret', 'whsecret']);
    await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec: realExec });

    const cfg = loadInstance(home);
    expect(cfg.relay).toEqual({ kind: 'smee', url: 'https://smee.io/abc' });
    expect(cfg.projects).toEqual([{ id: expect.any(String), repoPath: repo, linearTeamKey: 'REL' }]);
    expect(loadSecrets(home).linear).toEqual({ clientId: 'cid', clientSecret: 'csecret', webhookSecret: 'whsecret' });
    expect(existsSync(join(repo, '.factory'))).toBe(false);
    const out = io.printed.join('\n');
    expect(out).toContain(`${PROPOSAL_HEADER}setup: npm ci\ncommands:\n  test: npm test\n`);
    expect(out).toContain('http://localhost:4100/oauth/callback');
    expect(out).toContain('https://smee.io/abc');
    expect(out).toContain('Agent session events');
    expect(existsSync(join(home, 'config.yaml'))).toBe(true);
  });

  it('criterion 1 (ORC-172): a Python repository with no config gets uv sync --frozen, ruff, mypy and pytest', async () => {
    const { config, wrote } = await initProposal({}, { python: true });
    expect(wrote).toBe(false);
    expect(config?.setup).toBe('uv sync --frozen');
    expect(config?.commands).toEqual({ ruff: 'uv run --frozen ruff check', mypy: 'uv run --frozen mypy .', pytest: 'uv run --frozen pytest' });
  });

  it('a pyproject.toml without uv.lock proposes nothing: a `uv run` would write a lockfile into the worktree', async () => {
    const { config, wrote } = await initProposal({ 'pyproject.toml': '[project]\nname = "x"\n' });
    expect(config).toBeUndefined();
    expect(wrote).toBe(false);
  });

  it('a repository with both proposes both', async () => {
    const { config } = await initProposal(NPM, { python: true });
    expect(config?.setup).toBe('npm ci && uv sync --frozen');
    expect(config?.commands).toEqual({ test: 'npm test', ruff: 'uv run --frozen ruff check', mypy: 'uv run --frozen mypy .', pytest: 'uv run --frozen pytest' });
  });

  it('a TypeScript repository with a pnpm-lock.yaml gets pnpm commands', async () => {
    const { config } = await initProposal({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc', test: 'vitest run' } }), ...PNPM_LOCK });
    expect(config?.setup).toBe('pnpm install --frozen-lockfile');
    expect(config?.commands).toEqual({ lint: 'pnpm run lint', typecheck: 'pnpm run typecheck', test: 'pnpm test' });
  });

  it('a package-lock.json next to a pnpm-lock.yaml stays npm, as before', async () => {
    const { config } = await initProposal({ ...NPM, ...PNPM_LOCK });
    expect(config?.setup).toBe('npm ci');
    expect(config?.commands).toEqual({ test: 'npm test' });
  });

  it('proposes nothing over an existing .factory/config.yml, and says an old .factory/workflow.yml is ignored', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    for (const [path, content] of Object.entries(NPM)) writeFileSync(join(repo, path), content);
    mkdirSync(join(repo, '.factory'));
    writeFileSync(join(repo, '.factory/config.yml'), 'commands: { test: npm test }\n');
    writeFileSync(join(repo, '.factory/workflow.yml'), 'version: 1\n');
    const io = scriptedIO(['REL', 'cid', 'csecret', 'whsecret']);
    await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec: gitTop(repo) });
    expect(io.printed.some((p) => p.startsWith(PROPOSAL_HEADER))).toBe(false);
    expect(io.printed).toContain('Warning: .factory/workflow.yml is ignored: the workflow is the factory/default preset. Delete it; its setup and checks go in .factory/config.yml.');
  });

  it('asks the webhook signing secret again until it is not empty', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    const exec = gitTop(repo);
    const asked: string[] = [];
    const answers = ['REL', 'cid', 'csecret', '', '  ', 'whsecret'];
    const io: InitIO = {
      ask: async (q, def) => {
        asked.push(q);
        if (!answers.length) throw new Error(`no more answers (${q})`);
        return answers.shift() || def || '';
      },
      print: () => {},
    };
    await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec });

    expect(asked.filter((q) => q === 'Webhook signing secret')).toHaveLength(3);
    expect(loadSecrets(home).linear?.webhookSecret).toBe('whsecret');
  });

  it("replaces the repo's entry written in another form (git's `C:/x`, a trailing slash, another case on Windows), and stores a typed path resolved", async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    const old = `${repo.replaceAll('\\', '/')}/`;
    const project = { id: 'old', repoPath: process.platform === 'win32' ? old.toUpperCase() : old, linearTeamKey: 'OLD' };
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [project], limits: {} });
    const exec: Exec = async (cmd, args) =>
      cmd === 'git' && args[0] === 'rev-parse' ? { stdout: '', stderr: 'not a git repository', code: 128 } : { stdout: '', stderr: '', code: 0 };
    const io = scriptedIO([`${repo}/`, 'REL', 'cid', 'csecret', 'whsecret']);
    await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec });
    expect(loadInstance(home).projects).toEqual([{ id: expect.any(String), repoPath: repo, linearTeamKey: 'REL' }]);
  });
});
