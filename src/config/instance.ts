import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { FactoryYml } from './factory-yml.js';

/**
 * The roles of a project no source gives (ORC-186), by Linear user id, until `.factory/config.yml`
 * (ORC-209): designated maintainers (`/refreeze`) and spec validators, and the GitHub login of each
 * Linear user whose rights on the repo count (Linear gives none the factory can read).
 */
const authzSchema = z.object({
  maintainers: z.array(z.string().min(1)).default([]),
  validators: z.array(z.string().min(1)).default([]),
  githubLogins: z.record(z.string().min(1), z.string().min(1)).default({}),
});

const projectSchema = z.object({
  id: z.string().min(1),
  repoPath: z.string().min(1),
  linearTeamKey: z.string().min(1),
  authz: authzSchema.optional(),
});

const idSchema = z.union([z.string().min(1), z.number().int().positive()]).transform(String);

const githubSchema = z.object({
  appId: idSchema,
  /** PEM inline, or a path to a PEM file. Resolved by resolveGithubApp before use. */
  privateKey: z.string().min(1),
  installationId: idSchema.optional(),
  webhookSecret: z.string().optional(),
});

const instanceSchema = z.object({
  port: z.number().int().positive().default(4100),
  host: z.string().default('127.0.0.1'),
  publicUrl: z.string().url().optional(),
  relay: z.discriminatedUnion('kind', [z.object({ kind: z.literal('smee'), url: z.string().url() }), z.object({ kind: z.literal('none') })]).default({ kind: 'none' }),
  projects: z.array(projectSchema).default([]),
  // The daily budget in dollars is gone (ORC-216, ORC-194): a config.yaml that still has its key loads without it.
  limits: z.object({}).default({}),
  knowledge: z.object({ repoPath: z.string() }).optional(),
  github: githubSchema.optional(),
});

export type ProjectConfig = z.infer<typeof projectSchema>;
export type GithubConfig = z.infer<typeof githubSchema>;
export type InstanceConfig = z.infer<typeof instanceSchema>;

export interface LinearSecrets {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  appUserId?: string;
  organizationId?: string;
}

export interface Secrets {
  linear?: LinearSecrets;
}

export function factoryHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['FACTORY_HOME'] ?? join(env['HOME'] ?? homedir(), '.factory');
}

export function homePaths(home: string) {
  return {
    config: join(home, 'config.yaml'),
    secrets: join(home, 'secrets.json'),
    runSettings: join(home, 'run-settings.json'),
    db: join(home, 'factory.db'),
    transcripts: join(home, 'transcripts'),
    workspaces: join(home, 'workspaces'),
    logs: join(home, 'logs'),
    /** Each ticket's Claude session dir, mounted as `~/.claude` of its sandboxes (ORC-204). */
    sessions: join(home, 'sessions'),
    /** Each sandboxed run's own dir: its refusals log, its `~/.claude` out of the ticket session (ORC-217). */
    runs: join(home, 'runs'),
    /** The egress proxy's socket and connection journal of each sandboxed run (ORC-213). */
    network: join(home, 'network'),
    /** The egress CA (ORC-213): its key is the daemon's, never mounted in a sandbox. */
    egressCa: join(home, 'egress-ca'),
  };
}

function ensureTree(home: string): void {
  const p = homePaths(home);
  for (const dir of [home, p.transcripts, p.workspaces, p.logs, p.sessions, p.runs]) mkdirSync(dir, { recursive: true });
}

function validate(raw: unknown): InstanceConfig {
  const res = instanceSchema.safeParse(raw ?? {});
  if (!res.success) {
    const i = res.error.issues[0]!;
    throw new Error(`invalid config.yaml: ${i.path.join('.')}: ${i.message}`);
  }
  return res.data;
}

export function loadInstance(home: string): InstanceConfig {
  const file = homePaths(home).config;
  return validate(existsSync(file) ? parse(readFileSync(file, 'utf8')) : {});
}

export function saveInstance(home: string, cfg: InstanceConfig): void {
  const valid = validate(cfg);
  ensureTree(home);
  writeFileSync(homePaths(home).config, stringify(valid));
}

export function loadSecrets(home: string): Secrets {
  const file = homePaths(home).secrets;
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Secrets) : {};
}

/** The secret values of the secrets file (identifiers left out): masked in run transcripts. */
export function secretValues(s: Secrets): string[] {
  const l = s.linear;
  return [l?.clientSecret, l?.webhookSecret, l?.accessToken, l?.refreshToken].filter((v): v is string => !!v);
}

/**
 * The instance as the daemon runs it: `config.yaml`, its GitHub App taken from `factory.yml` (read once, at the
 * daemon's start) when declared there (ORC-209). Never saved: `saveInstance` takes `loadInstance`, so a secret of the environment never reaches the file.
 */
export function effectiveInstance(home: string, yml: FactoryYml | undefined): InstanceConfig {
  const cfg = loadInstance(home);
  // Field by field: an installation id or webhook secret left in config.yaml stays.
  return yml?.github ? { ...cfg, github: { ...cfg.github, ...yml.github } } : cfg;
}

/**
 * Linear as the daemon uses it: the OAuth tokens of `secrets.json`, its static values (client id and secret,
 * webhook secret) taken from `factory.yml` when declared there (ORC-209). Read only: tokens go through `saveLinearTokens`.
 */
export function linearSettings(home: string, yml: FactoryYml | undefined): LinearSecrets | undefined {
  const stored = loadSecrets(home).linear;
  if (!stored && !yml?.linear) return undefined;
  const fromYml = Object.fromEntries(Object.entries(yml?.linear ?? {}).filter(([, v]) => v !== undefined));
  return { clientId: '', clientSecret: '', webhookSecret: '', ...stored, ...fromYml };
}

/** Writes Linear's OAuth tokens and identifiers to `secrets.json`, leaving its static values as they are there. */
export function saveLinearTokens(home: string, patch: Partial<Omit<LinearSecrets, 'clientId' | 'clientSecret' | 'webhookSecret'>>): void {
  const s = loadSecrets(home);
  saveSecrets(home, { ...s, linear: { clientId: '', clientSecret: '', webhookSecret: '', ...s.linear, ...patch } });
}

/** Every secret the daemon holds, from `secrets.json` and `factory.yml`: masked in run transcripts. */
export function daemonSecretValues(home: string, yml: FactoryYml | undefined): string[] {
  const fromYml = [
    yml?.github?.privateKey,
    yml?.github?.webhookSecret,
    ...(yml?.claude?.accounts.map((a) => a.token) ?? []),
    ...(yml?.repos?.flatMap((r) => Object.values(r.secrets ?? {})) ?? []),
  ];
  return [...new Set([...secretValues({ linear: linearSettings(home, yml) }), ...fromYml.filter((v): v is string => !!v)])];
}

/**
 * Mode 0600 on POSIX. Windows has no mode bits (chmod only sets read-only): the file takes the ACL of its folder, so
 * FACTORY_HOME must be in a folder only the factory's user can read (docs/installation.md).
 */
export function saveSecrets(home: string, s: Secrets): void {
  ensureTree(home);
  const file = homePaths(home).secrets;
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
