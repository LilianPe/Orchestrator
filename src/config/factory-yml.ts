import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Effort } from '../presets/preset.js';
import type { StepSettings } from './load-workflow.js';

/**
 * `<FACTORY_HOME>/factory.yml` (ORC-209, part B): the server's configuration, optional, next to `config.yaml`
 * until ORC-199. Every secret is written `env:NAME` and resolved from the environment, never kept in the file.
 * Read only: the daemon overlays it on what it reads (`effectiveInstance`, `linearSettings`), nothing saves it.
 */
export interface FactoryYml {
  linear?: { clientId?: string; clientSecret?: string; webhookSecret?: string };
  github?: { appId: string; privateKey: string; installationId?: string; webhookSecret?: string };
  /** `effort` is applied by `stepSettings` (ORC-136); the rest of the choice of account waits for ORC-215. */
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
  /** `max_turns` and `per_step_tokens` are applied by `stepSettings` (ORC-136); `per_ticket_tokens` and `on_usage_limit` by the orchestrator (ORC-340); `validate`'s worst case waits for ORC-216. */
  budgets?: { perStepTokens?: Record<string, number>; perTicketTokens?: number; maxTurns?: Record<string, number>; onUsageLimit?: 'wait' };
  /**
   * `projects[].repoPath` of config.yaml stays the working copy until the runner clones (ORC-204). `env` and
   * `secrets` are the values of what the repository's `.factory/config.yml` declares (ORC-211).
   */
  repos?: { linearTeam: string; github: string; env?: Record<string, string>; secrets?: Record<string, string> }[];
  /** Lines past which the pack's hook refuses a whole read (ORC-279); without it, the hook's own 350. */
  readGuard?: { maxLines: number };
}

/** Sealing purges the files that hold a secret: a value this short would be found in many that do not. */
const MIN_REPO_SECRET_LENGTH = 8;

/** The token of the account `claude.active` names: the only credential a runner gets (ORC-211). ORC-215 owns the choice of the account. */
export function activeClaudeToken(yml: FactoryYml | undefined): string | undefined {
  return yml?.claude?.accounts.find((a) => a.name === yml.claude?.active)?.token || undefined;
}

/** What the workflow's agent steps read of the file (ORC-136). */
export function stepSettings(yml: FactoryYml | undefined): StepSettings {
  return { effort: yml?.claude?.effort, budgets: yml?.budgets };
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
  repos: [],
  read_guard: ['max_lines'],
};
const effort = z.enum(['low', 'medium', 'high']);
const counts = z.record(z.string(), z.number().int().positive());
const REPO = /^[\w.-]+\/[\w.-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadFactoryYml(home: string, env: NodeJS.ProcessEnv = process.env): FactoryYml | undefined {
  const file = join(home, 'factory.yml');
  return existsSync(file) ? parseFactoryYml(readFileSync(file, 'utf8'), env) : undefined;
}

/** Validates the file and resolves its `env:` values; throws a FactoryYmlError naming the path of every faulty key. */
export function parseFactoryYml(text: string, env: NodeJS.ProcessEnv = process.env): FactoryYml {
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
  const budgets = section('budgets');
  if (budgets) {
    const perStepTokens = leaf('budgets.per_step_tokens', budgets['per_step_tokens'], counts, '`step: positive integer` expected');
    const perTicketTokens = leaf('budgets.per_ticket_tokens', budgets['per_ticket_tokens'], z.number().int().positive(), 'a positive integer is expected');
    const maxTurns = leaf('budgets.max_turns', budgets['max_turns'], counts, '`step: positive integer` expected');
    const onUsageLimit = leaf('budgets.on_usage_limit', budgets['on_usage_limit'], z.literal('wait'), 'only `wait` exists');
    out.budgets = {
      ...(perStepTokens ? { perStepTokens } : {}),
      ...(perTicketTokens ? { perTicketTokens } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(onUsageLimit ? { onUsageLimit } : {}),
    };
  }
  const repos = leaf(
    'repos',
    r['repos'],
    z.array(z.strictObject({ linear_team: z.string().min(1), github: z.string(), env: z.record(z.string(), z.unknown()).optional(), secrets: z.record(z.string(), z.unknown()).optional() })),
    '`[{ linear_team, github, env, secrets }]` expected',
  );
  if (repos) {
    out.repos = repos.map((repo, i) => {
      if (!REPO.test(repo.github)) violations.push(`repos[${i}].github: \`<org>/<repo>\` expected`);
      const resolved = (key: 'env' | 'secrets') => {
        const out: Record<string, string> = {};
        for (const [name, v] of Object.entries(repo[key] ?? {})) {
          const path = `repos[${i}].${key}.${name}`;
          const text = value(path, v, key === 'secrets');
          if (text === undefined) continue;
          if (key === 'secrets' && text.length < MIN_REPO_SECRET_LENGTH) violations.push(`${path}: at least ${MIN_REPO_SECRET_LENGTH} characters expected`);
          out[name] = text;
        }
        return out;
      };
      return { linearTeam: repo.linear_team, github: repo.github, ...(repo.env ? { env: resolved('env') } : {}), ...(repo.secrets ? { secrets: resolved('secrets') } : {}) };
    });
  }
  const maxLines = leaf('read_guard.max_lines', section('read_guard')?.['max_lines'], z.number().int().positive(), 'a positive integer is expected');
  if (maxLines !== undefined) out.readGuard = { maxLines };

  if (violations.length > 0) throw new FactoryYmlError(violations);
  return out;
}
