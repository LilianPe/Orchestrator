import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { Exec } from '../adapters/exec.js';
import { isRecord } from '../adapters/graphql-pages.js';
import { isUsableWebhookSecret } from '../adapters/tracker/linear/webhook.js';
import { homePaths, loadInstance, loadSecrets, saveInstance, saveSecrets } from '../config/instance.js';
import { makeRepoConfig } from '../app/repo-variables.js';
import { ignoredWorkflowFiles, ignoredWorkflowWarning, REPO_CONFIG_PATH, testCommandWarnings } from '../config/repo-config.js';
import { repoRoot } from '../app/root.js';
import { slugify } from '../core/naming.js';
import { PRODUCT_NAME } from '../product.js';
import { openStore } from '../store/open.js';
import type { MaturityCard, MaturityPoint } from '../store/types.js';
import { maturityReport, type DetectedChecks } from './maturity.js';

export interface InitIO {
  ask(q: string, def?: string): Promise<string>;
  print(s: string): void;
}

export interface InitDeps {
  io: InitIO;
  home: string;
  cwd: string;
  createSmee: () => Promise<string>;
  exec: Exec;
  /** Stores the maturity cards of a detection (ORC-410) and gives them back as stored, approvals kept: absent, none is stored. */
  storeCards?: (projectId: string, points: readonly MaturityPoint[]) => Promise<MaturityCard[]>;
}

/** What `init` proposes for a repository's `.factory/config.yml`: its install, its checks by name, and what starts the application. */
type Detected = DetectedChecks;

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

/** What `init` prints before the maturity cards (ORC-410), followed by the dashboard page where a person approves them. */
export const MATURITY_HEADER = 'Maturity report, one card per point to approve on the dashboard: ';

/** A card as init prints it: approved or not, its value under its title, a value of several lines indented. */
function cardLine(c: MaturityPoint & { approvedBy?: string }): string {
  const status = c.approvedBy === undefined ? '[to approve]' : `[approved by ${c.approvedBy}]`;
  const lines = c.value.split('\n');
  return lines.length === 1 ? `  ${status} ${c.title}: ${c.value}` : [`  ${status} ${c.title}:`, ...lines.map((l) => `    ${l}`)].join('\n');
}

/** The maturity report of the repository, stored as cards when it can be: a store that fails leaves init to finish, and says so. */
async function printMaturity(d: InitDeps, projectId: string, points: MaturityPoint[], dashboard: string): Promise<void> {
  let cards: (MaturityPoint & { approvedBy?: string })[] = points;
  let failure: string | undefined;
  if (d.storeCards) {
    try {
      cards = await d.storeCards(projectId, points);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
  }
  d.io.print(['', `${MATURITY_HEADER}${dashboard}/#maturity`, ...cards.map(cardLine)].join('\n'));
  if (failure !== undefined) d.io.print(`Cards not stored (${failure}): run factory init again once the database is reachable.`);
}

/**
 * The maturity cards in the instance's store (ORC-410), opened for the write and closed: Postgres brought to the latest
 * migration first, as init may run before the daemon ever did.
 */
export const instanceCards =
  (home: string) =>
  async (projectId: string, points: readonly MaturityPoint[]): Promise<MaturityCard[]> => {
    const { store } = await openStore({ env: process.env, sqlitePath: homePaths(home).db, migrationsFolder: join(repoRoot(), 'drizzle') });
    try {
      await store.putMaturityCards(projectId, points, Date.now());
      return await store.maturityCards(projectId);
    } finally {
      await store.close();
    }
  };

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
  // Read first: a secrets.json encrypted at rest (ORC-398) stops init before it asks anything.
  const secrets = loadSecrets(d.home);
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
  const keepTokens = secrets.linear?.clientId === clientId ? secrets.linear : {};
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
  // The maturity report (ORC-410): each point the same detection read, as a card to approve, over a repository `init` proposes.
  if (detected) await printMaturity(d, id, maturityReport(repoPath, detected), cfg.publicUrl ?? `http://localhost:${cfg.port}`);

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
