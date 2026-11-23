import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { copyPythonRepo } from '../../test/helpers/python-repo.js';
import type { Exec } from '../adapters/exec.js';
import { loadFactoryLimits, parseFactoryYml } from '../config/factory-yml.js';
import { loadInstance, loadSecrets, saveInstance, saveSecrets, type InstanceConfig } from '../config/instance.js';
import { MISSING_TEST_COMMAND, parseRepoConfig, testCommandWarnings } from '../config/repo-config.js';
import { LINEAR_NEEDS_SECRETS_KEY } from '../config/secrets-file.js';
import { readSecretsKey } from '../config/server-secrets.js';
import { slugify } from '../core/naming.js';
import { MemoryStore } from '../store/memory-store.js';
import { GITHUB_APP_PERMISSIONS, instanceCards, MATURITY_HEADER, NO_PUBLIC_URL, PROPOSAL_HEADER, PYTEST_BESIDE_TEST, runInit, storeReport, type InitDeps, type InitIO } from './init.js';
import type { MaturityReport } from './maturity.js';
import { runValidateCommand } from './validate.js';

/** A `secrets_key` of the shell's environment, for an init that asks Linear without --dev (ORC-470). */
const KEY_ENV = { FACTORY_SECRETS_KEY: 'k'.repeat(44) };
const declareEnvKey = (home: string) => appendFileSync(join(home, 'factory.yml'), 'secrets_key: env:FACTORY_SECRETS_KEY\n');
/** secrets.json opened as the daemon opens it, with factory.yml's `secrets_key`. */
const secretsOf = async (home: string) => loadSecrets(home, await readSecretsKey(home, KEY_ENV));

function scriptedIO(answers: string[]): InitIO & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    ask: async (_q, def) => answers.shift() || def || '',
    print: (s) => void printed.push(s),
  };
}

/**
 * git for init: the repository's top, its origin on GitHub (`acme/pilot` by default), and its `.factory/config.yml` on the default
 * branch as the working copy has it, unless `uncommitted`.
 */
const gitTop =
  (repo: string, o: { uncommitted?: boolean; origin?: string } = {}): Exec =>
  async (cmd, args) => {
    const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
    const file = join(repo, '.factory/config.yml');
    if (cmd !== 'git') return ok('');
    if (args[0] === 'rev-parse') return ok(`${repo}\n`);
    if (args.includes('get-url')) return ok(`${o.origin ?? 'https://github.com/acme/pilot.git'}\n`);
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
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/pilot.git'], { cwd: repo });
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
    // The repository by its GitHub name, from its origin (ORC-480): no local path.
    expect(cfg.projects).toEqual([{ id: expect.any(String), github: 'acme/pilot', linearTeamKey: 'REL' }]);
    expect((await secretsOf(home)).linear).toEqual({ clientId: 'cid', clientSecret: 'csecret', webhookSecret: 'whsecret' });
    expect(existsSync(join(repo, '.factory'))).toBe(false);
    const out = io.printed.join('\n');
    expect(out).toContain(`${PROPOSAL_HEADER}setup: npm ci\ncommands:\n  test: npm test\n`);
    expect(out).toContain('http://localhost:4100/oauth/callback');
    expect(out).toContain('https://smee.io/abc');
    expect(out).toContain('Agent session events');
    // The daemon reads factory.yml alone (ORC-199).
    expect(existsSync(join(home, 'factory.yml'))).toBe(true);
    expect(existsSync(join(home, 'config.yaml'))).toBe(false);
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
    await runInit({ io, home, cwd: repo, dev: true, createSmee: async () => 'https://smee.io/abc', exec });

    expect(asked.filter((q) => q === 'Webhook signing secret')).toHaveLength(3);
    expect((await secretsOf(home)).linear?.webhookSecret).toBe('whsecret');
  });

  it("finds the repository's entry by the GitHub repository its origin names, whatever its case, from a typed path (ORC-480)", async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [{ id: 'old', github: 'Acme/Pilot', linearTeamKey: 'OLD' }] });
    const typed: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: '', stderr: 'not a git repository', code: 128 };
      if (args.includes('get-url')) typed.push(args);
      return { stdout: args.includes('get-url') ? 'https://github.com/acme/pilot\n' : '', stderr: '', code: 0 };
    };
    const io = scriptedIO([`${repo}/`, 'REL', 'cid', 'csecret', 'whsecret']);
    await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec });
    expect(typed).toEqual([['-C', repo, 'remote', 'get-url', 'origin']]);
    expect(loadInstance(home).projects).toEqual([{ id: 'old', github: 'Acme/Pilot', linearTeamKey: 'REL' }]);
  });

  it('refuses a repository whose origin is not on GitHub, before it asks or writes anything (ORC-480)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    const asked: string[] = [];
    const io: InitIO = {
      ask: async (q) => {
        asked.push(q);
        return '';
      },
      print: () => {},
    };
    await expect(runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec: gitTop(repo, { origin: '/srv/git/pilot.git' }) })).rejects.toThrow(
      /^the origin remote of .* is not a GitHub repository: set it to https:\/\/github\.com\/<owner>\/<name>/,
    );
    expect(asked).toEqual([]);
    expect(existsSync(join(home, 'factory.yml'))).toBe(false);
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

describe('factory init: the maturity report, one card per point to approve (ORC-410)', () => {
  /** One init over a repository of `files`; its cards go through `storeCards`, by default `storeReport` into `store`. */
  async function initCards(
    files: Record<string, string>,
    {
      store = new MemoryStore(),
      now = 1_700_000_000_000,
      repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-')),
      home = mkdtempSync(join(tmpdir(), 'factory-init-home-')),
      storeCards = async (projectId: string, report: MaturityReport) => ({ cards: await storeReport(store, projectId, report, now), where: 'the test store' }),
    }: { store?: MemoryStore; now?: number; repo?: string; home?: string; storeCards?: InitDeps['storeCards'] } = {},
  ) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    const io = scriptedIO(['REL', 'cid', 'csecret', 'whsecret']);
    await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec: gitTop(repo), storeCards });
    return { store, repo, projectId: loadInstance(home).projects[0]!.id, out: io.printed.join('\n') };
  }

  it('criterion 1: without .factory/config.yml, the detected values are proposed and each point is a stored card to approve', async () => {
    const { store, projectId, out } = await initCards(NPM);
    expect(out).toContain(`${PROPOSAL_HEADER}setup: npm ci`);
    const cards = await store.maturityCards(projectId);
    expect(cards.map((c) => c.key)).toEqual(['stack', 'commands', 'main', 'services', 'visual_paths', 'untested']);
    expect(cards.every((c) => c.approvedBy === undefined)).toBe(true);
    expect(out).toContain(`${MATURITY_HEADER}http://localhost:4100/#maturity`);
    expect(out).toContain('  [to approve] Stack: Node (npm)');
    expect(out).toContain('  [to approve] Commands:\n    setup: npm ci\n    test: npm test');
    expect(out).toContain('Cards stored in the test store.');
  });

  it('a card approved and detected the same again says by whom; nothing over an existing .factory/config.yml', async () => {
    const store = new MemoryStore();
    const { projectId, repo } = await initCards(NPM, { store });
    await store.approveMaturityCard(projectId, 'stack', 'Node (npm)', 'armand', 1_700_000_000_001);
    const again = await initCards(NPM, { store, repo, now: 1_700_000_000_002 });
    expect(again.out).toContain('  [approved by armand] Stack: Node (npm)');
    const configured = await initCards({ ...NPM, '.factory/config.yml': 'commands: { test: npm test }\n' });
    expect(configured.out).not.toContain(MATURITY_HEADER);
    expect(await configured.store.maturityCards()).toEqual([]);
  });

  it("the main card says the project's last dry run on main, stored before init ran (ORC-408)", async () => {
    const store = new MemoryStore();
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    const projectId = slugify(basename(repo), 30);
    const at = Date.UTC(2026, 10, 20, 14, 3);
    const fingerprint = { setup: 's', image: 'i', lockfiles: {}, config: null, hash: 'h' };
    await store.putDryRun({ id: 'd1', projectId, sha: 'a'.repeat(40), target: 'main', ok: false, fingerprint, breaks: [{ kind: 'failure', step: 'command', command: 'npm test', detail: '1 failed', output: '' }], commands: ['npm test'], startedAt: at, endedAt: at });
    const { out } = await initCards(NPM, { store, repo });
    expect(out).toContain(`  [to approve] main green or red:\n    red: the dry run of aaaaaaaaaaaa on 2026-11-20 14:03 UTC: failure in \`npm test\`\n    fix it on main, then factory dry-run ${projectId}`);
    expect((await store.maturityCards(projectId)).find((c) => c.key === 'main')?.value).toMatch(/^red: /);
  });

  it('without FACTORY_DATABASE_URL, init finishes and says the cards are not stored, naming the variable (ORC-178)', async () => {
    vi.stubEnv('FACTORY_DATABASE_URL', '');
    try {
      const home = join(mkdtempSync(join(tmpdir(), 'factory-init-')), 'home');
      const { out } = await initCards(NPM, { home, storeCards: instanceCards });
      expect(out).toContain('Cards not stored (FACTORY_DATABASE_URL is not set: the factory keeps its state in Postgres only. Set it to the Postgres URL.)');
      expect(existsSync(join(home, 'factory.db'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a store that cannot be written does not fail init: the cards are printed, and said not stored', async () => {
    const { out } = await initCards(NPM, { storeCards: async () => Promise.reject(new Error('connection refused')) });
    expect(out).toContain('  [to approve] Stack: Node (npm)');
    expect(out).toContain('Cards not stored (connection refused): run factory init again once the database is reachable.');
    expect(out).toContain('Configuration written.');
  });
});

/** A fresh home and repository, and what one `init` run with `answers` printed. */
async function initOnce(o: { home?: string; repo?: string; answers?: string[]; dev?: boolean; smee?: () => Promise<string>; config?: Partial<InstanceConfig>; envKey?: boolean } = {}) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'factory-init-home-'));
  if (o.config) saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], ...o.config });
  if (o.envKey) declareEnvKey(home);
  const repo = o.repo ?? mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
  const io = scriptedIO(o.answers ?? ['REL', 'cid', 'csecret', 'whsecret']);
  await runInit({ io, home, cwd: repo, dev: o.dev, env: KEY_ENV, createSmee: o.smee ?? (async () => 'https://smee.io/abc'), exec: gitTop(repo) });
  return { home, repo, out: io.printed.join('\n') };
}

describe('factory init: Smee only for development (ORC-411)', () => {
  it('criterion 2: without a public URL nor --dev, creates no Smee channel and says how to get the webhooks', async () => {
    let created = 0;
    const { home, out } = await initOnce({ smee: async () => (created++, 'https://smee.io/abc') });
    expect(created).toBe(0);
    expect(loadInstance(home).relay).toEqual({ kind: 'none' });
    expect(out).not.toContain('https://smee.io');
    expect(out).toContain(NO_PUBLIC_URL);
    // Linear gives its webhook secret only for a webhook URL: none asked, none stored.
    expect(out).not.toContain('OAuth applications');
    expect(loadSecrets(home).linear).toBeUndefined();
    expect(loadInstance(home).projects).toEqual([expect.objectContaining({ linearTeamKey: 'REL' })]);
  });

  it('with --dev, creates the channel and gives it as the webhook URL', async () => {
    const { home, out } = await initOnce({ dev: true });
    expect(loadInstance(home).relay).toEqual({ kind: 'smee', url: 'https://smee.io/abc' });
    expect(out).toContain('https://smee.io/abc');
  });

  // ORC-444: the development mode is what --dev writes, the daemon's leave to start the Smee relay.
  it('with --dev, writes dev: true over its channel, also one written before the marker', async () => {
    expect(loadInstance((await initOnce({ dev: true })).home).dev).toBe(true);
    const old = await initOnce({ dev: true, config: { relay: { kind: 'smee', url: 'https://smee.io/old' } } });
    expect(loadInstance(old.home)).toMatchObject({ dev: true, relay: { kind: 'smee', url: 'https://smee.io/old' } });
  });

  it('writes no dev without --dev, nor with a public URL, even beside an old channel', async () => {
    expect(loadInstance((await initOnce()).home).dev).toBeUndefined();
    const server = await initOnce({ dev: true, config: { publicUrl: 'https://factory.example.com', relay: { kind: 'smee', url: 'https://smee.io/old' } } });
    expect(loadInstance(server.home).dev).toBeUndefined();
  });

  it('with a public URL, gives its webhook URLs and creates no channel, even with --dev', async () => {
    let created = 0;
    const { home, out } = await initOnce({ config: { publicUrl: 'https://factory.example.com' }, dev: true, smee: async () => (created++, 'https://smee.io/abc') });
    expect(created).toBe(0);
    expect(out).toContain('https://factory.example.com/webhooks/linear');
    expect(out).toContain('https://factory.example.com/webhooks/github');
    expect(loadInstance(home).relay).toEqual({ kind: 'none' });
  });

  it('keeps a channel factory.yml already has, without --dev', async () => {
    const { home, out } = await initOnce({ config: { relay: { kind: 'smee', url: 'https://smee.io/old' } }, envKey: true });
    expect(loadInstance(home).relay).toEqual({ kind: 'smee', url: 'https://smee.io/old' });
    expect(out).toContain('https://smee.io/old');
  });
});

/** Every file under `dir`, read as text: where a secret written in clear would show. */
function filesText(dir: string): string {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

describe('factory init: secrets_key, Linear never in clear (ORC-470)', () => {
  const CANARY = ['canary-client-secret-470', 'canary-webhook-secret-470'];

  it('--dev draws secrets_key into a file of its own, mode 0600, declares it in factory.yml, never prints it, and seals secrets.json', async () => {
    const { home, out } = await initOnce({ dev: true, answers: ['REL', 'cid', ...CANARY] });
    const key = readFileSync(join(home, 'secrets.key'), 'utf8').trim();
    expect(key.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== 'win32') expect(statSync(join(home, 'secrets.key')).mode & 0o777).toBe(0o600);
    expect(out).not.toContain(key);
    const text = readFileSync(join(home, 'factory.yml'), 'utf8');
    expect(parseFactoryYml(text, { GH_APP_ID: '1', GH_APP_KEY: '/k', CLAUDE_CODE_OAUTH_TOKEN: 't' }, undefined, 'defer').secretSources).toEqual({ factory_home: { kind: 'file', options: { dir: home } } });
    expect(text).toContain('secrets_key: factory_home:secrets.key');
    expect(text).not.toContain(key);
    // As the daemon reads it, at its start.
    expect(await readSecretsKey(home, {})).toBe(key);
    expect((await secretsOf(home)).linear).toMatchObject({ clientSecret: CANARY[0], webhookSecret: CANARY[1] });
    const disk = filesText(home);
    for (const canary of CANARY) expect(disk).not.toContain(canary);
  });

  it('run again with --dev, keeps the key it drew: secrets.json stays readable', async () => {
    const { home, repo } = await initOnce({ dev: true });
    const key = readFileSync(join(home, 'secrets.key'), 'utf8');
    const yml = readFileSync(join(home, 'factory.yml'), 'utf8');
    await initOnce({ home, repo, dev: true, answers: [] });
    expect(readFileSync(join(home, 'secrets.key'), 'utf8')).toBe(key);
    expect(readFileSync(join(home, 'factory.yml'), 'utf8')).toBe(yml);
    expect((await secretsOf(home)).linear?.clientSecret).toBe('csecret');
  });

  it('--dev draws none beside a secrets_key factory.yml names', async () => {
    const { home } = await initOnce({ dev: true, envKey: true, answers: ['REL', 'cid', ...CANARY] });
    expect(existsSync(join(home, 'secrets.key'))).toBe(false);
    expect(loadSecrets(home, KEY_ENV.FACTORY_SECRETS_KEY).linear?.clientSecret).toBe(CANARY[0]);
    for (const canary of CANARY) expect(filesText(home)).not.toContain(canary);
  });

  it('--dev draws no key off the loopback, nor beside a secrets.json sealed with another key, nor over a source of its name', async () => {
    const refusals: [string, (home: string) => void, string][] = [
      ['exposed', (home) => saveInstance(home, { port: 4100, host: '0.0.0.0', publicUrl: 'https://factory.example.com', relay: { kind: 'none' }, projects: [] }), `${LINEAR_NEEDS_SECRETS_KEY}.`],
      ['sealed', (home) => saveSecrets(home, {}, 'another-key-'.repeat(4)), 'secrets.json is encrypted at rest with a key factory.yml no longer names'],
      ['its name', (home) => writeFileSync(join(home, 'factory.yml'), 'secret_sources: { factory_home: { kind: systemd-creds } }\n'), 'secret_sources.factory_home in factory.yml'],
    ];
    for (const [name, arrange, refusal] of refusals) {
      const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
      arrange(home);
      const asked: string[] = [];
      const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
      const io: InitIO = { ask: async (q) => (asked.push(q), ''), print: () => {} };
      await expect(runInit({ io, home, cwd: repo, dev: true, env: {}, createSmee: async () => 'https://smee.io/abc', exec: gitTop(repo) }), name).rejects.toThrow(refusal);
      expect({ name, asked, drawn: existsSync(join(home, 'secrets.key')) }).toEqual({ name, asked: [], drawn: false });
    }
  });

  it('--dev refuses a key file too short, naming it, before asking anything', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    writeFileSync(join(home, 'secrets.key'), 'short\n', { mode: 0o600 });
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    await expect(runInit({ io: scriptedIO([]), home, cwd: repo, dev: true, env: {}, createSmee: async () => 'https://smee.io/abc', exec: gitTop(repo) })).rejects.toThrow(`${join(home, 'secrets.key')}: at least 32 characters expected`);
  });

  it('declares its key under a bare secret_sources:', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    writeFileSync(join(home, 'factory.yml'), 'secret_sources:\n');
    await initOnce({ home, dev: true });
    expect(await readSecretsKey(home, {})).toBe(readFileSync(join(home, 'secrets.key'), 'utf8').trim());
  });

  it('says how to go on when the key\'s source is out of this shell\'s reach', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    saveInstance(home, { port: 4100, host: '127.0.0.1', publicUrl: 'https://factory.example.com', relay: { kind: 'none' }, projects: [] });
    appendFileSync(join(home, 'factory.yml'), 'secret_sources: { creds: { kind: systemd-creds } }\nsecrets_key: creds:secrets-key\n');
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    await expect(runInit({ io: scriptedIO([]), home, cwd: repo, env: {}, createSmee: async () => 'https://smee.io/abc', exec: gitTop(repo) })).rejects.toThrow(
      /CREDENTIALS_DIRECTORY is not set.*\nfactory init seals Linear's values with secrets_key, never in clear \(ORC-470\): run it where that source is readable, or write the Linear values in factory\.yml's linear section/s,
    );
  });

  it('without --dev nor secrets_key, refuses before asking anything, and writes no secrets.json', async () => {
    for (const config of [{ publicUrl: 'https://factory.example.com' }, { relay: { kind: 'smee' as const, url: 'https://smee.io/old' } }]) {
      const asked: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
      saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], ...config });
      const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
      const io: InitIO = { ask: async (q) => (asked.push(q), ''), print: () => {} };
      await expect(runInit({ io, home, cwd: repo, env: {}, createSmee: async () => 'https://smee.io/abc', exec: gitTop(repo) })).rejects.toThrow(`${LINEAR_NEEDS_SECRETS_KEY}.`);
      expect(asked).toEqual([]);
      expect(existsSync(join(home, 'secrets.json'))).toBe(false);
    }
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
    expect(runValidateCommand({ checkout: repo, out: (l) => lines.push(l), factoryYml: () => loadFactoryLimits(home) })).toBe(0);
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

  it('with a public URL, the App\'s webhook is optional: its secret is said to add, never written, as an unset variable would stop the daemon', async () => {
    const { home, out } = await initOnce({ config: { publicUrl: 'https://factory.example.com' }, envKey: true });
    expect(parseFactoryYml(readFileSync(join(home, 'factory.yml'), 'utf8'), { GH_APP_ID: '1', GH_APP_KEY: '/k', CLAUDE_CODE_OAUTH_TOKEN: 't', ...KEY_ENV }).github?.webhookSecret).toBeUndefined();
    expect(out).toContain('webhook_secret: env:GH_WEBHOOK_SECRET');
  });

  it('writes a factory.yml on an instance that ran without one, never reading its config.yaml, nor naming an App it ran without (ORC-199)', async () => {
    const { home, repo } = await initOnce({ dev: true });
    rmSync(join(home, 'factory.yml'));
    writeFileSync(join(home, 'config.yaml'), 'port: 4555\nprojects: [{ id: other, repoPath: /other, linearTeamKey: OTH }]\n');
    const { out } = await initOnce({ home, repo, dev: true });
    // Its secrets_key a file's, read at the start alone.
    const yml = parseFactoryYml(readFileSync(join(home, 'factory.yml'), 'utf8'), ENV, undefined, 'defer');
    expect(yml.claude?.active).toBe('main');
    expect(yml.github).toBeUndefined();
    expect(loadInstance(home)).toMatchObject({ port: 4100, projects: [expect.objectContaining({ linearTeamKey: 'REL' })] });
    expect(loadInstance(home).projects).toHaveLength(1);
    expect(out).not.toContain('https://github.com/settings/apps/new');
  });

  it('keeps the comments of what it does not change, and writes no default the file leaves out (ORC-199)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    writeFileSync(join(home, 'factory.yml'), 'port: 4200 # my port\npublic_url: https://f.example.com # tunnel\n');
    await initOnce({ home, envKey: true });
    const text = readFileSync(join(home, 'factory.yml'), 'utf8');
    expect(text).toContain('port: 4200 # my port\npublic_url: https://f.example.com # tunnel\n');
    expect(text).not.toMatch(/^(host|relay):/m);
  });

  it("updates the repository's entry, keeping its fields, and leaves its replay of closed tickets and the other repositories as they are (ORC-480)", async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    const authz = { maintainers: [], validators: ['v'], githubLogins: {} };
    const ghost = { id: 'ghost', github: 'acme/pilot', linearTeamKey: 'OLD', preset: 'factory/fantome' as const };
    const other = { id: 'b', github: 'acme/other', linearTeamKey: 'OLD' };
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [ghost, { id: 'a', github: 'acme/pilot', linearTeamKey: 'OLD', authz }, other] });
    await initOnce({ home });
    expect(loadInstance(home).projects).toEqual([ghost, { id: 'a', github: 'acme/pilot', linearTeamKey: 'REL', authz }, other]);
  });

  it("gives a new repository an id no entry holds, its folder's taken by another repository or its own replay (ORC-480)", async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'factory-init-repo-'));
    const id = slugify(basename(repo), 30);
    const ghost = { id, github: 'acme/pilot', linearTeamKey: 'OLD', preset: 'factory/fantome' as const };
    const other = { id: `${id}-2`, github: 'acme/other', linearTeamKey: 'OLD' };
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [ghost, other] });
    await initOnce({ home, repo });
    expect(loadInstance(home).projects).toEqual([ghost, other, { id: `${id}-3`, github: 'acme/pilot', linearTeamKey: 'REL' }]);
  });

  it('leaves the GitHub App of factory.yml in place, and prints no App steps for it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-init-home-'));
    writeFileSync(join(home, 'factory.yml'), '# my App\ngithub: { app_id: "7", private_key: env:MY_KEY }\n');
    const { out } = await initOnce({ home });
    const text = readFileSync(join(home, 'factory.yml'), 'utf8');
    expect(text).toContain('# my App\ngithub: { app_id: "7", private_key: env:MY_KEY }\n');
    expect(parseFactoryYml(text, { MY_KEY: '/k.pem' }).github).toEqual({ appId: '7', privateKey: '/k.pem' });
    expect(out).not.toContain('GH_APP_ID');
    expect(out).not.toContain('https://github.com/settings/apps/new');
  });

  it('the permissions it prints are the manifest\'s', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../../docs/github-app-manifest.json'), 'utf8')) as { default_permissions: unknown };
    expect(GITHUB_APP_PERMISSIONS).toEqual(manifest.default_permissions);
  });

  it('criterion 3 (ORC-83): run again with empty answers, it erases no credential, nor factory.yml, nor the project\'s roles', async () => {
    const first = await initOnce({ dev: true });
    const { home, repo } = first;
    // Edited since: a credential init never asked, the OAuth tokens of « Connect Linear », the roles added by hand.
    const cfg = loadInstance(home);
    // The secrets_key --dev declared kept: it holds secrets.json.
    const keyLines = readFileSync(join(home, 'factory.yml'), 'utf8').match(/^secret_sources:\n(?: .*\n)*secrets_key: .*\n/m)![0];
    writeFileSync(join(home, 'factory.yml'), `github: { app_id: "42", private_key: env:MY_KEY }\n${keyLines}`);
    const key = (await readSecretsKey(home))!;
    const secrets = loadSecrets(home, key);
    saveSecrets(home, { ...secrets, linear: { ...secrets.linear!, accessToken: 'at', refreshToken: 'rt', expiresAt: 1 } }, key);
    saveInstance(home, { ...cfg, projects: cfg.projects.map((p) => ({ ...p, authz: { maintainers: [], validators: ['v1', 'v2'], githubLogins: { u: 'login' } } })) });
    const before = { yml: readFileSync(join(home, 'factory.yml'), 'utf8'), secrets: loadSecrets(home, key), config: loadInstance(home) };

    const { out } = await initOnce({ home, repo, answers: [] });
    expect(readFileSync(join(home, 'factory.yml'), 'utf8')).toBe(before.yml);
    expect(loadSecrets(home, key)).toEqual(before.secrets);
    expect(loadInstance(home)).toEqual(before.config);
    expect(out).toContain('factory.yml: its repositories and webhook relay written, the rest kept as it is.');
  });

  it('a new value replaces the stored one; another client ID keeps nothing of the old application', async () => {
    const { home, repo } = await initOnce({ dev: true });
    const key = (await readSecretsKey(home))!;
    const s = loadSecrets(home, key);
    saveSecrets(home, { ...s, linear: { ...s.linear!, accessToken: 'at' } }, key);
    await initOnce({ home, repo, answers: ['', '', 'csecret2', ''] });
    expect((await secretsOf(home)).linear).toEqual({ clientId: 'cid', clientSecret: 'csecret2', webhookSecret: 'whsecret', accessToken: 'at' });
    // Its secrets are asked: an empty webhook secret is asked again, not taken from the old application.
    await initOnce({ home, repo, answers: ['', 'cid2', 'cs3', '', 'wh3'] });
    expect((await secretsOf(home)).linear).toEqual({ clientId: 'cid2', clientSecret: 'cs3', webhookSecret: 'wh3' });
  });
});
