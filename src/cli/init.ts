import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { Exec } from '../adapters/exec.js';
import { isRecord } from '../adapters/graphql-pages.js';
import { isUsableWebhookSecret } from '../adapters/tracker/linear/webhook.js';
import { loadInstance, loadSecrets, samePath, saveInstance, saveSecrets } from '../config/instance.js';
import { makeRepoConfig } from '../app/repo-variables.js';
import { ignoredWorkflowFiles, ignoredWorkflowWarning, REPO_CONFIG_PATH, testCommandWarnings } from '../config/repo-config.js';
import { repoRoot } from '../app/root.js';
import { slugify } from '../core/naming.js';
import { SONNET } from '../presets/factory-default.js';
import { PRODUCT_NAME } from '../product.js';
import { DATABASE_URL_ENV, openStore } from '../store/open.js';
import type { MaturityCard, MaturityPoint, Store } from '../store/types.js';
import { maturityReport, type DetectedChecks, type MaturityReport } from './maturity.js';

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
  /**
   * Stores the maturity cards of a detection (ORC-410), `main` from the project's last dry run, and gives them back as stored,
   * approvals kept, with the store they went to (ORC-437): absent, none is stored.
   */
  storeCards?: (projectId: string, report: MaturityReport) => Promise<StoredCards>;
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
function detectNode(repo: string): DetectedChecks {
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
function detectPython(repo: string): DetectedChecks {
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
function detect(repo: string): DetectedChecks {
  const node = detectNode(repo);
  const python = detectPython(repo);
  const { pytest, ...checks } = python.commands;
  const tests: Record<string, string> = pytest ? { [node.commands['test'] ? 'pytest' : 'test']: pytest } : {};
  return { ...node, setup: [...node.setup, ...python.setup], commands: { ...node.commands, ...checks, ...tests } };
}

/** What `init` prints before the `.factory/config.yml` it proposes (ORC-388): it writes nothing in the repository. */
export const PROPOSAL_HEADER = `Proposed ${REPO_CONFIG_PATH}, to commit on the default branch (init writes nothing in the repository):\n`;

/** The repository's `.factory/config.yml`, as `init` detects it: none when it detects nothing. */
function proposal({ setup, commands, preview }: DetectedChecks): string | undefined {
  const checks = { ...(setup.length ? { setup: setup.join(' && ') } : {}), ...(Object.keys(commands).length ? { commands } : {}) };
  const text =
    (Object.keys(checks).length ? stringify(checks) : '') +
    (preview ? `# What starts the application for the visual proof: it must listen on PORT.\n${stringify({ preview })}` : '');
  return text ? PROPOSAL_HEADER + text : undefined;
}

/** The maturity cards as stored, and `where`: the store `init` wrote them to, as it says it (ORC-437). */
export interface StoredCards {
  cards: MaturityCard[];
  where: string;
}

/** What `init` prints before the maturity cards (ORC-410), followed by the dashboard page where a person approves them. */
export const MATURITY_HEADER = 'Maturity report, one card per point to approve on the dashboard: ';

type PrintedCard = MaturityPoint & Pick<MaturityCard, 'approvedBy'>;

/** A card as init prints it: approved or not, its value under its title, a value of several lines indented. */
function cardLine(c: PrintedCard): string {
  const status = c.approvedBy === undefined ? '[to approve]' : `[approved by ${c.approvedBy}]`;
  const lines = c.value.split('\n');
  return lines.length === 1 ? `  ${status} ${c.title}: ${c.value}` : [`  ${status} ${c.title}:`, ...lines.map((l) => `    ${l}`)].join('\n');
}

/** The maturity report of the repository, stored as cards when it can be: a store that fails leaves init to finish, and says so. */
async function printMaturity(d: InitDeps, projectId: string, report: MaturityReport, dashboard: string): Promise<void> {
  let stored: StoredCards | undefined;
  let failure: string | undefined;
  if (d.storeCards) {
    try {
      stored = await d.storeCards(projectId, report);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
  }
  // Read once: the report walks the repository.
  const cards: PrintedCard[] = stored?.cards ?? report();
  d.io.print(['', `${MATURITY_HEADER}${dashboard}/#maturity`, ...cards.map(cardLine)].join('\n'));
  if (stored) d.io.print(`Cards stored in ${stored.where}.`);
  if (failure !== undefined) d.io.print(`Cards not stored (${failure}): run factory init again once the database is reachable.`);
}

/**
 * The maturity cards in the instance's store (ORC-410), opened for the write and closed: Postgres brought to the latest
 * migration first, as init may run before the daemon ever did.
 */
export async function instanceCards(projectId: string, report: MaturityReport): Promise<StoredCards> {
    const store = await openStore({ env: process.env, migrationsFolder: join(repoRoot(), 'drizzle') });
    const where = `Postgres (${DATABASE_URL_ENV})`;
    try {
      return { cards: await storeReport(store, projectId, report, Date.now()), where };
    } finally {
      await store.close();
    }
  };

/** Stores a project's maturity report, its `main` from the last dry run on its default branch (ORC-408), and reads it back. */
export async function storeReport(store: Pick<Store, 'lastDryRun' | 'putMaturityCards' | 'maturityCards'>, projectId: string, report: MaturityReport, now: number): Promise<MaturityCard[]> {
  await store.putMaturityCards(projectId, report(await store.lastDryRun(projectId)), now);
  return store.maturityCards(projectId);
}

/** What `init` says, and asks nothing of Linear, without a public URL nor `--dev` (ORC-411): Smee is for a workstation only. */
export const NO_PUBLIC_URL = [
  '',
  "No public URL for Linear's webhooks: set publicUrl in config.yaml (the server's HTTPS URL, or a tunnel's) and run init again,",
  'or, on a workstation, `factory init --dev` for a smee.io relay. The Linear application is asked then.',
  '',
].join('\n');

/** The App's repository permissions, those of docs/github-app-manifest.json (checked by init.test.ts), by their name on GitHub's form. */
export const GITHUB_APP_PERMISSIONS = { contents: 'write', pull_requests: 'write', checks: 'write', statuses: 'read', actions: 'read', metadata: 'read' };
/** Not in the manifest, added by hand when `dashboard` in factory.yml names an `org` or a `team` (ORC-399, docs/github.md): GitHub answers a membership only then. */
export const GITHUB_APP_OPTIONAL_PERMISSIONS = { members: 'read' };
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
        `   - Webhook (optional, else the factory polls the PRs every 30 s): active, URL ${publicUrl}/webhooks/github, secret: a random value;`,
        '     then add `webhook_secret: env:GH_WEBHOOK_SECRET` under github in factory.yml, and export GH_WEBHOOK_SECRET with that value',
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

/**
 * The `factory.yml` `init` writes on a first setup (ORC-411): every secret an `env:NAME` reference, the budgets `factory
 * validate` accepts for a first run (docs/first-run.md), to tune afterwards. No `github` when config.yaml has its App: the
 * file's would replace it, field by field (`effectiveInstance`). No GitHub webhook secret: the App's webhook is optional, and
 * an unset variable would stop the daemon.
 */
function factoryYml(withGithub: boolean): { text: string; env: Record<string, string> } {
  // Each variable the file references, with what it is to hold: the references and the `export` lines from one list.
  const env: Record<string, string> = {};
  const ref = (name: string, holds: string) => ((env[name] = holds), `env:${name}`);
  const yml = {
    ...(withGithub ? { github: { app_id: ref('GH_APP_ID', '<App ID>'), private_key: ref('GH_APP_KEY', '<path of the .pem>') } } : {}),
    claude: { runtime: 'claude-code', accounts: [{ name: 'main', token: ref('CLAUDE_CODE_OAUTH_TOKEN', '<token of claude setup-token>') }], active: 'main', default_model: SONNET },
    budgets: { per_step_tokens: 'off', per_ticket_tokens: 5_000_000 },
  };
  return { text: `# Written by factory init: every secret is a reference, read from the daemon's environment.\n${stringify(yml)}`, env };
}

/**
 * Linear's OAuth application: what to create, then its three values, in `secrets.json`. An empty answer keeps the stored value
 * (ORC-83), as long as the client ID is the same: another application's secrets would fail its OAuth and its webhooks.
 */
async function askLinear(io: InitIO, home: string, secrets: ReturnType<typeof loadSecrets>, urls: { callback: string; webhook: string }): Promise<void> {
  io.print(
    [
      '',
      '1. In Linear: Settings → API → OAuth applications → New application.',
      `   - Name: ${PRODUCT_NAME} (the name you will mention with @)`,
      `   - Callback URL: ${urls.callback}`,
      '   - Check "Webhooks", URL:',
      `     ${urls.webhook}`,
      '   - Categories: Agent session events, Issues, Comments',
      '2. Create the application, then paste the client ID, the client secret and the webhook signing secret below.',
      '',
    ].join('\n'),
  );
  const clientId = (await io.ask('Client ID', secrets.linear?.clientId)).trim();
  const stored = secrets.linear?.clientId === clientId ? secrets.linear : undefined;
  const keep = (value: string | undefined) => (value ? ' (empty: keep the current one)' : '');
  const clientSecret = (await io.ask(`Client secret${keep(stored?.clientSecret)}`)).trim() || stored?.clientSecret || '';
  let webhookSecret: string;
  for (;;) {
    webhookSecret = (await io.ask(`Webhook signing secret${keep(stored?.webhookSecret)}`)).trim() || stored?.webhookSecret || '';
    if (isUsableWebhookSecret(webhookSecret)) break;
    io.print(`The webhook signing secret is required: without it, ${PRODUCT_NAME} refuses every webhook.`);
  }
  // Linear's OAuth tokens stay with their application.
  saveSecrets(home, { ...secrets, linear: { ...stored, clientId, clientSecret, webhookSecret } });
}

export async function runInit(d: InitDeps): Promise<void> {
  const { io } = d;
  const top = await d.exec('git', ['rev-parse', '--show-toplevel'], { cwd: d.cwd });
  // One form whatever gave the path: git writes `C:/x` on Windows, a typed one may be relative or end with `/`.
  const repoPath = resolve(top.code === 0 ? top.stdout.trim() : await io.ask(`Path of the git repository to hand to ${PRODUCT_NAME}`));
  // Read first: a secrets.json encrypted at rest (ORC-398) stops init before it asks anything.
  const secrets = loadSecrets(d.home);
  const cfg = loadInstance(d.home);
  const ymlPath = join(d.home, 'factory.yml');
  // A first setup gets its factory.yml; an instance that runs without one keeps running as it does (ORC-411). Without Linear's
  // application it never ran.
  const firstSetup = !secrets.linear;
  const previous = cfg.projects.find((p) => samePath(p.repoPath, repoPath));
  // An empty answer keeps what is there (ORC-83): the project's team key, the stored Linear values.
  const teamKey = (await io.ask('Linear team key (e.g. REL)', previous?.linearTeamKey)).toUpperCase();

  // The project's other fields (its roles, written by hand) stay.
  const id = previous?.id ?? slugify(basename(repoPath), 30);
  cfg.projects = [...cfg.projects.filter((p) => !samePath(p.repoPath, repoPath)), { ...previous, id, repoPath, linearTeamKey: teamKey }];
  // Smee only on demand (ORC-411): a public channel, for a workstation; a server has its public URL, and --dev changes nothing
  // there, even beside an old channel. The development mode is what --dev writes (ORC-444): the daemon's leave to start the
  // relay, a channel written before included.
  if (d.dev && !cfg.publicUrl) {
    if (cfg.relay.kind === 'none') cfg.relay = { kind: 'smee', url: await d.createSmee() };
    cfg.dev = true;
  }
  const webhook = cfg.publicUrl ? `${cfg.publicUrl}/webhooks/linear` : cfg.relay.kind === 'smee' ? cfg.relay.url : undefined;
  if (webhook) await askLinear(io, d.home, secrets, { callback: `${cfg.publicUrl ?? `http://localhost:${cfg.port}`}/oauth/callback`, webhook });
  // Linear signs its webhook secret only once it has the webhook's URL: no value to ask yet.
  else io.print(NO_PUBLIC_URL);

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
  // The maturity report (ORC-410): each point the same detection read, as a card to approve, over a repository `init` proposes.
  // After config.yaml: a database that fails loses none of the answers.
  if (detected) await printMaturity(d, id, (run) => maturityReport(repoPath, detected, run), cfg.publicUrl ?? `http://localhost:${cfg.port}`);
  if (existsSync(ymlPath)) {
    io.print(`${ymlPath} kept as it is.`);
  } else if (firstSetup) {
    // An App config.yaml already has is set up: its steps would only add noise.
    if (!cfg.github) io.print(githubAppSteps(cfg.publicUrl, d.home));
    const written = factoryYml(!cfg.github);
    writeFileSync(ymlPath, written.text, { flag: 'wx' });
    io.print(
      [
        `Wrote ${ymlPath}: its secrets are references; export them in the shell of \`factory up\` and \`factory doctor\`, which refuse to start without them:`,
        ...Object.entries(written.env).map(([name, holds]) => `  export ${name}=${holds}`),
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
