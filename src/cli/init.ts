import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { Exec } from '../adapters/exec.js';
import { isRecord } from '../adapters/graphql-pages.js';
import { isUsableWebhookSecret } from '../adapters/tracker/linear/webhook.js';
import { loadInstance, loadSecrets, samePath, saveInstance, saveSecrets } from '../config/instance.js';
import { makeRepoConfig } from '../app/repo-variables.js';
import { ignoredWorkflowFiles, ignoredWorkflowWarning, REPO_CONFIG_PATH, testCommandWarnings } from '../config/repo-config.js';
import { slugify } from '../core/naming.js';
import { PRODUCT_NAME } from '../product.js';

export interface InitIO {
  ask(q: string, def?: string): Promise<string>;
  print(s: string): void;
}

export interface InitDeps {
  io: InitIO;
  home: string;
  cwd: string;
  /** `factory init --dev` (ORC-411): a Smee channel for Linear's webhooks when there is no public URL, on a workstation only. */
  dev?: boolean;
  createSmee: () => Promise<string>;
  exec: Exec;
}

/** What `init` proposes for a repository's `.factory/config.yml`: its install, its checks by name, and what starts the application. */
interface Detected {
  setup: string[];
  commands: Record<string, string>;
  preview?: string;
}

/**
 * The scripts of the repository's package.json, those that are a command: none without one, or with one that does not parse
 * or is not an object (npm would refuse it too; a proposal never fails init).
 */
function nodeScripts(repo: string): Record<string, string> | undefined {
  const pkgFile = join(repo, 'package.json');
  if (!existsSync(pkgFile)) return undefined;
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(pkg)) return undefined;
  const scripts = isRecord(pkg['scripts']) ? pkg['scripts'] : {};
  return Object.fromEntries(Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
}

/**
 * npm, or pnpm when its lockfile is the only one: the scripts `lint`, `typecheck` and `test` the repository has, and as its
 * `preview` (ORC-397) the first of `dev`, `start` and `preview`.
 */
function detectNode(repo: string): Detected {
  const scripts = nodeScripts(repo);
  if (!scripts) return { setup: [], commands: {} };
  const npmLock = existsSync(join(repo, 'package-lock.json'));
  const pnpm = !npmLock && existsSync(join(repo, 'pnpm-lock.yaml'));
  const pm = pnpm ? 'pnpm' : 'npm';
  const setup = pnpm ? ['pnpm install --frozen-lockfile'] : npmLock ? ['npm ci'] : [];
  const commands = Object.fromEntries(['lint', 'typecheck', 'test'].filter((s) => scripts[s]).map((s) => [s, `${pm} ${s === 'test' ? 'test' : `run ${s}`}`]));
  const start = ['dev', 'start', 'preview'].find((s) => scripts[s]);
  return { setup, commands, ...(start ? { preview: `${pm} run ${start}` } : {}) };
}

/**
 * uv (ORC-172), on its lockfile only, and every command `--frozen`: `uv run` alone locks again first, and drops a lockfile
 * made under `exclude-newer` (the setup's age cap, which verify does not set) or one the agent's `pyproject.toml` no
 * longer matches; without the network, it fails (measured on uv 0.13.7). A plain `uv sync` rewrites it too
 * (docs/repository-configuration.md). Named after their tool, beside Node's.
 */
function detectPython(repo: string): Detected {
  if (!existsSync(join(repo, 'pyproject.toml')) || !existsSync(join(repo, 'uv.lock'))) return { setup: [], commands: {} };
  return { setup: ['uv sync --frozen'], commands: { ruff: 'uv run --frozen ruff check', mypy: 'uv run --frozen mypy .', pytest: 'uv run --frozen pytest' } };
}

/** Said by `init` when it proposes pytest beside Node's `test` (ORC-420): the red check runs `commands.test` only. */
export const PYTEST_BESIDE_TEST = `Warning: the red check of the tests step runs \`commands.test\` only, Node's here: \`commands.pytest\` runs in verify, not there.`;

/**
 * Both when the repository has both. pytest is the red check's `test` (ORC-420) when Node has none; beside Node's, it keeps its
 * name. A `preview` from Node's scripts only: no convention names a start script for Python (a `[project.scripts]` entry is a
 * console command, not a server).
 */
function detect(repo: string): Detected {
  const node = detectNode(repo);
  const python = detectPython(repo);
  const { pytest, ...checks } = python.commands;
  const tests: Record<string, string> = pytest ? { [node.commands['test'] ? 'pytest' : 'test']: pytest } : {};
  return { ...node, setup: [...node.setup, ...python.setup], commands: { ...node.commands, ...checks, ...tests } };
}

/** What `init` prints before the `.factory/config.yml` it proposes (ORC-388): it writes nothing in the repository. */
export const PROPOSAL_HEADER = `Proposed ${REPO_CONFIG_PATH}, to commit on the default branch (init writes nothing in the repository):\n`;

/** The repository's `.factory/config.yml`, as `init` detects it: none when it detects nothing. */
function proposal({ setup, commands, preview }: Detected): string | undefined {
  const checks = { ...(setup.length ? { setup: setup.join(' && ') } : {}), ...(Object.keys(commands).length ? { commands } : {}) };
  const text =
    (Object.keys(checks).length ? stringify(checks) : '') +
    (preview ? `# What starts the application for the visual proof: it must listen on PORT.\n${stringify({ preview })}` : '');
  return text ? PROPOSAL_HEADER + text : undefined;
}

/** The App's repository permissions, those of docs/github-app-manifest.json (checked by init.test.ts), by their name on GitHub's form. */
export const GITHUB_APP_PERMISSIONS = { contents: 'write', pull_requests: 'write', checks: 'write', statuses: 'read', actions: 'read', metadata: 'read' };
const PERMISSION_LABELS: Record<keyof typeof GITHUB_APP_PERMISSIONS, string> = {
  contents: 'Contents',
  pull_requests: 'Pull requests',
  checks: 'Checks',
  statuses: 'Commit statuses',
  actions: 'Actions',
  metadata: 'Metadata',
};

/**
 * How to create and install the factory's GitHub App (ORC-124), by hand on GitHub's form: a server has no browser for the
 * manifest flow's callback. Its webhook only with a public URL; without one, the factory polls the PRs.
 */
function githubAppSteps(publicUrl: string | undefined, home: string): string {
  const permissions = Object.entries(GITHUB_APP_PERMISSIONS)
    .map(([k, v]) => `${PERMISSION_LABELS[k as keyof typeof GITHUB_APP_PERMISSIONS]}: ${v === 'write' ? 'read and write' : 'read'}`)
    .join(', ');
  const webhook = publicUrl
    ? [
        `   - Webhook: active, URL ${publicUrl}/webhooks/github, secret: a random value you will export as GH_WEBHOOK_SECRET`,
        '   - Events: Pull request, Pull request review, Pull request review comment, Check run, Check suite, Push, Workflow run',
      ]
    : ['   - Webhook: uncheck "Active" (no public URL): the factory polls the PRs every 30 s'];
  return [
    '',
    `GitHub App of ${PRODUCT_NAME} (it opens and updates the PRs):`,
    '1. On GitHub: https://github.com/settings/apps/new (for an organization: its Settings → Developer settings → GitHub Apps).',
    '   - Name and homepage URL: your choice',
    ...webhook,
    `   - Repository permissions: ${permissions}; nothing else`,
    '2. Create the App, note its App ID, then "Generate a private key":',
    `   keep the .pem outside the repository, mode 0600 (e.g. ${join(home, 'github-app.pem')}).`,
    '3. Install the App on the repository ("Install App").',
    '',
  ].join('\n');
}

/** A reference `factory.yml` holds in place of a secret (ORC-209), and what the variable is to hold. */
interface EnvSecret {
  name: string;
  value: string;
}

/**
 * The `factory.yml` `init` writes when there is none (ORC-411): every secret an `env:NAME` reference, the budgets `factory
 * validate` accepts for a first run (docs/first-run.md), to tune afterwards. No `github` when config.yaml has its App: the
 * file's would replace it, field by field (`effectiveInstance`).
 */
function factoryYml(publicUrl: string | undefined, withGithub: boolean): { text: string; env: EnvSecret[] } {
  const env: EnvSecret[] = [
    ...(withGithub
      ? [
          { name: 'GH_APP_ID', value: '<App ID>' },
          { name: 'GH_APP_KEY', value: '<path of the .pem>' },
          ...(publicUrl ? [{ name: 'GH_WEBHOOK_SECRET', value: "<the App's webhook secret>" }] : []),
        ]
      : []),
    { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '<token of claude setup-token>' },
  ];
  const github = { app_id: 'env:GH_APP_ID', private_key: 'env:GH_APP_KEY', ...(publicUrl ? { webhook_secret: 'env:GH_WEBHOOK_SECRET' } : {}) };
  const yml = {
    ...(withGithub ? { github } : {}),
    claude: { runtime: 'claude-code', accounts: [{ name: 'main', token: 'env:CLAUDE_CODE_OAUTH_TOKEN' }], active: 'main', default_model: 'claude-sonnet-5-5' },
    concurrency: 1,
    budgets: { per_step_tokens: 'off', per_ticket_tokens: 5_000_000 },
  };
  return { text: `# Written by factory init: every secret is a reference, read from the daemon's environment.\n${stringify(yml)}`, env };
}

export async function runInit(d: InitDeps): Promise<void> {
  const { io } = d;
  const top = await d.exec('git', ['rev-parse', '--show-toplevel'], { cwd: d.cwd });
  // One form whatever gave the path: git writes `C:/x` on Windows, a typed one may be relative or end with `/`.
  const repoPath = resolve(top.code === 0 ? top.stdout.trim() : await io.ask(`Path of the git repository to hand to ${PRODUCT_NAME}`));
  // Read first: a secrets.json encrypted at rest (ORC-398) stops init before it asks anything.
  const secrets = loadSecrets(d.home);
  const cfg = loadInstance(d.home);
  const previous = cfg.projects.find((p) => samePath(p.repoPath, repoPath));
  // An empty answer keeps what is there (ORC-83): the project's team key, the stored Linear values.
  const teamKey = (await io.ask('Linear team key (e.g. REL)', previous?.linearTeamKey)).toUpperCase();

  const id = previous?.id ?? slugify(basename(repoPath), 30);
  // The project's other fields (its roles, written by hand) stay.
  cfg.projects = [...cfg.projects.filter((p) => p !== previous), { ...previous, id, repoPath, linearTeamKey: teamKey }];
  // Smee only on demand (ORC-411): a public channel, for a workstation; a server has its public URL.
  if (!cfg.publicUrl && cfg.relay.kind === 'none' && d.dev) cfg.relay = { kind: 'smee', url: await d.createSmee() };
  const webhookUrl = cfg.publicUrl ? `${cfg.publicUrl}/webhooks/linear` : cfg.relay.kind === 'smee' ? cfg.relay.url : '<public URL>/webhooks/linear';
  const callbackUrl = `${cfg.publicUrl ?? `http://localhost:${cfg.port}`}/oauth/callback`;

  io.print(
    [
      '',
      ...(webhookUrl.startsWith('<')
        ? [
            "No public URL for Linear's webhooks: set publicUrl in config.yaml (the server's HTTPS URL, or a tunnel's) and run init again,",
            'or, on a workstation, `factory init --dev` for a smee.io relay.',
            '',
          ]
        : []),
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
  const stored = secrets.linear;
  const keep = stored ? ' (empty: keep the current one)' : '';
  const clientId = (await io.ask('Client ID', stored?.clientId)).trim();
  const clientSecret = (await io.ask(`Client secret${keep}`)).trim() || stored?.clientSecret || '';
  let webhookSecret: string;
  for (;;) {
    webhookSecret = (await io.ask(`Webhook signing secret${keep}`)).trim() || stored?.webhookSecret || '';
    if (isUsableWebhookSecret(webhookSecret)) break;
    io.print(`The webhook signing secret is required: without it, ${PRODUCT_NAME} refuses every webhook.`);
  }
  const keepTokens = stored?.clientId === clientId ? stored : {};
  saveSecrets(d.home, { ...secrets, linear: { ...keepTokens, clientId, clientSecret, webhookSecret } });

  // The workflow is the factory/default preset (ORC-388): the repository's part is its `.factory/config.yml`, read on the
  // default branch, which `init` proposes and leaves to commit.
  for (const file of ignoredWorkflowFiles(repoPath)) io.print(ignoredWorkflowWarning(file));
  const detected = existsSync(join(repoPath, REPO_CONFIG_PATH)) ? undefined : detect(repoPath);
  const proposed = detected && proposal(detected);
  if (proposed) io.print(proposed);
  // The red check's command (ORC-412), in what it proposes or, as the daemon reads it, on the default branch: without it,
  // every ticket blocks at the tests step. A file git cannot read there is `factory validate`'s and `factory doctor`'s to name.
  const commands = detected
    ? detected.commands
    : await makeRepoConfig({ exec: d.exec })({ repoPath }, { fetch: false }).then((c) => c.commands, () => undefined);
  for (const warning of testCommandWarnings(commands)) io.print(warning);
  if (detected?.commands['pytest']) io.print(PYTEST_BESIDE_TEST);

  saveInstance(d.home, cfg);
  // An App config.yaml already has is set up: its steps would only add noise.
  if (!cfg.github) io.print(githubAppSteps(cfg.publicUrl, d.home));
  const ymlPath = join(d.home, 'factory.yml');
  if (existsSync(ymlPath)) {
    io.print(`${ymlPath} kept as it is.`);
  } else {
    const written = factoryYml(cfg.publicUrl, !cfg.github);
    writeFileSync(ymlPath, written.text, { flag: 'wx' });
    io.print(
      [
        `Wrote ${ymlPath}: its secrets are references; export them in the shell of \`factory up\` and \`factory doctor\`:`,
        ...written.env.map((e) => `  export ${e.name}=${e.value}`),
      ].join('\n'),
    );
  }
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
