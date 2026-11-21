import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyPythonRepo } from '../../test/helpers/python-repo.js';
import type { Exec } from '../adapters/exec.js';
import { loadFactoryLimits, parseFactoryYml } from '../config/factory-yml.js';
import { loadInstance, loadSecrets, saveInstance, saveSecrets } from '../config/instance.js';
import { MISSING_TEST_COMMAND, parseRepoConfig, testCommandWarnings } from '../config/repo-config.js';
import { GITHUB_APP_PERMISSIONS, PROPOSAL_HEADER, PYTEST_BESIDE_TEST, runInit, type InitIO } from './init.js';
import { runValidateCommand } from './validate.js';

function scriptedIO(answers: string[]): InitIO & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    ask: async (_q, def) => answers.shift() || def || '',
    print: (s) => void printed.push(s),
  };
}

/** git for init: the repository's top, and its `.factory/config.yml` on the default branch as the working copy has it, unless `uncommitted`. */
const gitTop =
  (repo: string, o: { uncommitted?: boolean } = {}): Exec =>
  async (cmd, args) => {
    const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
    const file = join(repo, '.factory/config.yml');
    if (cmd !== 'git') return ok('');
    if (args[0] === 'rev-parse') return ok(`${repo}\n`);
    if (args.includes('symbolic-ref')) return ok('refs/remotes/origin/main\n');
    if (args.includes('ls-tree')) return ok(o.uncommitted || !existsSync(file) ? '' : args.at(-1) === '.factory' ? '040000 tree 1a\t.factory\0' : '100644 blob 2b\t.factory/config.yml\0');
    if (args.includes('cat-file')) return ok(readFileSync(file, 'utf8'));
    return ok('');
  };

const NPM = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'package-lock.json': '{}' };
const PNPM_LOCK = { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" };

/**
 * Runs init on a repository of `files` (over the Python fixture with `python`): the `.factory/config.yml` it proposed, read as
 * the factory reads one, and whether it wrote a file in the repository.
 */
async function initProposal(files: Record<string, string>, o: { python?: boolean; uncommitted?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
  if (o.python) copyPythonRepo(repo);
  const factoryBefore = Object.keys(files).some((path) => path.startsWith('.factory/'));
  if (factoryBefore) mkdirSync(join(repo, '.factory'));
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  const io = scriptedIO(['REL', 'cid', 'csecret', 'whsecret']);
  await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec: gitTop(repo, o) });
  const proposal = io.printed.find((p) => p.startsWith(PROPOSAL_HEADER));
  return {
    config: proposal === undefined ? undefined : parseRepoConfig(proposal.slice(PROPOSAL_HEADER.length)),
    proposal,
    printed: io.printed,
    wrote: !factoryBefore && existsSync(join(repo, '.factory')),
  };
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
    await runInit({ io, home, cwd: repo, dev: true, createSmee: async () => 'https://smee.io/abc', exec: realExec });

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

  it('criterion 1 (ORC-172): a Python repository with no config gets uv sync --frozen, ruff, mypy and pytest, as its `test` (ORC-420)', async () => {
    const { config, wrote, printed } = await initProposal({}, { python: true });
    expect(wrote).toBe(false);
    expect(config?.setup).toBe('uv sync --frozen');
    expect(config?.commands).toEqual({ ruff: 'uv run --frozen ruff check', mypy: 'uv run --frozen mypy .', test: 'uv run --frozen pytest' });
    // What it proposes, the red check can run: no warning right after it.
    expect(printed).not.toContain(MISSING_TEST_COMMAND);
    expect(testCommandWarnings(config?.commands)).toEqual([]);
  });

  it('a pyproject.toml without uv.lock proposes nothing: a `uv run` would write a lockfile into the worktree', async () => {
    const { config, wrote } = await initProposal({ 'pyproject.toml': '[project]\nname = "x"\n' });
    expect(config).toBeUndefined();
    expect(wrote).toBe(false);
  });

  it('a repository with both proposes both: pytest under its own name, said not to be the red check\'s (ORC-420)', async () => {
    const { config, printed } = await initProposal(NPM, { python: true });
    expect(config?.setup).toBe('npm ci && uv sync --frozen');
    expect(config?.commands).toEqual({ test: 'npm test', ruff: 'uv run --frozen ruff check', mypy: 'uv run --frozen mypy .', pytest: 'uv run --frozen pytest' });
    expect(printed).toContain(PYTEST_BESIDE_TEST);
    expect(printed).not.toContain(MISSING_TEST_COMMAND);
    expect((await initProposal({}, { python: true })).printed).not.toContain(PYTEST_BESIDE_TEST);
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
    const { proposal, printed } = await initProposal({ ...NPM, '.factory/config.yml': 'commands: { test: npm test }\n', '.factory/workflow.yml': 'version: 1\n' });
    expect(proposal).toBeUndefined();
    expect(printed).toContain('Warning: .factory/workflow.yml is ignored: the workflow is the factory/default preset. Delete it; its setup and checks go in .factory/config.yml.');
  });

  it('warns when the repository will have no `commands.test`, proposed or on the default branch (ORC-412)', async () => {
    expect((await initProposal({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }), 'package-lock.json': '{}' })).printed).toContain(MISSING_TEST_COMMAND);
    expect((await initProposal({ '.factory/config.yml': 'commands: { lint: npm run lint }\n' })).printed).toContain(MISSING_TEST_COMMAND);
    expect((await initProposal(NPM)).printed).not.toContain(MISSING_TEST_COMMAND);
    expect((await initProposal({ '.factory/config.yml': 'commands: { test: npm test }\n' })).printed).not.toContain(MISSING_TEST_COMMAND);
    // An invalid file is `factory validate`'s to name.
    expect((await initProposal({ '.factory/config.yml': 'commands: [\n' })).printed).not.toContain(MISSING_TEST_COMMAND);
    // Read where the daemon reads it: one not committed on the default branch yet is not there.
    expect((await initProposal({ '.factory/config.yml': 'commands: { test: npm test }\n' }, { uncommitted: true })).printed).toContain(MISSING_TEST_COMMAND);
  });

  it('stops before asking anything when secrets.json is encrypted at rest (ORC-398)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    saveSecrets(home, {}, 'k'.repeat(32));
    const io = scriptedIO(['REL', 'cid', 'csecret', 'whsecret']);
    const asked: string[] = [];
    await expect(runInit({ io: { ...io, ask: async (q) => {
      asked.push(q);
      return '';
    } }, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec: gitTop(repo) })).rejects.toThrow('secrets.json is encrypted at rest');
    expect(asked).toEqual([]);
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

describe('factory init: the command that starts the application, in the same proposal (ORC-397)', () => {
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

  it('takes the first of dev, start and preview the package.json has, with its package manager', async () => {
    expect((await initProposal({ 'package.json': pkg({ preview: 'vite preview', start: 'node .', dev: 'vite' }), 'package-lock.json': '{}' })).config?.preview).toBe('npm run dev');
    expect((await initProposal({ 'package.json': pkg({ preview: 'vite preview', start: 'node .' }) })).config?.preview).toBe('npm run start');
    expect((await initProposal({ 'package.json': pkg({ preview: 'vite preview' }), ...PNPM_LOCK })).config?.preview).toBe('pnpm run preview');
  });

  it('one proposal with setup, commands and preview, the preview said to listen on PORT', async () => {
    const { printed } = await initProposal({ 'package.json': pkg({ test: 'vitest run', dev: 'vite' }), 'package-lock.json': '{}' });
    expect(printed.filter((p) => p.includes('.factory/config.yml, to commit'))).toEqual([
      `${PROPOSAL_HEADER}setup: npm ci\ncommands:\n  test: npm test\n# What starts the application for the visual proof: it must listen on PORT.\npreview: npm run dev\n`,
    ]);
  });

  it('proposes none without such a script, nor for a Python repository, which has no start script by convention; nothing over a package.json that does not parse', async () => {
    expect((await initProposal({ 'package.json': pkg({ test: 'vitest run', build: 'tsc' }) })).config?.preview).toBeUndefined();
    expect((await initProposal({ 'package.json': JSON.stringify({ scripts: { dev: true, test: 'vitest run' } }) })).config).toEqual(expect.objectContaining({ commands: { test: 'npm test' } }));
    expect((await initProposal({ 'package.json': JSON.stringify({ scripts: { dev: true } }) })).config?.preview).toBeUndefined();
    expect((await initProposal({}, { python: true })).config?.preview).toBeUndefined();
    expect((await initProposal({ 'package.json': '{ "scripts": { "dev": "vite" }, }' })).config).toBeUndefined();
    for (const pkgJson of ['null', '[]', '1']) expect((await initProposal({ 'package.json': pkgJson, 'package-lock.json': '{}' })).config).toBeUndefined();
  });

  it('a preview alone is still a proposal', async () => {
    expect((await initProposal({ 'package.json': pkg({ dev: 'vite' }) })).config).toMatchObject({ preview: 'npm run dev', commands: {} });
  });
});

/** A fresh home and repository, and what one `init` run with `answers` printed. */
async function initOnce(o: { home?: string; repo?: string; answers?: string[]; dev?: boolean; smee?: () => Promise<string> } = {}) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'factory-init-home-'));
  const repo = o.repo ?? mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
  const io = scriptedIO(o.answers ?? ['REL', 'cid', 'csecret', 'whsecret']);
  await runInit({ io, home, cwd: repo, ...(o.dev ? { dev: true } : {}), createSmee: o.smee ?? (async () => 'https://smee.io/abc'), exec: gitTop(repo) });
  return { home, repo, out: io.printed.join('\n') };
}

describe('factory init: Smee only for development (ORC-411)', () => {
  it('criterion 2: without a public URL nor --dev, creates no Smee channel and says how to get the webhooks', async () => {
    let created = 0;
    const { home, out } = await initOnce({ smee: async () => (created++, 'https://smee.io/abc') });
    expect(created).toBe(0);
    expect(loadInstance(home).relay).toEqual({ kind: 'none' });
    expect(out).not.toContain('https://smee.io');
    expect(out).toContain('factory init --dev');
    expect(out).toContain('publicUrl');
  });

  it('with --dev, creates the channel and gives it as the webhook URL', async () => {
    const { home, out } = await initOnce({ dev: true });
    expect(loadInstance(home).relay).toEqual({ kind: 'smee', url: 'https://smee.io/abc' });
    expect(out).toContain('https://smee.io/abc');
  });

  it('with a public URL, gives its webhook URLs and creates no channel, even with --dev', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    saveInstance(home, { port: 4100, host: '127.0.0.1', publicUrl: 'https://factory.example.com', relay: { kind: 'none' }, projects: [], limits: {} });
    let created = 0;
    const { out } = await initOnce({ home, dev: true, smee: async () => (created++, 'https://smee.io/abc') });
    expect(created).toBe(0);
    expect(out).toContain('https://factory.example.com/webhooks/linear');
    expect(out).toContain('https://factory.example.com/webhooks/github');
    expect(loadInstance(home).relay).toEqual({ kind: 'none' });
  });

  it('keeps a channel config.yaml already has, without --dev', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'smee', url: 'https://smee.io/old' }, projects: [], limits: {} });
    const { out } = await initOnce({ home });
    expect(loadInstance(home).relay).toEqual({ kind: 'smee', url: 'https://smee.io/old' });
    expect(out).toContain('https://smee.io/old');
  });
});

describe('factory init: the GitHub App and factory.yml (ORC-411)', () => {
  const ENV = { GH_APP_ID: '123', GH_APP_KEY: '/k.pem', GH_WEBHOOK_SECRET: 'w', CLAUDE_CODE_OAUTH_TOKEN: 't' };

  it('criterion 1: guides the App with the manifest\'s permissions, and writes a factory.yml that factory validate accepts', async () => {
    const { home, repo, out } = await initOnce();
    expect(out).toContain('https://github.com/settings/apps/new');
    expect(out).toContain('Contents: read and write');
    expect(out).toContain('Install the App on the repository');
    expect(out).toContain('Active');
    const text = readFileSync(join(home, 'factory.yml'), 'utf8');
    const lines: string[] = [];
    expect(runValidateCommand({ repoPath: repo, out: (l) => lines.push(l), factoryYml: () => loadFactoryLimits(home) })).toBe(0);
    // As `factory doctor` and `factory up` read it, with the daemon's environment.
    const yml = parseFactoryYml(text, ENV);
    expect(yml.github).toMatchObject({ appId: '123', privateKey: '/k.pem' });
    expect(yml.claude?.accounts).toEqual([{ name: 'main', token: 't' }]);
    // Every secret a reference, and each one said to export.
    expect(Object.keys(yml.secretRefs ?? {}).sort()).toEqual(['claude.accounts[0].token', 'github.private_key']);
    expect(text).toContain('app_id: env:GH_APP_ID');
    for (const name of ['GH_APP_ID', 'GH_APP_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(out).toContain(`export ${name}=`);
    expect(out).not.toContain('GH_WEBHOOK_SECRET');
  });

  it('with a public URL, the App\'s webhook and its secret, a reference in factory.yml', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    saveInstance(home, { port: 4100, host: '127.0.0.1', publicUrl: 'https://factory.example.com', relay: { kind: 'none' }, projects: [], limits: {} });
    const { out } = await initOnce({ home });
    expect(parseFactoryYml(readFileSync(join(home, 'factory.yml'), 'utf8'), ENV).github?.webhookSecret).toBe('w');
    expect(out).toContain('export GH_WEBHOOK_SECRET=');
  });

  it('leaves the GitHub App of config.yaml in place: no github in the factory.yml it writes, which would replace it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {}, github: { appId: '7', privateKey: '/k.pem' } });
    const { out } = await initOnce({ home });
    const yml = parseFactoryYml(readFileSync(join(home, 'factory.yml'), 'utf8'), ENV);
    expect(yml.github).toBeUndefined();
    expect(yml.claude?.active).toBe('main');
    expect(out).not.toContain('GH_APP_ID');
    expect(out).not.toContain('https://github.com/settings/apps/new');
    expect(loadInstance(home).github).toEqual({ appId: '7', privateKey: '/k.pem' });
  });

  it('the permissions it prints are the manifest\'s', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../../docs/github-app-manifest.json'), 'utf8')) as { default_permissions: unknown };
    expect(GITHUB_APP_PERMISSIONS).toEqual(manifest.default_permissions);
  });

  it('criterion 3 (ORC-83): run again with empty answers, it erases no credential, nor factory.yml, nor the project\'s roles', async () => {
    const first = await initOnce({ dev: true });
    const { home, repo } = first;
    // Edited since: a credential init never asked, the OAuth tokens of « Connect Linear », the roles added by hand.
    writeFileSync(join(home, 'factory.yml'), 'github: { app_id: "42", private_key: env:MY_KEY }\n');
    const secrets = loadSecrets(home);
    saveSecrets(home, { ...secrets, linear: { ...secrets.linear!, accessToken: 'at', refreshToken: 'rt', expiresAt: 1 } });
    const cfg = loadInstance(home);
    saveInstance(home, { ...cfg, projects: cfg.projects.map((p) => ({ ...p, authz: { maintainers: [], validators: ['v1', 'v2'], githubLogins: { u: 'login' } } })) });
    const before = { yml: readFileSync(join(home, 'factory.yml'), 'utf8'), secrets: loadSecrets(home), config: loadInstance(home) };

    const { out } = await initOnce({ home, repo, answers: [] });
    expect(readFileSync(join(home, 'factory.yml'), 'utf8')).toBe(before.yml);
    expect(loadSecrets(home)).toEqual(before.secrets);
    expect(loadInstance(home)).toEqual(before.config);
    expect(out).toContain('factory.yml kept');
  });

  it('a new value replaces the stored one; another client ID drops the old tokens', async () => {
    const { home, repo } = await initOnce();
    const s = loadSecrets(home);
    saveSecrets(home, { ...s, linear: { ...s.linear!, accessToken: 'at' } });
    await initOnce({ home, repo, answers: ['', '', 'csecret2', ''] });
    expect(loadSecrets(home).linear).toEqual({ clientId: 'cid', clientSecret: 'csecret2', webhookSecret: 'whsecret', accessToken: 'at' });
    await initOnce({ home, repo, answers: ['', 'cid2', '', ''] });
    expect(loadSecrets(home).linear).toEqual({ clientId: 'cid2', clientSecret: 'csecret2', webhookSecret: 'whsecret' });
  });
});
