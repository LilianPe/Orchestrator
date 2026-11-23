import { readFileSync } from 'node:fs';
import { validateHeaderValue } from 'node:http';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ENV_NAME } from '../adapters/secrets/env.js';
import { kindOf, SECRET_SOURCE_KINDS, type SecretSourceDecl } from '../adapters/secrets/registry.js';
import { refText, type SecretRef, type SecretSourceKind } from '../adapters/secrets/types.js';
import { MAX_DIFF } from '../checks/diff-size.js';
import { MIN_SECRETS_KEY_LENGTH } from './secrets-file.js';
import { READ_CAPS, type ReadCaps } from '../network/reads.js';
import { GITHUB_LOGIN, type DashboardAccess } from '../adapters/forge/github-login.js';
import { isRecord } from '../adapters/graphql-pages.js';
import type { Effort } from '../presets/preset.js';
import type { StepSettings } from '../presets/workflow.js';

/**
 * A repository (ORC-480), an entry of factory.yml's `repos`: its `id`, the key of its tickets, events and `repo:<id>` labels; its
 * repository on GitHub (`owner/name`), which the daemon fetches into its own mirror (ORC-479); its Linear team; its roles and its
 * kind; and the values of what its `.factory/config.yml` declares (ORC-211), `env` resolved, `secrets` as references read at the
 * setup (ORC-308). No local clone: `projects`, its `repo_path` and the knowledge base's are refused (`oldRepoKeys`).
 */
export interface ProjectConfig {
  id: string;
  github: string;
  linearTeamKey: string;
  /**
   * The roles of a project no source gives (ORC-186), by Linear user id, until `.factory/config.yml` (ORC-209): designated
   * maintainers (`/refreeze`) and spec validators, and the GitHub login of each Linear user whose rights on the repo count
   * (Linear gives none the factory can read).
   */
  authz?: { maintainers: string[]; validators: string[]; githubLogins: Record<string, string> };
  /** `none` (ORC-231): nothing of the project leaves the factory, its effects are kept as artifacts of its runs. */
  effects?: 'none';
  /** The preset its runs follow (ORC-231): `factory/fantome` replays closed tickets, at the Rapide level, always without effects. */
  preset?: typeof FANTOME;
}

/** An entry of `repos` as the daemon reads it: the instance's part, and its `env` and `secrets` (`REPO_DAEMON_KEYS`). */
export type RepoEntry = ProjectConfig & { env?: Record<string, string>; secrets?: Record<string, SecretRef> };

/** The keys of a `repos` entry the daemon alone reads: `loadInstance` leaves them out, `saveInstance` keeps them as the file writes them. */
export const REPO_DAEMON_KEYS = ['env', 'secrets'] as const;

/** The preset of the replay of closed tickets (ORC-231), named here without loading the presets: `isFantome` reads `fantome.name`. */
export const FANTOME = 'factory/fantome';

/** Linear's webhook relay: a smee.io channel on a workstation in the development mode (ORC-444), none on a server. */
export type Relay = z.infer<typeof relaySchema>;

/**
 * `<FACTORY_HOME>/factory.yml` (ORC-209, part B): the server's configuration, required since ORC-199, which retired
 * `config.yaml` into its instance keys (`port`, `host`, `public_url`, `dev`, `relay`, `repos`, `knowledge`). Every secret is
 * a reference `<source>:<path>`, never kept in the file: the server's are read at its start, `env:NAME` from the environment
 * (ORC-398); a repository's at each `setup` (ORC-308).
 * The daemon only reads it; `factory init` writes its instance keys alone (`saveInstance`), the rest of the file kept.
 */
export interface FactoryYml {
  /** The instance (ORC-199): `effectiveInstance` gives each its default. */
  port?: number;
  host?: string;
  publicUrl?: string;
  /** The development mode (ORC-444), written by `factory init --dev` alone: the daemon starts the Smee relay only in it. */
  dev?: boolean;
  relay?: Relay;
  /** The knowledge base's repository on GitHub (ORC-481), `owner/name`: the daemon keeps its own clone of it, `homePaths().knowledge`. */
  knowledge?: { github: string };
  linear?: { clientId?: string; clientSecret?: string; webhookSecret?: string };
  /** `clientId` and `clientSecret`: the App's OAuth client, for the dashboard's GitHub sign-in (ORC-399). */
  github?: { appId: string; privateKey: string; installationId?: string; webhookSecret?: string; clientId?: string; clientSecret?: string };
  /** Who may sign in to the dashboard off the loopback (ORC-399): logins, the members of an org, or of a team. */
  dashboard?: DashboardAccess;
  /** `effort` is applied by `stepSettings` (ORC-136); `accounts` and `active` read again at each launch by `claudeAccountReader` (ORC-215). */
  claude?: {
    runtime: 'claude-code';
    accounts: { name: string; token: string }[];
    active: string;
    defaultModel: string;
    perStep?: Record<string, string>;
    effort?: { default: Effort; perStep?: Record<string, Effort> };
  };
  /** Tickets worked at once: the dev queue's capacity (ORC-203), the only one since the workflow's `parallel_sessions` went (ORC-390). */
  concurrency?: number;
  /**
   * `max_turns` and `per_step_tokens` are applied by `stepSettings` (ORC-136); `per_ticket_tokens` and `on_usage_limit` by the daemon (ORC-340).
   * A token cap `off` is disabled (ORC-381), `budgets: off` both: unlike a cap left unset, `factory validate` accepts it. `on_usage_limit` is no cap of the factory's.
   */
  budgets?: { perStepTokens?: Record<string, number> | 'off'; perTicketTokens?: number | 'off'; maxTurns?: Record<string, number>; onUsageLimit?: 'wait' };
  /** The built-in tools of each agent step, in place of its preset default (ORC-383): checked against the step by `defaultWorkflow`, applied by `stepSettings`. */
  tools?: { perStep?: Record<string, string[]> };
  /** `off` disables the baseline of `factory/taille-du-diff` (ORC-381): only a repository's own `max_diff` bounds its diffs. */
  maxDiff?: 'off';
  /** The repositories (ORC-480): an instance key, but for each entry's `env` and `secrets`, the daemon's alone. */
  repos?: RepoEntry[];
  /** The secret managers a reference may name besides `env` (ORC-308), each validated against its adapter. */
  secretSources?: Record<string, SecretSourceDecl>;
  /** The key `secrets.json` is encrypted with at rest (ORC-398), read through its reference; without it, the file stays in clear. */
  secretsKey?: string;
  /** The reference each server secret is written with, by its key's path (`github.private_key`), for `doctor` and the masking (ORC-398). */
  secretRefs?: Record<string, SecretRef>;
  /** Lines past which the pack's hook refuses a whole read (ORC-279); without it, the hook's own 350. */
  readGuard?: { maxLines: number };
  /**
   * The definition of a serious defect (ORC-153), as written: until it is set, the audit sheets keep the defects humans enter
   * but none is counted, and the AI reviewers' miss rate is not computed (ORC-229). A change counts from the next startup.
   */
  audit?: { seriousDefect: string };
  /** How a human message is acknowledged (ORC-380, decision ORC-140): `comment` when absent, or a reaction on its comment. */
  acknowledge?: AckMode;
  /** The Messages API key of the small model that classifies human messages (ORC-336, ORC-445), a server secret. */
  messageModel?: { apiKey: string };
  /** The caps of a run's reads that move a public counter (ORC-370), each `READ_CAPS`' when unset; never off, and no repository's to change. */
  egress?: Partial<ReadCaps>;
  /** The Linear status each step shows (ORC-382), by step, `off` for none (the spec's only, ORC-457): applied by `stepSettings`, checked against the preset by `defaultWorkflow`. */
  statuses?: Record<string, string>;
  /** Where a version of the spec is published (ORC-382): `SPEC_PUBLICATION` for what is unset. */
  spec?: Partial<SpecPublication>;
}

/**
 * How a spec is published in the ticket (ORC-382): in a `comment` alone, in a linked `doc` always, or in the comment and, past
 * `threshold` characters, in a linked document with the comment giving its summary and its link (`comment+doc`).
 */
export interface SpecPublication {
  mode: 'comment' | 'comment+doc' | 'doc';
  threshold: number;
}

/**
 * `comment+doc` (decided 11/11), past 5 000 characters: half of what the factory posts in one message (`OUTPUT_LIMITS.text`), well
 * under what Linear takes in a comment, which its API does not state; a spec longer than a screen or two goes to its document.
 */
export const SPEC_PUBLICATION: SpecPublication = { mode: 'comment+doc', threshold: 5_000 };

/** The spec's publication `factory.yml` asks for, `SPEC_PUBLICATION`'s for what it leaves unset. */
export const specPublicationOf = (yml: Pick<FactoryYml, 'spec'> | undefined): SpecPublication => ({ ...SPEC_PUBLICATION, ...yml?.spec });

/** The caps the egress proxy applies to each run's counted reads (ORC-370): factory.yml's, the defaults for those it leaves unset. */
export function readCapsOf(yml: Pick<FactoryYml, 'egress'> | undefined): ReadCaps {
  return { ...READ_CAPS, ...yml?.egress };
}

/** The ack of a human message (ORC-380): the comment « Got it. », or a reaction on the comment the message was written in. */
export type AckMode = 'comment' | 'reaction';

/** The account `claude.active` names. */
export function activeClaudeAccount(yml: FactoryYml | undefined): { name: string; token: string } | undefined {
  return yml?.claude?.accounts.find((a) => a.name === yml.claude?.active);
}

/** The token of the account `claude.active` names: the only credential a runner gets (ORC-211). */
export function activeClaudeToken(yml: FactoryYml | undefined): string | undefined {
  return claudeToken(activeClaudeAccount(yml)?.token, 'claude.active in factory.yml');
}

/** The account runs use (ORC-215): `name` absent when it is the daemon's own `CLAUDE_CODE_OAUTH_TOKEN`, `token` absent when none is set. */
export interface ClaudeAccount {
  name?: string;
  token?: string;
}

/**
 * The Claude account runs use (ORC-215): `claude.active` of `<home>/factory.yml` with its token, else the daemon's
 * `CLAUDE_CODE_OAUTH_TOKEN`. The file is read at each call and its `claude` section parsed again when the text changed:
 * a change of `active` counts from the next launch, without a restart. A token of another source than `env` is the value
 * `sealed` holds, read at the start (ORC-398). The first read throws as the daemon's start does;
 * later, a section that does not parse, or a file gone (an editor saving it), keeps the last account, logged once per fault.
 */
export function claudeAccountReader(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  log: (m: string) => void = () => {},
  sealed?: ReadonlyMap<string, string | undefined>,
): () => ClaudeAccount {
  const resolve = (text: string | undefined): ClaudeAccount => {
    // A token read from a source at the start keeps its value; an account added since with one waits for the next start (ORC-398).
    const yml = text === undefined ? undefined : parseSection(text, ['claude', 'secret_sources'], env, sealed);
    const chosen = activeClaudeToken(yml);
    if (chosen) return { name: yml!.claude!.active, token: chosen };
    const own = claudeToken(env['CLAUDE_CODE_OAUTH_TOKEN'], 'CLAUDE_CODE_OAUTH_TOKEN');
    return own ? { token: own } : {};
  };
  let text = factoryYmlText(home);
  let current = resolve(text);
  let fault: string | undefined;
  const warn = (message: string) => {
    if (message !== fault) log(`Warning: factory.yml: the Claude account is not read again, ${current.name ?? 'default'} stays active: ${message}`);
    fault = message;
  };
  return () => {
    try {
      const next = factoryYmlText(home);
      if (next === undefined && text !== undefined) {
        warn('the file is gone');
        return current;
      }
      if (next !== text) {
        text = next;
        current = resolve(next);
      }
      fault = undefined;
    } catch (err) {
      warn((err as Error).message);
    }
    return current;
  };
}

/** The text of `<home>/factory.yml`, undefined when there is none. Any other read error is thrown as is. */
export function factoryYmlText(home: string): string | undefined {
  try {
    return readFileSync(join(home, 'factory.yml'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Top-level keys of the file, validated together as `parseFactoryYml` validates them, the rest of the file left out; undefined when all are absent or null. */
function parseSection(text: string, keys: string[], env?: NodeJS.ProcessEnv, sealed?: ReadonlyMap<string, string | undefined>): FactoryYml | undefined {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new FactoryYmlError([`unreadable YAML: ${(err as Error).message}`]);
  }
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // Whatever keys are read: no command runs on repositories written as before ORC-480.
  const old = oldRepoKeys(record);
  if (old.length) throw new FactoryYmlError(old);
  const kept = Object.fromEntries(keys.map((k) => [k, k === 'repos' ? reposWithout(record[k], REPO_DAEMON_KEYS) : record[k]]).filter(([, v]) => v !== undefined && v !== null));
  return Object.keys(kept).length === 0 ? undefined : parseFactoryYml(stringify(kept), env, SECRET_SOURCE_KINDS, sealed);
}

/** `repos` with `keys` left out of each entry: the instance's view, without the daemon's keys. */
function reposWithout(repos: unknown, keys: readonly string[]): unknown {
  return Array.isArray(repos) ? repos.map((r: unknown) => (isRecord(r) ? Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k))) : r)) : repos;
}

/**
 * The repositories as factory.yml wrote them before ORC-480, refused by every read of the file with how to rewrite them, as the
 * start names a `config.yaml` left from before ORC-199: the `projects` list, joined to `repos` by team and clone, and any
 * `repo_path` of a target repository, a local clone the daemon no longer reads (its own mirror, ORC-479), and `knowledge.repo_path`,
 * the knowledge base's, for which the daemon keeps a clone of its own (ORC-481).
 */
export function oldRepoKeys(r: Record<string, unknown>): string[] {
  const found: string[] = [];
  // Even empty: a bare `projects:` would leave `repos` unread as the old list's.
  if ('projects' in r) {
    found.push(
      'projects: replaced by repos (ORC-480), one entry per repository: `{ id, github, linear_team, authz, preset, effects, env, secrets }`. ' +
        'Move each project into repos: keep its id, authz, preset and effects, rename linear_team_key to linear_team, replace repo_path by github: ' +
        "<owner>/<name> (the GitHub repository of that clone's origin), and copy in the env and secrets of the repos entry of its team and repository " +
        '(into each project of that team and repository, a factory/fantome one included), then delete projects and the old repos entries',
    );
  }
  const repos = r['repos'];
  if (Array.isArray(repos)) {
    repos.forEach((entry: unknown, i) => {
      if (isRecord(entry) && 'repo_path' in entry) found.push(`repos[${i}].repo_path: no longer read (ORC-480): the daemon fetches the repository github names into a mirror of its own; delete it`);
    });
  }
  if (isRecord(r['knowledge']) && 'repo_path' in r['knowledge']) {
    found.push(
      'knowledge.repo_path: no longer read (ORC-481): the daemon keeps its own clone of the knowledge base under <FACTORY_HOME>/knowledge. ' +
        "Rewrite the section as `knowledge: { github: <owner>/<name> }`, the GitHub repository of that clone's origin, and install the GitHub App " +
        'on that repository with Contents: Read and write (it reads and pushes the notes with its token)',
    );
  }
  return found;
}

/**
 * A Claude token as the egress proxy sets it on a header (ORC-337): trimmed, a secret file's newline gone. One a
 * header cannot carry (a line break, a control character) is refused, naming `from`: the daemon does not start.
 */
export function claudeToken(value: string | undefined, from: string): string | undefined {
  const token = value?.trim() || undefined;
  if (token === undefined) return undefined;
  try {
    validateHeaderValue('authorization', `Bearer ${token}`);
  } catch {
    throw new Error(`${from}: the Claude token holds a character an HTTP header cannot carry (a line break or a control character)`);
  }
  return token;
}

/** What the workflow's agent steps read of the file (ORC-136): no per-step cap when it is `off` (ORC-381). */
export function stepSettings(yml: FactoryYml | undefined): StepSettings {
  const { perStepTokens, ...budgets } = yml?.budgets ?? {};
  return { effort: yml?.claude?.effort, budgets: yml?.budgets && { ...budgets, ...(perStepTokens === 'off' ? {} : { perStepTokens }) }, tools: yml?.tools, statuses: yml?.statuses };
}

/** The ticket's token cap the daemon applies (ORC-340): none when it is unset or `off` (ORC-381). */
export function ticketCapOf(yml: Pick<FactoryYml, 'budgets'> | undefined): number | undefined {
  const cap = yml?.budgets?.perTicketTokens;
  return cap === 'off' ? undefined : cap;
}

/** The controls the file disables (ORC-381), by their key: what `factory validate`, the dashboard and the daemon's start say. */
export function disabledControls(yml: Pick<FactoryYml, 'budgets' | 'maxDiff'> | undefined): string[] {
  return [
    ...(yml?.maxDiff === 'off' ? ['max_diff'] : []),
    ...(yml?.budgets?.perStepTokens === 'off' ? ['budgets.per_step_tokens'] : []),
    ...(yml?.budgets?.perTicketTokens === 'off' ? ['budgets.per_ticket_tokens'] : []),
  ];
}

export class FactoryYmlError extends Error {
  constructor(readonly violations: string[]) {
    super(`invalid factory.yml:\n- ${violations.join('\n- ')}`);
  }
}

const SECTIONS: Record<string, string[]> = {
  port: [],
  host: [],
  public_url: [],
  dev: [],
  relay: [],
  knowledge: [],
  linear: ['app_client_id', 'client_secret', 'webhook_secret'],
  github: ['app_id', 'private_key', 'installation_id', 'webhook_secret', 'client_id', 'client_secret'],
  dashboard: ['logins', 'org', 'team'],
  claude: ['runtime', 'accounts', 'active', 'default_model', 'per_step', 'effort'],
  concurrency: [],
  budgets: ['per_step_tokens', 'per_ticket_tokens', 'max_turns', 'on_usage_limit'],
  tools: ['per_step'],
  max_diff: [],
  repos: [],
  secret_sources: [],
  secrets_key: [],
  read_guard: ['max_lines'],
  audit: ['serious_defect'],
  acknowledge: [],
  message_model: ['api_key'],
  egress: ['max_versions_per_package', 'max_assets_per_repo'],
  statuses: [],
  spec: ['publish', 'threshold'],
};
/** The instance keys (ORC-199): what `loadInstance` reads and `saveInstance` writes, without the rest of the file. */
const INSTANCE_KEYS = ['port', 'host', 'public_url', 'dev', 'relay', 'repos', 'knowledge'];
const repoSchema = z.strictObject({
  id: z.string().min(1),
  github: z.string(),
  linear_team: z.string().min(1),
  authz: z
    .strictObject({
      maintainers: z.array(z.string().min(1)).default([]),
      validators: z.array(z.string().min(1)).default([]),
      github_logins: z.record(z.string().min(1), z.string().min(1)).default({}),
    })
    .optional(),
  effects: z.literal('none').optional(),
  preset: z.literal(FANTOME).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
});
const relaySchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('smee'), url: z.string().url() }), z.strictObject({ kind: z.literal('none') })]);
const effort = z.enum(['low', 'medium', 'high']);
const counts = z.record(z.string(), z.number().int().positive());
const REPO = /^[\w.-]+\/[\w.-]+$/;
/** A team of factory.yml's `dashboard`: `<org>/<team-slug>`. */
const GITHUB_TEAM = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[\w.-]+$/;

/** The file with its `env:` secrets only: a server secret of another source is a fault here. The daemon and the CLI read it with `loadSealedFactoryYml` (ORC-398). */
export function loadFactoryYml(home: string, env: NodeJS.ProcessEnv = process.env): FactoryYml | undefined {
  const text = factoryYmlText(home);
  return text === undefined ? undefined : parseFactoryYml(text, env);
}

/** The instance keys of a factory.yml's text alone (ORC-199), validated as the daemon validates them, without each repository's `env` and `secrets` (ORC-480). */
export function parseInstanceKeys(text: string): FactoryYml {
  return parseSection(text, INSTANCE_KEYS) ?? {};
}

/**
 * The `budgets`, `max_diff` and `tools` of `<home>/factory.yml` alone (ORC-216, ORC-381, ORC-383), validated as the daemon validates
 * them: what `factory validate` reads, without resolving the file's `env:` secrets, which the shell it runs in need not have. A read
 * error is thrown as is.
 */
export function loadFactoryLimits(home: string): Pick<FactoryYml, 'budgets' | 'maxDiff' | 'tools'> {
  const text = factoryYmlText(home);
  // Only these keys are parsed: the result holds nothing else.
  return (text === undefined ? undefined : parseSection(text, ['budgets', 'max_diff', 'tools'])) ?? {};
}

/**
 * Validates the file and resolves its `env:` values, but for `repos[].secrets`, references whose syntax alone is checked
 * against `kinds` (ORC-308); throws a FactoryYmlError naming the path of every faulty key. A server secret written with another
 * source takes its value from `sealed`, by its reference, which `loadSealedFactoryYml` read at the daemon's start (ORC-398):
 * `defer` leaves it unread, as does a reference `sealed` holds without a value; without `sealed` it is a fault.
 */
export function parseFactoryYml(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  kinds: Readonly<Record<string, SecretSourceKind>> = SECRET_SOURCE_KINDS,
  sealed?: ReadonlyMap<string, string | undefined> | 'defer',
): FactoryYml {
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (err) {
    throw new FactoryYmlError([`unreadable YAML: ${(err as Error).message}`]);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new FactoryYmlError(['a YAML object is expected']);
  const r = raw as Record<string, unknown>;
  // Alone, before anything else: the rest of a file written as before ORC-480 is to rewrite whole.
  const old = oldRepoKeys(r);
  if (old.length) throw new FactoryYmlError(old);
  const violations: string[] = [];
  const out: FactoryYml = {};

  for (const key of Object.keys(r)) if (!(key in SECTIONS)) violations.push(`${key}: unknown key`);
  const section = (key: string): Record<string, unknown> | undefined => {
    const v = r[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'object' || Array.isArray(v)) {
      violations.push(`${key}: an object is expected`);
      return undefined;
    }
    for (const k of Object.keys(v)) if (!SECTIONS[key]!.includes(k)) violations.push(`${key}.${k}: unknown key`);
    return v as Record<string, unknown>;
  };
  /** A value, or `env:NAME` read from the environment. */
  const value = (path: string, v: unknown): string | undefined => {
    if (v === undefined || v === null) return undefined;
    const text = typeof v === 'number' ? String(v) : v;
    if (typeof text !== 'string' || text === '') {
      violations.push(`${path}: a non-empty text is expected`);
      return undefined;
    }
    if (!text.startsWith('env:')) return text;
    const name = text.slice(4);
    if (!ENV_NAME.test(name)) {
      violations.push(`${path}: "${text}" does not name a variable (\`env:NAME\`)`);
      return undefined;
    }
    const resolved = env[name];
    if (resolved === undefined || resolved === '') violations.push(`${path}: the environment variable ${name} is not set`);
    return resolved || undefined;
  };
  const leaf = <T>(path: string, v: unknown, schema: z.ZodType<T>, expected: string): T | undefined => {
    if (v === undefined || v === null) return undefined;
    const res = schema.safeParse(v);
    if (!res.success) violations.push(`${path}: ${expected}`);
    return res.success ? res.data : undefined;
  };

  /** A value of a nested shape: each fault named by its own path (`repos[0].linear_team`). */
  const shaped = <T>(path: string, v: unknown, schema: z.ZodType<T>): T | undefined => {
    if (v === undefined || v === null) return undefined;
    const res = schema.safeParse(v);
    if (res.success) return res.data;
    for (const i of res.error.issues) violations.push(`${path}${i.path.map((k) => (typeof k === 'number' ? `[${k}]` : `.${String(k)}`)).join('')}: ${i.message}`);
    return undefined;
  };

  // The instance (ORC-199), in config.yaml before.
  const port = leaf('port', r['port'], z.number().int().positive(), 'a positive integer is expected');
  if (port !== undefined) out.port = port;
  const host = leaf('host', r['host'], z.string().min(1), 'a non-empty text is expected');
  if (host !== undefined) out.host = host;
  const publicUrl = leaf('public_url', r['public_url'], z.string().url(), 'a URL is expected');
  if (publicUrl !== undefined) out.publicUrl = publicUrl;
  const dev = leaf('dev', r['dev'], z.boolean(), '`true` or `false` expected');
  if (dev !== undefined) out.dev = dev;
  const relay = shaped('relay', r['relay'], relaySchema);
  if (relay) out.relay = relay;
  const knowledge = shaped('knowledge', r['knowledge'], z.strictObject({ github: z.string() }));
  if (knowledge && !REPO.test(knowledge.github)) violations.push('knowledge.github: `<org>/<repo>` expected');
  else if (knowledge) out.knowledge = { github: knowledge.github };

  const secretRefs: Record<string, SecretRef> = {};
  /** An `env:NAME` secret, resolved now as before ORC-398, its reference kept for `doctor` and the masking. */
  const envSecret = (path: string, v: string): string | undefined => {
    const resolved = value(path, v);
    if (resolved !== undefined) secretRefs[path] = { source: 'env', path: v.slice(4) };
    return resolved;
  };
  const sourcesRaw = r['secret_sources'];
  const secretSources: Record<string, SecretSourceDecl> = {};
  /** The adapter of each source a reference may name, `env` built in; undefined for a faulty declaration, already refused. */
  const adapters = new Map<string, SecretSourceKind | undefined>([['env', kindOf(kinds, 'env')]]);
  if (sourcesRaw !== undefined && sourcesRaw !== null) {
    if (typeof sourcesRaw !== 'object' || Array.isArray(sourcesRaw)) violations.push('secret_sources: an object is expected');
    else {
      const known = Object.keys(kinds).join(', ');
      for (const [name, decl] of Object.entries(sourcesRaw as Record<string, unknown>)) {
        const path = `secret_sources.${name}`;
        if (name === 'env') {
          violations.push(`${path}: built in, it is not declared`);
          continue;
        }
        // Assigned as a key, it would set an object's prototype: the source would vanish while its references passed.
        if (name === '__proto__') {
          violations.push(`${path}: not a name a source can take`);
          continue;
        }
        adapters.set(name, undefined);
        if (!decl || typeof decl !== 'object' || Array.isArray(decl)) {
          violations.push(`${path}: an object \`{ kind, … }\` is expected`);
          continue;
        }
        const { kind, ...written } = decl as Record<string, unknown>;
        const adapter = typeof kind === 'string' ? kindOf(kinds, kind) : undefined;
        if (!adapter) {
          violations.push(kind == null ? `${path}.kind: required (${known})` : `${path}.kind: no adapter ${String(kind)} (${known})`);
          continue;
        }
        // An option written `env:NAME` (an access credential) is resolved, and masked as the daemon's own secrets (ORC-398).
        const options = Object.fromEntries(
          Object.entries(written).map(([key, v]) => [key, typeof v === 'string' && v.startsWith('env:') ? envSecret(`${path}.${key}`, v) : v]),
        );
        // Kept despite faulty options: its references are still checked against its adapter.
        violations.push(...adapter.checkOptions(options).map((v) => `${path}.${v}`));
        adapters.set(name, adapter);
        secretSources[name] = { kind: kind as string, options };
      }
    }
  }
  if (Object.keys(secretSources).length) out.secretSources = secretSources;
  /** A secret's reference (ORC-308, ORC-398): its source declared, its path one its adapter accepts; nothing read. */
  const reference = (path: string, v: unknown): SecretRef | undefined => {
    // Written without a value: skipped, as before ORC-308 and as `repos[].env` does; the setup then reports it missing.
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v === '') {
      violations.push(`${path}: a non-empty text is expected`);
      return undefined;
    }
    const colon = v.indexOf(':');
    if (colon <= 0) {
      violations.push(`${path}: a reference \`<source>:<path>\` is expected (\`env:NAME\`), never a secret in clear in factory.yml`);
      return undefined;
    }
    const ref = { source: v.slice(0, colon), path: v.slice(colon + 1) };
    if (!adapters.has(ref.source)) violations.push(`${path}: its source is neither \`env\` nor declared under secret_sources`);
    const kind = adapters.get(ref.source);
    if (!kind) return undefined;
    const fault = kind.checkPath(ref.path);
    if (fault) violations.push(`${path}: ${fault}`);
    return fault ? undefined : ref;
  };
  /**
   * A server secret (ORC-398): `env:NAME` resolved now; another source's value taken from `sealed`, read at the daemon's start,
   * left unread when `sealed` is `defer`, a fault without it.
   */
  const secret = (path: string, v: unknown): string | undefined => {
    if (typeof v === 'string' && v.startsWith('env:')) return envSecret(path, v);
    const ref = reference(path, v);
    if (!ref) return undefined;
    secretRefs[path] = ref;
    if (sealed === 'defer') return undefined;
    // Held without a value: a command that does not need this secret did not read it.
    if (sealed?.has(refText(ref))) return sealed.get(refText(ref));
    violations.push(`${path}: ${refText(ref)} is read from its source at the daemon's start`);
    return undefined;
  };
  const linear = section('linear');
  if (linear) {
    out.linear = {
      clientId: value('linear.app_client_id', linear['app_client_id']),
      clientSecret: secret('linear.client_secret', linear['client_secret']),
      webhookSecret: secret('linear.webhook_secret', linear['webhook_secret']),
    };
  }
  const github = section('github');
  if (github) {
    const appId = value('github.app_id', github['app_id']);
    const privateKey = secret('github.private_key', github['private_key']);
    // `== null`: an empty value (`private_key:`) is as missing as an absent one.
    if (github['app_id'] == null) violations.push('github.app_id: required');
    if (github['private_key'] == null) violations.push('github.private_key: required');
    const installationId = value('github.installation_id', github['installation_id']);
    const webhookSecret = secret('github.webhook_secret', github['webhook_secret']);
    const clientId = value('github.client_id', github['client_id']);
    const clientSecret = secret('github.client_secret', github['client_secret']);
    if (appId && privateKey) {
      out.github = {
        appId,
        privateKey,
        ...(installationId ? { installationId } : {}),
        ...(webhookSecret ? { webhookSecret } : {}),
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      };
    }
  }
  const dashboard = section('dashboard');
  if (dashboard) {
    const logins = leaf('dashboard.logins', dashboard['logins'], z.array(z.string().regex(GITHUB_LOGIN)), 'GitHub logins expected');
    const org = leaf('dashboard.org', dashboard['org'], z.string().regex(GITHUB_LOGIN), 'a GitHub org expected');
    const team = leaf('dashboard.team', dashboard['team'], z.string().regex(GITHUB_TEAM), '`<org>/<team-slug>` expected');
    const named = (v: unknown) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
    if (!['logins', 'org', 'team'].some((k) => named(dashboard[k]))) violations.push('dashboard: name the logins, the org or the team let in');
    out.dashboard = { logins: logins ?? [], ...(org ? { org } : {}), ...(team ? { team } : {}) };
  }
  const claude = section('claude');
  if (claude) {
    for (const key of ['accounts', 'active', 'default_model']) if (claude[key] == null) violations.push(`claude.${key}: required`);
    const declared = leaf('claude.accounts', claude['accounts'], z.array(z.strictObject({ name: z.string().min(1), token: z.string() })), '`[{ name, token }]` expected');
    const accounts = (declared ?? []).map((a, i) => ({ name: a.name, token: secret(`claude.accounts[${i}].token`, a.token) ?? '' }));
    const active = leaf('claude.active', claude['active'], z.string().min(1), 'an account name is expected');
    // Only against well-formed accounts: a malformed list already has its own violation.
    if (active && declared && !accounts.some((a) => a.name === active)) {
      violations.push(`claude.active: "${active}" is not one of the declared accounts (${accounts.map((a) => a.name).join(', ')})`);
    }
    const defaultModel = leaf('claude.default_model', claude['default_model'], z.string().min(1), 'a model is expected');
    const perStep = leaf('claude.per_step', claude['per_step'], z.record(z.string(), z.string().min(1)), '`step: model` expected');
    const eff = leaf(
      'claude.effort',
      claude['effort'],
      z.strictObject({ default: effort, per_step: z.record(z.string(), effort).optional() }),
      '`{ default, per_step }` in low | medium | high expected',
    );
    if (claude['runtime'] !== 'claude-code') violations.push('claude.runtime: only `claude-code` exists');
    if (active && defaultModel) {
      out.claude = {
        runtime: 'claude-code',
        accounts,
        active,
        defaultModel,
        ...(perStep ? { perStep } : {}),
        ...(eff ? { effort: { default: eff.default, ...(eff.per_step ? { perStep: eff.per_step } : {}) } } : {}),
      };
    }
  }
  const secretsKey = secret('secrets_key', r['secrets_key']);
  if (secretsKey !== undefined && secretsKey.length < MIN_SECRETS_KEY_LENGTH) violations.push(`secrets_key: at least ${MIN_SECRETS_KEY_LENGTH} characters expected`);
  else if (secretsKey !== undefined) out.secretsKey = secretsKey;
  const concurrency = leaf('concurrency', r['concurrency'], z.number().int().positive(), 'a positive integer is expected');
  if (concurrency !== undefined) out.concurrency = concurrency;
  // `off` disables a token cap (ORC-381): `budgets: off` both.
  let budgets: Record<string, unknown> | undefined;
  if (r['budgets'] === 'off') budgets = { per_step_tokens: 'off', per_ticket_tokens: 'off' };
  else if (typeof r['budgets'] === 'string') violations.push('budgets: an object is expected, or `off`');
  else budgets = section('budgets');
  if (budgets) {
    const perStepTokens = leaf('budgets.per_step_tokens', budgets['per_step_tokens'], counts.or(z.literal('off')), '`step: positive integer` expected, or `off`');
    const perTicketTokens = leaf('budgets.per_ticket_tokens', budgets['per_ticket_tokens'], z.number().int().positive().or(z.literal('off')), 'a positive integer is expected, or `off`');
    const maxTurns = leaf('budgets.max_turns', budgets['max_turns'], counts, '`step: positive integer` expected');
    const onUsageLimit = leaf('budgets.on_usage_limit', budgets['on_usage_limit'], z.literal('wait'), 'only `wait` exists');
    out.budgets = {
      ...(perStepTokens ? { perStepTokens } : {}),
      ...(perTicketTokens ? { perTicketTokens } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(onUsageLimit ? { onUsageLimit } : {}),
    };
  }
  const perStepTools = leaf('tools.per_step', section('tools')?.['per_step'], z.record(z.string(), z.array(z.string().min(1))), '`step: [tool, …]` expected');
  if (perStepTools) out.tools = { perStep: perStepTools };
  const repos = shaped('repos', r['repos'], z.array(repoSchema));
  if (repos) {
    const ids = new Map<string, number>();
    out.repos = repos.map(({ linear_team, authz, env, secrets, ...repo }, i) => {
      if (!REPO.test(repo.github)) violations.push(`repos[${i}].github: \`<org>/<repo>\` expected`);
      // The key of its tickets and labels: two entries of one id would share them.
      const first = ids.get(repo.id);
      if (first !== undefined) violations.push(`repos[${i}].id: ${repo.id} is already the id of repos[${first}]`);
      else ids.set(repo.id, i);
      const read = <T>(key: 'env' | 'secrets', from: Record<string, unknown>, one: (path: string, v: unknown) => T | undefined): Record<string, T> => {
        const out: Record<string, T> = {};
        for (const [name, v] of Object.entries(from)) {
          const got = one(`repos[${i}].${key}.${name}`, v);
          if (got !== undefined) out[name] = got;
        }
        return out;
      };
      return {
        ...repo,
        linearTeamKey: linear_team,
        ...(authz ? { authz: { maintainers: authz.maintainers, validators: authz.validators, githubLogins: authz.github_logins } } : {}),
        ...(env ? { env: read('env', env, (path, v) => value(path, v)) } : {}),
        ...(secrets ? { secrets: read('secrets', secrets, reference) } : {}),
      };
    });
  }
  const maxDiff = leaf('max_diff', r['max_diff'], z.literal('off'), `only \`off\` exists here; without it, the baseline (${MAX_DIFF.files} files, ${MAX_DIFF.lines} lines) applies, tightened by each repository`);
  if (maxDiff) out.maxDiff = maxDiff;
  const maxLines = leaf('read_guard.max_lines', section('read_guard')?.['max_lines'], z.number().int().positive(), 'a positive integer is expected');
  if (maxLines !== undefined) out.readGuard = { maxLines };
  const seriousDefect = leaf('audit.serious_defect', section('audit')?.['serious_defect'], z.string().trim().min(1), 'a non-empty text is expected: the definition');
  if (seriousDefect !== undefined) out.audit = { seriousDefect };
  const acknowledge = leaf('acknowledge', r['acknowledge'], z.enum(['comment', 'reaction']), '`comment` or `reaction` expected');
  if (acknowledge !== undefined) out.acknowledge = acknowledge;
  const apiKey = secret('message_model.api_key', section('message_model')?.['api_key']);
  if (apiKey) out.messageModel = { apiKey };
  const egress = section('egress');
  if (egress) {
    const cap = (key: string) => leaf(`egress.${key}`, egress[key], z.number().int().positive(), 'a positive integer is expected; the cap cannot be turned off');
    const versionsPerPackage = cap('max_versions_per_package');
    const assetsPerRepo = cap('max_assets_per_repo');
    out.egress = { ...(versionsPerPackage ? { versionsPerPackage } : {}), ...(assetsPerRepo ? { assetsPerRepo } : {}) };
  }

  const statuses = leaf('statuses', r['statuses'], z.record(z.string(), z.string().trim().min(1)), '`step: Linear status` expected');
  if (statuses) out.statuses = statuses;
  const spec = section('spec');
  if (spec) {
    const mode = leaf('spec.publish', spec['publish'], z.enum(['comment', 'comment+doc', 'doc']), '`comment`, `comment+doc` or `doc` expected');
    const threshold = leaf('spec.threshold', spec['threshold'], z.number().int().positive(), 'a positive integer is expected: characters');
    out.spec = { ...(mode ? { mode } : {}), ...(threshold ? { threshold } : {}) };
  }

  if (Object.keys(secretRefs).length) out.secretRefs = secretRefs;
  if (violations.length > 0) throw new FactoryYmlError(violations);
  return out;
}
