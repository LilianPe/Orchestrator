import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Exec } from '../adapters/exec.js';
import { isUsableWebhookSecret } from '../adapters/tracker/linear/webhook.js';
import { loadInstance, loadSecrets, saveInstance, saveSecrets } from '../config/instance.js';
import { slugify } from '../core/naming.js';
import { PRODUCT_NAME } from '../product.js';

export interface InitIO {
  ask(q: string, def?: string): Promise<string>;
  confirm(q: string, def?: boolean): Promise<boolean>;
  print(s: string): void;
}

export interface InitDeps {
  io: InitIO;
  home: string;
  cwd: string;
  createSmee: () => Promise<string>;
  exec: Exec;
}

/** What `init` proposes for a repository: its install, its checks, and the test command the red check appends the new tests to. */
interface Detected {
  setup: string[];
  verify: string[];
  red?: string;
}

/**
 * npm, or pnpm when its lockfile is the only one: the scripts `lint`, `typecheck` and `test` the repository has. pnpm
 * hands a `--` to the script as it is (`vitest run -- x.test.ts` filters nothing, measured on pnpm 10.20): its red
 * command has none.
 */
function detectNode(repo: string): Detected {
  const pkgFile = join(repo, 'package.json');
  if (!existsSync(pkgFile)) return { setup: [], verify: [] };
  const scripts = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  const npmLock = existsSync(join(repo, 'package-lock.json'));
  const pnpm = !npmLock && existsSync(join(repo, 'pnpm-lock.yaml'));
  const pm = pnpm ? 'pnpm' : 'npm';
  const setup = pnpm ? ['pnpm install --frozen-lockfile'] : npmLock ? ['npm ci'] : [];
  const verify = ['lint', 'typecheck', 'test'].filter((s) => scripts[s]).map((s) => `${pm} ${s === 'test' ? 'test' : `run ${s}`}`);
  return { setup, verify, ...(scripts.test ? { red: pnpm ? 'pnpm test' : 'npm test --' } : {}) };
}

/**
 * uv (ORC-172), on its lockfile only, and every command `--frozen`: `uv run` alone locks again first, and drops a lockfile
 * made under `exclude-newer` (the setup's age cap, which verify does not set) or one the agent's `pyproject.toml` no
 * longer matches; without the network, it fails (measured on uv 0.13.7). A plain `uv sync` rewrites it too
 * (docs/repository-configuration.md).
 */
function detectPython(repo: string): Detected {
  if (!existsSync(join(repo, 'pyproject.toml')) || !existsSync(join(repo, 'uv.lock'))) return { setup: [], verify: [] };
  return { setup: ['uv sync --frozen'], verify: ['uv run --frozen ruff check', 'uv run --frozen mypy .', 'uv run --frozen pytest'], red: 'uv run --frozen pytest' };
}

/** Both when the repository has both: the red check runs one command, Node's first. */
function detect(repo: string): Detected {
  const node = detectNode(repo);
  const python = detectPython(repo);
  const red = node.red ?? python.red;
  return { setup: [...node.setup, ...python.setup], verify: [...node.verify, ...python.verify], ...(red ? { red } : {}) };
}

/** Whether two paths name one directory: an entry an older init wrote in another form (`C:/x`, `x/`) is the same repo. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

export async function runInit(d: InitDeps): Promise<void> {
  const { io } = d;
  const top = await d.exec('git', ['rev-parse', '--show-toplevel'], { cwd: d.cwd });
  // One form whatever gave the path: git writes `C:/x` on Windows, a typed one may be relative or end with `/`.
  const repoPath = resolve(top.code === 0 ? top.stdout.trim() : await io.ask(`Path of the git repository to hand to ${PRODUCT_NAME}`));
  const teamKey = (await io.ask('Linear team key (e.g. REL)')).toUpperCase();

  const cfg = loadInstance(d.home);
  const id = slugify(basename(repoPath), 30);
  cfg.projects = [...cfg.projects.filter((p) => !samePath(p.repoPath, repoPath)), { id, repoPath, linearTeamKey: teamKey }];
  if (!cfg.publicUrl && cfg.relay.kind === 'none') cfg.relay = { kind: 'smee', url: await d.createSmee() };
  const webhookUrl = cfg.publicUrl ? `${cfg.publicUrl}/webhooks/linear` : cfg.relay.kind === 'smee' ? cfg.relay.url : '';
  const callbackUrl = `${cfg.publicUrl ?? `http://localhost:${cfg.port}`}/oauth/callback`;

  io.print(
    [
      '',
      '1. In Linear: Settings → API → OAuth applications → New application.',
      `   - Name: ${PRODUCT_NAME} (the name you will mention with @)`,
      `   - Callback URL: ${callbackUrl}`,
      '   - Check "Webhooks", URL:',
      `     ${webhookUrl}`,
      '   - Categories: Agent session events, Issues, Comments',
      '2. Create the application, then paste the client ID, the client secret and the webhook signing secret below.',
      '',
    ].join('\n'),
  );
  const clientId = await io.ask('Client ID');
  const clientSecret = await io.ask('Client secret');
  let webhookSecret: string;
  for (;;) {
    webhookSecret = (await io.ask('Webhook signing secret')).trim();
    if (isUsableWebhookSecret(webhookSecret)) break;
    io.print(`The webhook signing secret is required: without it, ${PRODUCT_NAME} refuses every webhook.`);
  }
  const secrets = loadSecrets(d.home);
  const keepTokens = secrets.linear?.clientId === clientId ? secrets.linear : {};
  saveSecrets(d.home, { ...secrets, linear: { ...keepTokens, clientId, clientSecret, webhookSecret } });

  if (!cfg.knowledge && (await io.confirm('Create a private GitHub repository "factory-knowledge" for the knowledge base?', true))) {
    const kbPath = join(d.home, 'knowledge');
    const created = await d.exec('gh', ['repo', 'create', 'factory-knowledge', '--private', '--add-readme', '--clone'], { cwd: d.home });
    if (created.code === 0) {
      mkdirSync(join(kbPath, 'notes'), { recursive: true });
      writeFileSync(join(kbPath, 'INDEX.md'), `# ${PRODUCT_NAME} knowledge base\n\n`);
      writeFileSync(join(kbPath, 'notes/.gitkeep'), '');
      await d.exec('git', ['-C', kbPath, 'add', '.'], {});
      await d.exec('git', ['-C', kbPath, 'commit', '-m', 'init knowledge base'], {});
      await d.exec('git', ['-C', kbPath, 'push'], {});
      cfg.knowledge = { repoPath: kbPath };
    } else {
      io.print(`Could not create it: ${created.stderr.trim()}. You can set knowledge.repoPath in ${join(d.home, 'config.yaml')}.`);
    }
  }

  const wfFile = join(repoPath, '.factory/workflow.yml');
  if (!existsSync(wfFile)) {
    const { setup, verify: detected, red } = detect(repoPath);
    const verify = (await io.ask('Verification commands after each run (separated by ;)', detected.join('; ')))
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    mkdirSync(join(repoPath, '.factory'), { recursive: true });
    writeFileSync(
      wfFile,
      [
        'version: 1',
        'extends: standard',
        'tracker:',
        '  kind: linear',
        `  team: ${teamKey}`,
        'workspace:',
        `  setup: ${JSON.stringify(setup)}`,
        'jobs:',
        '  dev:',
        `    verify: ${JSON.stringify(verify)}`,
        ...(red ? ['  tests:', `    red: ${JSON.stringify({ command: red })}`] : []),
        '',
      ].join('\n'),
    );
  }

  saveInstance(d.home, cfg);
  io.print(
    [
      '',
      'Configuration written.',
      'Next:',
      '  1. factory up',
      `  2. open http://localhost:${cfg.port} and click "Connect Linear" (installs the agent in your workspace)`,
      `  3. delegate a ticket to @${PRODUCT_NAME} in Linear`,
      '',
    ].join('\n'),
  );
}
