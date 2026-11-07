import { parse } from 'yaml';
import { z } from 'zod';
import { SECRET_NAME } from '../adapters/runner/transcript.js';
import type { NetworkLevel } from '../adapters/sandbox/types.js';
import { MaxDiffConfigError, resolveMaxDiff, type MaxDiff } from '../checks/diff-size.js';
import { FORBIDDEN_PATHS } from '../checks/forbidden-paths.js';

/**
 * `.factory/config.yml` (ORC-209): what a repository declares to the factory, optional. It can add controls or
 * forbidden paths, never take one from the socle: `max_diff` only tightens, `network.level: full` is refused, a
 * negated path is refused, and an unknown key (a `checks.disable`, say) is refused rather than ignored.
 */
export interface RepoConfig {
  extends: typeof PRESET;
  setup?: string;
  commands: Record<string, string>;
  /** Names of the variables the runner gets, setup and agent (ORC-211): the values are the server's (`factory.yml`), never here. */
  env: string[];
  /** Names of the secrets the `setup` alone gets, sealed before the agent starts (ORC-211). */
  setupSecrets: string[];
  services: string[];
  sensitivePaths: string[];
  /** Paths the agent never writes: the socle's, which no configuration removes. */
  forbiddenPaths: string[];
  maxDiff: MaxDiff;
  network: { level: RepoNetworkLevel; allow: string[] };
  budgets?: { perTicketTokens?: number };
  featureFlags?: { provider: string };
  visualPaths: string[];
}

/** The repository picks its level; `full` is reserved to `setup`, never for the agent. */
export type RepoNetworkLevel = 'none' | 'limited' | 'custom';

/**
 * The repository's level as the preset's steps are checked against (`compilePreset({ repoNetwork })`): `custom`
 * is `limited` with the repository's own hosts, so its ceiling is `limited`.
 */
export function repoNetworkCeiling(config: RepoConfig): NetworkLevel {
  return config.network.level === 'none' ? 'none' : 'limited';
}

/** A host name: no wildcard, no range, no path (a `*` or a `0.0.0.0/0` would be `full` in disguise). */
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/** The one name the factory reads, at the repository's root: a file in a directory, neither a link. */
export const REPO_CONFIG_DIR = '.factory';
export const REPO_CONFIG_PATH = `${REPO_CONFIG_DIR}/config.yml`;

/** How the daemon reads it on the default branch. `fetch: false`: the forge was just fetched, or the read follows the launch's. */
export interface RepoConfigRead {
  fetch?: boolean;
}

const PRESET = 'factory/default@1.0';
/** The factory's own configuration: the agent never edits what verifies it. */
export const SOCLE_FORBIDDEN_PATHS: readonly string[] = FORBIDDEN_PATHS;

export class RepoConfigError extends Error {
  constructor(readonly violations: string[]) {
    super(`.factory/config.yml refusé :\n- ${violations.join('\n- ')}`);
  }
}

const KEYS = ['extends', 'setup', 'commands', 'env', 'setup_secrets', 'services', 'sensitive_paths', 'budgets', 'max_diff', 'feature_flags', 'visual_paths', 'network'];
const strings = z.array(z.string().min(1));

const VARIABLE = /^[A-Z][A-Z0-9_]*$/;
/**
 * What a repository never hands the runner, whatever the server gives: the sandbox's egress and trust,
 * what runs code in all its processes, the agent's identity, the factory's and the forge's own, and what
 * the `setup` is hardened with (`setupEnv`).
 */
const RESERVED = new RegExp(
  '^(' +
    [
      'HOME', 'USER', 'SHELL', 'PWD', 'PATH', 'PORT', 'ENV', 'BASH_ENV', 'LD_.*', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP',
      '(HTTP|HTTPS|ALL|NO|FTP)_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_.*', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
      'ANTHROPIC_.*', 'CLAUDE.*', 'DISABLE_TELEMETRY', 'FACTORY_.*', 'RELAIS_.*', 'LINEAR_.*', 'GH_.*', 'GITHUB_.*', 'GIT_.*', // RELAIS_ : transition, à retirer (ORC-167)
      'NPM_CONFIG_.*', 'YARN_.*', 'PIP_.*', 'UV_.*',
    ].join('|') +
    ')$',
);

const at = (path: PropertyKey[]): string => path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('');

/** Validates a `.factory/config.yml` (undefined: no file) and merges it over the socle; throws a RepoConfigError listing every violation. */
export function parseRepoConfig(text: string | undefined): RepoConfig {
  let raw: unknown;
  try {
    raw = text === undefined ? null : parse(text);
  } catch (err) {
    throw new RepoConfigError([`YAML illisible : ${(err as Error).message}`]);
  }
  raw ??= {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RepoConfigError(['un objet YAML est attendu']);
  const r = raw as Record<string, unknown>;
  const violations: string[] = [];
  // `expected` for the value as a whole, `element` for one of its entries, named by its path (`sensitive_paths[1]`).
  const read = <T>(key: string, schema: z.ZodType<T>, expected: string, element = expected): T | undefined => {
    if (r[key] === undefined || r[key] === null) return undefined;
    const res = schema.safeParse(r[key]);
    if (res.success) return res.data;
    const path = res.error.issues[0]?.path ?? [];
    violations.push(path.length === 0 ? `${key} : ${expected}` : `${key}${at(path)} : ${element}`);
    return undefined;
  };

  if (r['extends'] !== undefined && r['extends'] !== null && r['extends'] !== PRESET) violations.push(`extends : seul \`${PRESET}\` existe au MVP`);
  for (const key of Object.keys(r)) {
    if (!KEYS.includes(key)) violations.push(`${key} : clé inconnue ; la configuration du dépôt ajoute des contrôles ou des interdits, elle n’en retire jamais au socle`);
  }
  const setup = read('setup', z.string().min(1), 'une commande est attendue');
  const commands = read('commands', z.record(z.string(), z.string().min(1)), 'un objet `nom: commande` est attendu', 'une commande non vide est attendue');
  const env = read('env', strings, 'un tableau de noms de variables est attendu', 'un nom de variable non vide est attendu');
  const setupSecrets = read('setup_secrets', strings, 'un tableau de noms de variables est attendu', 'un nom de variable non vide est attendu');
  for (const [key, names] of [['env', env], ['setup_secrets', setupSecrets]] as const) {
    names?.forEach((name, i) => {
      if (!VARIABLE.test(name)) violations.push(`${key}[${i}] : « ${name} » n’est pas un nom de variable (majuscules, chiffres, _)`);
      else if (RESERVED.test(name)) violations.push(`${key}[${i}] : « ${name} » est réservé à l’usine`);
      else if (key === 'env' && SECRET_NAME.test(name)) violations.push(`${key}[${i}] : « ${name} » a le nom d’un secret, que l’agent verrait ; un secret se déclare sous setup_secrets`);
      else if (key === 'env' && setupSecrets?.includes(name)) violations.push(`${key}[${i}] : « ${name} » est aussi sous setup_secrets, que l’agent ne doit pas voir`);
    });
  }
  const services = read('services', strings, 'un tableau est attendu', 'un nom de service non vide est attendu');
  const sensitivePaths = read('sensitive_paths', strings, 'un tableau de chemins est attendu', 'un chemin non vide est attendu');
  const visualPaths = read('visual_paths', strings, 'un tableau de chemins est attendu', 'un chemin non vide est attendu');
  for (const [key, paths] of [['sensitive_paths', sensitivePaths], ['visual_paths', visualPaths]] as const) {
    paths?.forEach((p, i) => {
      // Anywhere in the pattern: `!x` and the extglob `src/!(auth)/**` both carve a hole.
      if (p.includes('!')) violations.push(`${key}[${i}] : « ${p} » retirerait un chemin ; on ne peut qu’en ajouter`);
    });
  }
  const budgets = read('budgets', z.strictObject({ per_ticket_tokens: z.number().int().positive().optional() }), '`{ per_ticket_tokens }` entier positif attendu');
  const featureFlags = read('feature_flags', z.strictObject({ provider: z.string().min(1) }), '`{ provider }` attendu');
  const network = networkOf(r['network'], violations);
  let maxDiff = resolveMaxDiff();
  try {
    maxDiff = resolveMaxDiff(r['max_diff'] as Partial<MaxDiff> | null | undefined);
  } catch (err) {
    if (!(err instanceof MaxDiffConfigError)) throw err;
    violations.push(err.message);
  }

  if (violations.length > 0) throw new RepoConfigError(violations);
  return {
    extends: PRESET,
    ...(setup ? { setup } : {}),
    commands: commands ?? {},
    env: env ?? [],
    setupSecrets: setupSecrets ?? [],
    services: services ?? [],
    sensitivePaths: sensitivePaths ?? [],
    forbiddenPaths: [...SOCLE_FORBIDDEN_PATHS],
    maxDiff,
    network,
    ...(budgets ? { budgets: budgets.per_ticket_tokens === undefined ? {} : { perTicketTokens: budgets.per_ticket_tokens } } : {}),
    ...(featureFlags ? { featureFlags } : {}),
    visualPaths: visualPaths ?? [],
  };
}

function networkOf(raw: unknown, violations: string[]): RepoConfig['network'] {
  const network: RepoConfig['network'] = { level: 'limited', allow: [] };
  if (raw === undefined || raw === null) return network;
  const res = z.strictObject({ level: z.string().optional(), allow: strings.optional() }).safeParse(raw);
  if (!res.success) {
    violations.push('network : `{ level, allow }` attendu');
    return network;
  }
  const { level, allow } = res.data;
  if (level === 'full') violations.push('network.level : `full` est réservé à `setup`, jamais pour l’agent');
  else if (level !== undefined && level !== 'none' && level !== 'limited' && level !== 'custom') violations.push(`network.level : « ${level} » inconnu (none, limited, custom)`);
  else if (level) network.level = level;
  allow?.forEach((host, i) => {
    if (!HOST.test(host)) violations.push(`network.allow[${i}] : « ${host} » n’est pas un nom d’hôte ; les jokers et les plages sont refusés`);
  });
  if (allow) network.allow = allow;
  // Only `custom` opens its hosts (`stepPolicy`): a list under another level would pass validation and open nothing.
  if (allow?.length && (level === undefined || level === 'none' || level === 'limited')) violations.push(`network.allow : seul le niveau \`custom\` prend une liste d’hôtes ; ici \`${level ?? 'limited'}\``);
  return network;
}
