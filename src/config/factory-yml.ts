import { readFileSync } from 'node:fs';
import { validateHeaderValue } from 'node:http';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { SECRET_SOURCE_KINDS, type SecretSourceDecl } from '../adapters/secrets/registry.js';
import type { SecretRef, SecretSourceKind } from '../adapters/secrets/types.js';
import { MAX_DIFF } from '../checks/diff-size.js';
import type { Effort } from '../presets/preset.js';
import type { StepSettings } from './load-workflow.js';

/**
 * `<FACTORY_HOME>/factory.yml` (ORC-209, part B): the server's configuration, optional, next to `config.yaml`
 * until ORC-199. Every secret is written `env:NAME` and resolved from the environment, never kept in the file; a repository's
 * secrets are references `<source>:<path>`, read at each `setup` (ORC-308).
 * Read only: the daemon overlays it on what it reads (`effectiveInstance`, `linearSettings`), nothing saves it.
 */
export interface FactoryYml {
  linear?: { clientId?: string; clientSecret?: string; webhookSecret?: string };
  github?: { appId: string; privateKey: string; installationId?: string; webhookSecret?: string };
  /** `effort` is applied by `stepSettings` (ORC-136); `accounts` and `active` read again at each launch by `claudeAccountReader` (ORC-215). */
  claude?: {
    runtime: 'claude-code';
    accounts: { name: string; token: string }[];
    active: string;
    defaultModel: string;
    perStep?: Record<string, string>;
    effort?: { default: Effort; perStep?: Record<string, Effort> };
  };
  /** Tickets worked at once: the dev queue's capacity, over `parallel_sessions` of the workflow (ORC-203). */
  concurrency?: number;
  /**
   * `max_turns` and `per_step_tokens` are applied by `stepSettings` (ORC-136); `per_ticket_tokens` and `on_usage_limit` by the orchestrator (ORC-340).
   * A token cap `off` is disabled (ORC-381), `budgets: off` both: unlike a cap left unset, `factory validate` accepts it. `on_usage_limit` is no cap of the factory's.
   */
  budgets?: { perStepTokens?: Record<string, number> | 'off'; perTicketTokens?: number | 'off'; maxTurns?: Record<string, number>; onUsageLimit?: 'wait' };
  /** The built-in tools of each agent step, in place of its preset default (ORC-383): checked against the step by `loadWorkflow`, applied by `stepSettings`. */
  tools?: { perStep?: Record<string, string[]> };
  /** `off` disables the baseline of `factory/taille-du-diff` (ORC-381): only a repository's own `max_diff` bounds its diffs. */
  maxDiff?: 'off';
  /**
   * `projects[].repoPath` of config.yaml stays the working copy until the runner clones (ORC-204). `env` holds the values of
   * what the repository's `.factory/config.yml` declares (ORC-211); `secrets` their references, read at the setup (ORC-308).
   */
  repos?: { linearTeam: string; github: string; env?: Record<string, string>; secrets?: Record<string, SecretRef> }[];
  /** The secret managers `repos[].secrets` may name besides `env` (ORC-308), each validated against its adapter. */
  secretSources?: Record<string, SecretSourceDecl>;
  /** Lines past which the pack's hook refuses a whole read (ORC-279); without it, the hook's own 350. */
  readGuard?: { maxLines: number };
  /**
   * The definition of a serious defect (ORC-153), as written: until it is set, the audit sheets keep the defects humans enter
   * but none is counted, and the AI reviewers' miss rate is not computed (ORC-229). A change counts from the next startup.
   */
  audit?: { seriousDefect: string };
  /** How a human message is acknowledged (ORC-380, decision ORC-140): `comment` when absent, or a reaction on its comment. */
  acknowledge?: AckMode;
}

/** The ack of a human message (ORC-380): the comment « Got it. », or a reaction on the comment the message was written in. */
export type AckMode = 'comment' | 'reaction';

/** The token of the account `claude.active` names: the only credential a runner gets (ORC-211). */
export function activeClaudeToken(yml: FactoryYml | undefined): string | undefined {
  return claudeToken(yml?.claude?.accounts.find((a) => a.name === yml.claude?.active)?.token, 'claude.active in factory.yml');
}

/** The account runs use (ORC-215): `name` absent when it is the daemon's own `CLAUDE_CODE_OAUTH_TOKEN`, `token` absent when none is set. */
export interface ClaudeAccount {
  name?: string;
  token?: string;
}

/**
 * The Claude account runs use (ORC-215): `claude.active` of `<home>/factory.yml` with its token, else the daemon's
 * `CLAUDE_CODE_OAUTH_TOKEN`. The file is read at each call and its `claude` section parsed again when the text changed:
 * a change of `active` counts from the next launch, without a restart. The first read throws as the daemon's start does;
 * later, a section that does not parse, or a file gone (an editor saving it), keeps the last account, logged once per fault.
 */
export function claudeAccountReader(home: string, env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = () => {}): () => ClaudeAccount {
  const resolve = (text: string | undefined): ClaudeAccount => {
    const yml = text === undefined ? undefined : parseSection(text, ['claude'], env);
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
function factoryYmlText(home: string): string | undefined {
  try {
    return readFileSync(join(home, 'factory.yml'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Top-level keys of the file, validated together as `parseFactoryYml` validates them, the rest of the file left out; undefined when all are absent or null. */
function parseSection(text: string, keys: string[], env?: NodeJS.ProcessEnv): FactoryYml | undefined {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new FactoryYmlError([`unreadable YAML: ${(err as Error).message}`]);
  }
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const kept = Object.fromEntries(keys.map((k) => [k, record[k]]).filter(([, v]) => v !== undefined && v !== null));
  return Object.keys(kept).length === 0 ? undefined : parseFactoryYml(stringify(kept), env);
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
  return { effort: yml?.claude?.effort, budgets: yml?.budgets && { ...budgets, ...(perStepTokens === 'off' ? {} : { perStepTokens }) }, tools: yml?.tools };
}

/** The ticket's token cap the orchestrator applies (ORC-340): none when it is unset or `off` (ORC-381). */
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
  linear: ['app_client_id', 'client_secret', 'webhook_secret'],
  github: ['app_id', 'private_key', 'installation_id', 'webhook_secret'],
  claude: ['runtime', 'accounts', 'active', 'default_model', 'per_step', 'effort'],
  concurrency: [],
  budgets: ['per_step_tokens', 'per_ticket_tokens', 'max_turns', 'on_usage_limit'],
  tools: ['per_step'],
  max_diff: [],
  repos: [],
  secret_sources: [],
  read_guard: ['max_lines'],
  audit: ['serious_defect'],
  acknowledge: [],
};
const effort = z.enum(['low', 'medium', 'high']);
const counts = z.record(z.string(), z.number().int().positive());
const REPO = /^[\w.-]+\/[\w.-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadFactoryYml(home: string, env: NodeJS.ProcessEnv = process.env, kinds?: Readonly<Record<string, SecretSourceKind>>): FactoryYml | undefined {
  const text = factoryYmlText(home);
  return text === undefined ? undefined : parseFactoryYml(text, env, kinds);
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
 * against `kinds` (ORC-308); throws a FactoryYmlError naming the path of every faulty key.
 */
export function parseFactoryYml(text: string, env: NodeJS.ProcessEnv = process.env, kinds: Readonly<Record<string, SecretSourceKind>> = SECRET_SOURCE_KINDS): FactoryYml {
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (err) {
    throw new FactoryYmlError([`unreadable YAML: ${(err as Error).message}`]);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new FactoryYmlError(['a YAML object is expected']);
  const r = raw as Record<string, unknown>;
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
  /** A value, or `env:NAME` read from the environment; a secret must be `env:NAME`. */
  const value = (path: string, v: unknown, secret = false): string | undefined => {
    if (v === undefined || v === null) return undefined;
    const text = typeof v === 'number' ? String(v) : v;
    if (typeof text !== 'string' || text === '') {
      violations.push(`${path}: a non-empty text is expected`);
      return undefined;
    }
    if (!text.startsWith('env:')) {
      if (secret) violations.push(`${path}: a secret is written \`env:NAME\`, never in clear in factory.yml`);
      return secret ? undefined : text;
    }
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

  const linear = section('linear');
  if (linear) {
    out.linear = {
      clientId: value('linear.app_client_id', linear['app_client_id']),
      clientSecret: value('linear.client_secret', linear['client_secret'], true),
      webhookSecret: value('linear.webhook_secret', linear['webhook_secret'], true),
    };
  }
  const github = section('github');
  if (github) {
    const appId = value('github.app_id', github['app_id']);
    const privateKey = value('github.private_key', github['private_key'], true);
    // `== null`: an empty value (`private_key:`) is as missing as an absent one.
    if (github['app_id'] == null) violations.push('github.app_id: required');
    if (github['private_key'] == null) violations.push('github.private_key: required');
    const installationId = value('github.installation_id', github['installation_id']);
    const webhookSecret = value('github.webhook_secret', github['webhook_secret'], true);
    if (appId && privateKey) out.github = { appId, privateKey, ...(installationId ? { installationId } : {}), ...(webhookSecret ? { webhookSecret } : {}) };
  }
  const claude = section('claude');
  if (claude) {
    for (const key of ['accounts', 'active', 'default_model']) if (claude[key] == null) violations.push(`claude.${key}: required`);
    const declared = leaf('claude.accounts', claude['accounts'], z.array(z.strictObject({ name: z.string().min(1), token: z.string() })), '`[{ name, token }]` expected');
    const accounts = (declared ?? []).map((a, i) => ({ name: a.name, token: value(`claude.accounts[${i}].token`, a.token, true) ?? '' }));
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
  const sourcesRaw = r['secret_sources'];
  const secretSources: Record<string, SecretSourceDecl> = {};
  if (sourcesRaw !== undefined && sourcesRaw !== null) {
    if (typeof sourcesRaw !== 'object' || Array.isArray(sourcesRaw)) violations.push('secret_sources: an object is expected');
    else {
      const known = Object.keys(kinds).join(', ');
      for (const [name, decl] of Object.entries(sourcesRaw as Record<string, unknown>)) {
        const path = `secret_sources.${name}`;
        if (name === 'env') violations.push(`${path}: built in, it is not declared`);
        else if (!decl || typeof decl !== 'object' || Array.isArray(decl)) violations.push(`${path}: an object \`{ kind, … }\` is expected`);
        else {
          const { kind, ...options } = decl as Record<string, unknown>;
          const adapter = typeof kind === 'string' ? kinds[kind] : undefined;
          if (kind == null) violations.push(`${path}.kind: required (${known})`);
          else if (!adapter) violations.push(`${path}.kind: no adapter ${String(kind)} (${known})`);
          else {
            // Kept despite faulty options: its references are still checked against its adapter, not refused as undeclared.
            violations.push(...adapter.checkOptions(options).map((v) => `${path}.${v}`));
            secretSources[name] = { kind: kind as string, options };
          }
        }
      }
    }
  }
  if (Object.keys(secretSources).length) out.secretSources = secretSources;
  /** A repository secret's reference (ORC-308): its source declared, its path one its adapter accepts; nothing read. */
  const reference = (path: string, v: unknown): SecretRef | undefined => {
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
    const kind = ref.source === 'env' ? kinds['env'] : secretSources[ref.source] && kinds[secretSources[ref.source]!.kind];
    if (!kind) {
      violations.push(`${path}: its source is neither \`env\` nor declared under secret_sources`);
      return undefined;
    }
    const fault = kind.checkPath(ref.path);
    if (fault) violations.push(`${path}: ${fault}`);
    return fault ? undefined : ref;
  };
  const repos = leaf(
    'repos',
    r['repos'],
    z.array(z.strictObject({ linear_team: z.string().min(1), github: z.string(), env: z.record(z.string(), z.unknown()).optional(), secrets: z.record(z.string(), z.unknown()).optional() })),
    '`[{ linear_team, github, env, secrets }]` expected',
  );
  if (repos) {
    out.repos = repos.map((repo, i) => {
      if (!REPO.test(repo.github)) violations.push(`repos[${i}].github: \`<org>/<repo>\` expected`);
      const read = <T>(key: 'env' | 'secrets', one: (path: string, v: unknown) => T | undefined): Record<string, T> => {
        const out: Record<string, T> = {};
        for (const [name, v] of Object.entries(repo[key] ?? {})) {
          const got = one(`repos[${i}].${key}.${name}`, v);
          if (got !== undefined) out[name] = got;
        }
        return out;
      };
      return {
        linearTeam: repo.linear_team,
        github: repo.github,
        ...(repo.env ? { env: read('env', (path, v) => value(path, v)) } : {}),
        ...(repo.secrets ? { secrets: read('secrets', reference) } : {}),
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

  if (violations.length > 0) throw new FactoryYmlError(violations);
  return out;
}
