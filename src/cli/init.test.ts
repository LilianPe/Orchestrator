import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packDir } from '../../test/helpers/harness.js';
import { copyPythonRepo } from '../../test/helpers/python-repo.js';
import type { Exec } from '../adapters/exec.js';
import { loadInstance, loadSecrets, saveInstance } from '../config/instance.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { runInit, type InitIO } from './init.js';

function scriptedIO(answers: string[], confirms: boolean[]): InitIO & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    ask: async (_q, def) => answers.shift() || def || '',
    confirm: async (_q, def) => confirms.shift() ?? def ?? false,
    print: (s) => void printed.push(s),
  };
}

const gitTop: (repo: string) => Exec = (repo) => async (cmd, args) =>
  cmd === 'git' && args[0] === 'rev-parse' ? { stdout: `${repo}\n`, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 };

const NPM = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'package-lock.json': '{}' };
const PNPM_LOCK = { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" };

/** Runs init, every proposal kept, on a repository of `files` (over the Python fixture with `python`): the workflow it wrote merged with the pack, and what it printed. */
async function initWorkflow(files: Record<string, string>, o: { python?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
  if (o.python) copyPythonRepo(repo);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  const io = scriptedIO(['REL', 'cid', 'csecret', 'whsecret', ''], [false]);
  await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec: gitTop(repo) });
  return { wf: loadWorkflow({ packDir, projectFile: join(repo, '.factory/workflow.yml') }), printed: io.printed.join('\n') };
}

describe('factory init', () => {
  it('writes config, secrets and the project workflow', async () => {
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
    const io = scriptedIO(['REL', 'cid', 'csecret', 'whsecret', ''], [false]);
    await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec: realExec });

    const cfg = loadInstance(home);
    expect(cfg.relay).toEqual({ kind: 'smee', url: 'https://smee.io/abc' });
    expect(cfg.projects).toEqual([{ id: expect.any(String), repoPath: repo, linearTeamKey: 'REL' }]);
    expect(loadSecrets(home).linear).toEqual({ clientId: 'cid', clientSecret: 'csecret', webhookSecret: 'whsecret' });
    const wf = readFileSync(join(repo, '.factory/workflow.yml'), 'utf8');
    expect(wf).toContain('team: REL');
    expect(wf).toContain('npm test');
    expect(wf).toContain('npm ci');
    const out = io.printed.join('\n');
    expect(out).toContain('http://localhost:4100/oauth/callback');
    expect(out).toContain('https://smee.io/abc');
    expect(out).toContain('Agent session events');
    expect(existsSync(join(home, 'config.yaml'))).toBe(true);
  });

  it('criterion 1 (ORC-172): a Python repository with no config gets uv sync --frozen, ruff, mypy and pytest, the red check included', async () => {
    const { wf } = await initWorkflow({}, { python: true });
    expect(wf.workspace.setup).toEqual(['uv sync --frozen']);
    expect(wf.jobs.dev!.verify).toEqual(['uv run --frozen ruff check', 'uv run --frozen mypy .', 'uv run --frozen pytest']);
    expect(wf.jobs.tests!.red?.command).toBe('uv run --frozen pytest');
  });

  it('a pyproject.toml without uv.lock proposes nothing: a `uv run` would write a lockfile into the worktree', async () => {
    const { wf } = await initWorkflow({ 'pyproject.toml': '[project]\nname = "x"\n' });
    expect(wf.workspace.setup).toEqual([]);
    expect(wf.jobs.dev!.verify).toEqual([]);
    expect(wf.jobs.tests!.red?.command).toBe('npm test --');
  });

  it('a repository with both proposes both, the red check on the Node tests, and says so', async () => {
    const { wf, printed } = await initWorkflow(NPM, { python: true });
    expect(wf.workspace.setup).toEqual(['npm ci', 'uv sync --frozen']);
    expect(wf.jobs.dev!.verify).toEqual(['npm test', 'uv run --frozen ruff check', 'uv run --frozen mypy .', 'uv run --frozen pytest']);
    expect(wf.jobs.tests!.red?.command).toBe('npm test --');
    expect(printed).toContain('the Python tests a tests step adds are not checked red');
  });

  it('a TypeScript repository with a pnpm-lock.yaml gets pnpm commands', async () => {
    const { wf } = await initWorkflow({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc', test: 'vitest run' } }), ...PNPM_LOCK });
    expect(wf.workspace.setup).toEqual(['pnpm install --frozen-lockfile']);
    expect(wf.jobs.dev!.verify).toEqual(['pnpm run lint', 'pnpm run typecheck', 'pnpm test']);
    expect(wf.jobs.tests!.red?.command).toBe('pnpm test');
  });

  it('a package-lock.json next to a pnpm-lock.yaml stays npm, as before', async () => {
    const { wf } = await initWorkflow({ ...NPM, ...PNPM_LOCK });
    expect(wf.workspace.setup).toEqual(['npm ci']);
    expect(wf.jobs.tests!.red?.command).toBe('npm test --');
  });
  it('asks the webhook signing secret again until it is not empty', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    const exec = gitTop(repo);
    const asked: string[] = [];
    const answers = ['REL', 'cid', 'csecret', '', '  ', 'whsecret', ''];
    const io: InitIO = {
      ask: async (q, def) => {
        asked.push(q);
        if (!answers.length) throw new Error(`no more answers (${q})`);
        return answers.shift() || def || '';
      },
      confirm: async () => false,
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
    const io = scriptedIO([`${repo}/`, 'REL', 'cid', 'csecret', 'whsecret', ''], [false]);
    await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec });
    expect(loadInstance(home).projects).toEqual([{ id: expect.any(String), repoPath: repo, linearTeamKey: 'REL' }]);
  });
});
