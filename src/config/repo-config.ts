import { parse } from 'yaml';
import { z } from 'zod';
import { MaxDiffConfigError, resolveMaxDiff, type MaxDiff } from '../checks/diff-size.js';

/**
 * `.factory/config.yml` (ORC-209): what a repository declares to the factory, optional. It can add controls or
 * forbidden paths, never take one from the socle: `max_diff` only tightens, `network.level: full` is refused, a
 * negated path is refused, and an unknown key (a `checks.disable`, say) is refused rather than ignored.
 */
export interface RepoConfig {
  extends: typeof PRESET;
  setup?: string;
  commands: Record<string, string>;
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

const PRESET = 'factory/default@1.0';
/** The factory's own configuration: the agent never edits what verifies it. */
export const SOCLE_FORBIDDEN_PATHS: readonly string[] = Object.freeze(['.factory/**']);

export class RepoConfigError extends Error {
  constructor(readonly violations: string[]) {
    super(`.factory/config.yml refusé :\n- ${violations.join('\n- ')}`);
  }
}

const KEYS = ['extends', 'setup', 'commands', 'services', 'sensitive_paths', 'budgets', 'max_diff', 'feature_flags', 'visual_paths', 'network'];
const strings = z.array(z.string().min(1));

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
  const read = <T>(key: string, schema: z.ZodType<T>, expected: string): T | undefined => {
    if (r[key] === undefined || r[key] === null) return undefined;
    const res = schema.safeParse(r[key]);
    if (res.success) return res.data;
    violations.push(`${key} : ${expected}`);
    return undefined;
  };

  if (r['extends'] !== undefined && r['extends'] !== PRESET) violations.push(`extends : seul \`${PRESET}\` existe au MVP`);
  for (const key of Object.keys(r)) {
    if (!KEYS.includes(key)) violations.push(`${key} : clé inconnue ; la configuration du dépôt ajoute des contrôles ou des interdits, elle n’en retire jamais au socle`);
  }
  const setup = read('setup', z.string().min(1), 'une commande est attendue');
  const commands = read('commands', z.record(z.string(), z.string().min(1)), 'un objet `nom: commande` est attendu');
  const services = read('services', strings, 'un tableau est attendu');
  const sensitivePaths = read('sensitive_paths', strings, 'un tableau de chemins est attendu');
  const visualPaths = read('visual_paths', strings, 'un tableau de chemins est attendu');
  for (const [key, paths] of [['sensitive_paths', sensitivePaths], ['visual_paths', visualPaths]] as const) {
    paths?.forEach((p, i) => {
      if (p.startsWith('!')) violations.push(`${key}[${i}] : « ${p} » retirerait un chemin ; on ne peut qu’en ajouter`);
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
    violations.push(`max_diff : ${err.message}`);
  }

  if (violations.length > 0) throw new RepoConfigError(violations);
  return {
    extends: PRESET,
    ...(setup ? { setup } : {}),
    commands: commands ?? {},
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
  if (allow) network.allow = allow;
  return network;
}
