import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Exec } from '../adapters/exec.js';
import { isUsableWebhookSecret } from '../adapters/tracker/linear/webhook.js';
import { stringify } from 'yaml';
import { loadInstance, loadSecrets, saveInstance, saveSecrets } from '../config/instance.js';
import { REPO_CONFIG_PATH } from '../config/repo-config.js';
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
  createSmee: () => Promise<string>;
  exec: Exec;
}

/** What `init` proposes for a repository's `.factory/config.yml`: its install, and its checks by name. */
interface Detected {
  setup: string[];
  commands: Record<string, string>;
}

/** npm, or pnpm when its lockfile is the only one: the scripts `lint`, `typecheck` and `test` the repository has. */
function detectNode(repo: string): Detected {
  const pkgFile = join(repo, 'package.json');
  if (!existsSync(pkgFile)) return { setup: [], commands: {} };
  const scripts = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  const npmLock = existsSync(join(repo, 'package-lock.json'));
  const pnpm = !npmLock && existsSync(join(repo, 'pnpm-lock.yaml'));
  const pm = pnpm ? 'pnpm' : 'npm';
  const setup = pnpm ? ['pnpm install --frozen-lockfile'] : npmLock ? ['npm ci'] : [];
  const commands = Object.fromEntries(['lint', 'typecheck', 'test'].filter((s) => scripts[s]).map((s) => [s, `${pm} ${s === 'test' ? 'test' : `run ${s}`}`]));
  return { setup, commands };
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

/** Both when the repository has both. */
function detect(repo: string): Detected {
  const node = detectNode(repo);
  const python = detectPython(repo);
  return { setup: [...node.setup, ...python.setup], commands: { ...node.commands, ...python.commands } };
}

/** What `init` prints before the `.factory/config.yml` it proposes (ORC-388): it writes nothing in the repository. */
export const PROPOSAL_HEADER = `Proposed ${REPO_CONFIG_PATH}, to commit on the default branch (init writes nothing in the repository):
`;

/** The repository's `.factory/config.yml`, as `init` detects it: none when it detects nothing. */
function proposal({ setup, commands }: Detected): string | undefined {
  if (!setup.length && !Object.keys(commands).length) return undefined;
  return PROPOSAL_HEADER + stringify({ ...(setup.length ? { setup: setup.join(' && ') } : {}), ...(Object.keys(commands).length ? { commands } : {}) });
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

  // The workflow is the factory/default preset (ORC-388): the repository's part is its `.factory/config.yml`, read on the
  // default branch, which `init` proposes and leaves to commit.
  const proposed = proposal(detect(repoPath));
  if (proposed) io.print(proposed);

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
