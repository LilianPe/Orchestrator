import { parse } from 'yaml';
import { z } from 'zod';
import { SECRET_NAME } from '../adapters/runner/transcript.js';
import type { NetworkLevel } from '../adapters/sandbox/types.js';
import { isPackageName, type AllowList } from '../checks/deps.js';
import { MaxDiffConfigError, repoMaxDiff, type MaxDiff } from '../checks/diff-size.js';
import { FORBIDDEN_PATHS, repoPatternError } from '../checks/forbidden-paths.js';

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
  /**
   * The `sensitive_paths` entries that name no path of the repository (ORC-338), left out of `sensitivePaths`: reported by
   * `factory validate` and the daemon's log, and an untrusted branch is refused on them. Absent when there is none.
   */
  sensitivePathWarnings?: string[];
  /** Paths the agent never writes: the socle's, which no configuration removes. */
  forbiddenPaths: string[];
  /** The bounds the repository's `max_diff` sets, and only those: `verify` resolves them on the base, or on none under factory.yml's `max_diff: off` (ORC-381). */
  maxDiff: Partial<MaxDiff>;
  network: { level: RepoNetworkLevel; allow: string[] };
  budgets?: { perTicketTokens?: number };
  featureFlags?: { provider: string };
  visualPaths: string[];
  /** The packages a branch may add (`factory/dependances`, ORC-371): exact names per ecosystem, none allowed where there is no list. */
  dependencies: { allow: AllowList };
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

/**
 * The ticket's token cap (ORC-340, ORC-216): factory.yml's, lowered by the repository's, never raised. Undefined without
 * either. factory.yml's `off` (ORC-381) leaves the repository's own.
 */
export function ticketTokenCap(factoryCap: number | 'off' | undefined, config: RepoConfig): number | undefined {
  const caps = [factoryCap === 'off' ? undefined : factoryCap, config.budgets?.perTicketTokens].filter((c) => c !== undefined);
  return caps.length ? Math.min(...caps) : undefined;
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
    super(`.factory/config.yml refused:\n- ${violations.join('\n- ')}`);
  }
}

const KEYS = ['extends', 'setup', 'commands', 'env', 'setup_secrets', 'services', 'sensitive_paths', 'budgets', 'max_diff', 'feature_flags', 'visual_paths', 'network', 'dependencies'];
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
    throw new RepoConfigError([`unreadable YAML: ${(err as Error).message}`]);
  }
  raw ??= {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RepoConfigError(['a YAML object is expected']);
  const r = raw as Record<string, unknown>;
  const violations: string[] = [];
  // `expected` for the value as a whole, `element` for one of its entries, named by its path (`sensitive_paths[1]`).
  const read = <T>(key: string, schema: z.ZodType<T>, expected: string, element = expected): T | undefined => {
    if (r[key] === undefined || r[key] === null) return undefined;
    const res = schema.safeParse(r[key]);
    if (res.success) return res.data;
    const path = res.error.issues[0]?.path ?? [];
    violations.push(path.length === 0 ? `${key}: ${expected}` : `${key}${at(path)}: ${element}`);
    return undefined;
  };

  if (r['extends'] !== undefined && r['extends'] !== null && r['extends'] !== PRESET) violations.push(`extends: only \`${PRESET}\` exists in the MVP`);
  for (const key of Object.keys(r)) {
    if (!KEYS.includes(key)) violations.push(`${key}: unknown key; the repository configuration adds checks or prohibitions, it never removes any from the baseline`);
  }
  const setup = read('setup', z.string().min(1), 'a command is expected');
  const commands = read('commands', z.record(z.string(), z.string().min(1)), 'an object `name: command` is expected', 'a non-empty command is expected');
  const env = read('env', strings, 'an array of variable names is expected', 'a non-empty variable name is expected');
  const setupSecrets = read('setup_secrets', strings, 'an array of variable names is expected', 'a non-empty variable name is expected');
  for (const [key, names] of [['env', env], ['setup_secrets', setupSecrets]] as const) {
    names?.forEach((name, i) => {
      if (!VARIABLE.test(name)) violations.push(`${key}[${i}]: "${name}" is not a variable name (capitals, digits, _)`);
      else if (RESERVED.test(name)) violations.push(`${key}[${i}]: "${name}" is reserved for the factory`);
      else if (key === 'env' && SECRET_NAME.test(name)) violations.push(`${key}[${i}]: "${name}" has the name of a secret, which the agent would see; a secret is declared under setup_secrets`);
      else if (key === 'env' && setupSecrets?.includes(name)) violations.push(`${key}[${i}]: "${name}" is also under setup_secrets, which the agent must not see`);
    });
  }
  const services = read('services', strings, 'an array is expected', 'a non-empty service name is expected');
  const sensitivePaths = read('sensitive_paths', strings, 'an array of paths is expected', 'a non-empty path is expected');
  const visualPaths = read('visual_paths', strings, 'an array of paths is expected', 'a non-empty path is expected');
  const sensitiveWarnings: string[] = [];
  const enforced: string[] = [];
  for (const [key, paths] of [['sensitive_paths', sensitivePaths], ['visual_paths', visualPaths]] as const) {
    paths?.forEach((p, i) => {
      // Enforced at `checkClone` (ORC-338): a pattern that names nothing of the repository would protect nothing.
      const outside = key === 'sensitive_paths' ? repoPatternError(p) : undefined;
      // Anywhere in the pattern: `!x` and the extglob `src/!(auth)/**` both carve a hole.
      if (p.includes('!')) violations.push(`${key}[${i}]: "${p}" would remove a path; paths can only be added`);
      // A warning, not a refusal: a file that passed before ORC-338 keeps its trusted tickets going; an untrusted branch is refused on it (`checkBranchPaths`).
      else if (outside) sensitiveWarnings.push(`${key}[${i}]: "${p}": ${outside}`);
      else if (key === 'sensitive_paths') enforced.push(p);
    });
  }
  // `off` is factory.yml's alone (ORC-381): said as such, rather than as a malformed value.
  if (r['budgets'] === 'off' || (r['budgets'] as Record<string, unknown> | null | undefined)?.['per_ticket_tokens'] === 'off') {
    violations.push("budgets: `off` is refused here: only factory.yml, the server's configuration, disables a token cap; the repository configuration can only lower `per_ticket_tokens`.");
    delete r['budgets'];
  }
  const budgets = read('budgets', z.strictObject({ per_ticket_tokens: z.number().int().positive().optional() }), '`{ per_ticket_tokens }` positive integer expected');
  const featureFlags = read('feature_flags', z.strictObject({ provider: z.string().min(1) }), '`{ provider }` expected');
  const network = networkOf(r['network'], violations);
  const dependencies = read('dependencies', z.strictObject({ allow: z.strictObject({ npm: strings.optional(), pypi: strings.optional() }) }), '`{ allow: { npm, pypi } }` expected', 'lists of exact package names under `npm` and `pypi` expected');
  for (const ecosystem of ['npm', 'pypi'] as const) {
    // A pattern would be a rule of its own, which the MVP doc does not have (ORC-165); a name that is none would match nothing.
    dependencies?.allow[ecosystem]?.forEach((name, i) => {
      if (!isPackageName(ecosystem, name)) violations.push(`dependencies.allow.${ecosystem}[${i}]: "${name}" is not an exact package name; patterns are refused`);
    });
  }
  let maxDiff: Partial<MaxDiff> = {};
  try {
    maxDiff = repoMaxDiff(r['max_diff'] as Partial<MaxDiff> | null | undefined);
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
    sensitivePaths: enforced,
    ...(sensitiveWarnings.length ? { sensitivePathWarnings: sensitiveWarnings } : {}),
    forbiddenPaths: [...SOCLE_FORBIDDEN_PATHS],
    maxDiff,
    network,
    ...(budgets ? { budgets: budgets.per_ticket_tokens === undefined ? {} : { perTicketTokens: budgets.per_ticket_tokens } } : {}),
    ...(featureFlags ? { featureFlags } : {}),
    visualPaths: visualPaths ?? [],
    dependencies: { allow: dependencies?.allow ?? {} },
  };
}

function networkOf(raw: unknown, violations: string[]): RepoConfig['network'] {
  const network: RepoConfig['network'] = { level: 'limited', allow: [] };
  if (raw === undefined || raw === null) return network;
  const res = z.strictObject({ level: z.string().optional(), allow: strings.optional() }).safeParse(raw);
  if (!res.success) {
    violations.push('network: `{ level, allow }` expected');
    return network;
  }
  const { level, allow } = res.data;
  if (level === 'full') violations.push('network.level: `full` is reserved for `setup`, never for the agent');
  else if (level !== undefined && level !== 'none' && level !== 'limited' && level !== 'custom') violations.push(`network.level: unknown "${level}" (none, limited, custom)`);
  else if (level) network.level = level;
  allow?.forEach((host, i) => {
    if (!HOST.test(host)) violations.push(`network.allow[${i}]: "${host}" is not a host name; wildcards and ranges are refused`);
  });
  if (allow) network.allow = allow;
  // Only `custom` opens its hosts (`stepPolicy`): a list under another level would pass validation and open nothing.
  if (allow?.length && (level === undefined || level === 'none' || level === 'limited')) violations.push(`network.allow: only the \`custom\` level takes a list of hosts; here \`${level ?? 'limited'}\``);
  return network;
}
