import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { FactoryYml } from './factory-yml.js';
import { isSealed, openSecretsFile, sealSecretsFile } from './secrets-file.js';
import { validatorsNeeded } from '../core/authz.js';

/** The preset of the replay of closed tickets (ORC-231), named here without loading the presets: `isFantome` reads `fantome.name`. */
const FANTOME = 'factory/fantome';

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
  /** `none` (ORC-231): nothing of the project leaves the factory, its effects are kept as artifacts of its runs. */
  effects: z.literal('none').optional(),
  /** The preset its runs follow (ORC-231): `factory/fantome` replays closed tickets, at the Rapide level, always without effects. */
  preset: z.literal(FANTOME).optional(),
});

const idSchema = z.union([z.string().min(1), z.number().int().positive()]).transform(String);

const githubSchema = z.object({
  appId: idSchema,
  /** PEM inline, or a path to a PEM file. Resolved by resolveGithubApp before use. */
  privateKey: z.string().min(1),
  installationId: idSchema.optional(),
  webhookSecret: z.string().optional(),
  /** The App's OAuth client, for the dashboard's GitHub sign-in (ORC-399). */
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

const instanceSchema = z.object({
  port: z.number().int().positive().default(4100),
  host: z.string().default('127.0.0.1'),
  publicUrl: z.string().url().optional(),
  relay: z.discriminatedUnion('kind', [z.object({ kind: z.literal('smee'), url: z.string().url() }), z.object({ kind: z.literal('none') })]).default({ kind: 'none' }),
  /** The development mode (ORC-444), written by `factory init --dev` alone: the daemon starts the Smee relay only in it. */
  dev: z.boolean().optional(),
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
    /** The daemon's Unix socket for the CLI on its server (ORC-405), 0600 in a folder 0700: no GitHub sign-in through it. */
    socket: join(home, 'cli', 'factory.sock'),
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
    /** The effects of the projects without effects, kept instead of made (ORC-231). */
    kept: join(home, 'kept'),
    /** The replays of closed tickets (ORC-231, ORC-376): each ticket's clone and its text as of its start, `<replay>/<ticket>/`. */
    ghost: join(home, 'ghost'),
    /** The visual proof's captures (ORC-176, ORC-404), `<ticket>/<sha256>.png`: no run mounts it. */
    artifacts: join(home, 'artifacts'),
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

/**
 * The ids of config.yaml's projects as the file is now (ORC-454): one `factory init` added while the daemon runs included, one
 * removed left out. `fallback` when the file does not read (an edit under way).
 */
export function currentProjectIds(home: string, fallback: readonly string[]): readonly string[] {
  try {
    return loadInstance(home).projects.map((p) => p.id);
  } catch {
    return fallback;
  }
}

export function saveInstance(home: string, cfg: InstanceConfig): void {
  const valid = validate(cfg);
  ensureTree(home);
  writeFileSync(homePaths(home).config, stringify(valid));
}

/**
 * `secrets.json`, opened with `key` when it is encrypted at rest (ORC-398): factory.yml's `secrets_key`. A plaintext file, as
 * written before, is still read; a sealed one without its key throws.
 */
export function loadSecrets(home: string, key?: string): Secrets {
  return parseSecrets(secretsText(home), key);
}

/** The text of `secrets.json`, undefined when there is none. */
export function secretsText(home: string): string | undefined {
  try {
    return readFileSync(homePaths(home).secrets, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function parseSecrets(text: string | undefined, key?: string): Secrets {
  if (text === undefined) return {};
  if (!isSealed(text)) return JSON.parse(text) as Secrets;
  if (!key) throw new Error('secrets.json is encrypted at rest: it is read with the key secrets_key of factory.yml names, which the daemon reads at its start');
  return JSON.parse(openSecretsFile(text, key)) as Secrets;
}

/** The secret values of the secrets file (identifiers left out): masked in run transcripts. */
export function secretValues(s: Secrets): string[] {
  const l = s.linear;
  return [l?.clientSecret, l?.webhookSecret, l?.accessToken, l?.refreshToken].filter((v): v is string => !!v);
}

/**
 * A name of the loopback: `host` without a password listens there, and the interface without a password answers under
 * these names alone (ORC-349). Not `publicUrl`'s, which a tunnel brings here: the webhooks and the OAuth callback answer
 * under any name, the interface does not. A rebound name is never one of these.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
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

/** Whether two paths name one directory: a project's `repoPath` an older init wrote in another form (`C:/x`, `x/`) is the same repo. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

/**
 * The projects whose spec gate no validator can pass (ORC-421), for `factory doctor` and the daemon's start: every delegation
 * waits there for a designated validator's `/approve` (ORC-395), never its initiator's. With none, every ticket stops at the gate;
 * with a lone one, the tickets they delegate. The replay of closed tickets approves its own specs.
 */
export function validatorWarnings(projects: readonly Pick<ProjectConfig, 'id' | 'authz' | 'preset'>[]): string[] {
  const needed = validatorsNeeded();
  return projects.flatMap((p) => {
    if (p.preset === FANTOME) return [];
    // By id, as the role resolver reads them: one id twice is one validator.
    const count = new Set(p.authz?.validators).size;
    if (count >= needed) return [];
    if (count === 0) return [`Warning: ${p.id}: no spec validator (authz.validators in config.yaml): every ticket waits at the spec gate for a designated validator's \`/approve\`, and stops there. Designate validators by their Linear user ids.`];
    return [`Warning: ${p.id}: one spec validator (authz.validators in config.yaml): a ticket they delegate themselves stops at the spec gate, as no one may approve the spec of a run they launched. Designate a second validator.`];
  });
}

/**
 * The Smee relay in the development mode alone (ORC-444), the `dev: true` that `factory init --dev` writes, for `factory doctor` and
 * the daemon's start (ORC-446): a public channel, for a workstation, never a server. `dev: false` is refused, as is `dev: true` beside a
 * `publicUrl`, a server's or a tunnel's, which brings Linear's webhooks already; a config.yaml written before the marker, with none, is
 * a warning.
 */
export function relayWarnings(instance: Pick<InstanceConfig, 'relay' | 'dev' | 'publicUrl'>): string[] {
  if (instance.relay.kind !== 'smee') return [];
  const fix = instance.publicUrl
    ? `publicUrl: ${instance.publicUrl} brings Linear's webhooks already, set relay: { kind: none }`
    : 'on a server, set publicUrl to its https:// address and relay: { kind: none }; on a workstation, run factory init --dev (it writes dev: true)';
  if (instance.dev) {
    if (instance.publicUrl) throw new Error(`relay: { kind: smee } in config.yaml beside ${fix}, or remove publicUrl on a workstation.`);
    return [];
  }
  if (instance.dev === false) throw new Error(`relay: { kind: smee } in config.yaml outside the development mode (dev: false): a smee.io channel is public, for a workstation only: ${fix}.`);
  return [`Warning: relay: { kind: smee } in config.yaml without dev: true, the development mode factory init --dev writes: the daemon starts it as before that marker; ${fix}.`];
}

/**
 * Linear as the daemon uses it: the OAuth tokens of `secrets.json`, its static values (client id and secret,
 * webhook secret) taken from `factory.yml` when declared there (ORC-209). Read only: tokens go through `saveLinearTokens`.
 */
export function linearSettings(home: string, yml: FactoryYml | undefined): LinearSecrets | undefined {
  const stored = loadSecrets(home, yml?.secretsKey).linear;
  if (!stored && !yml?.linear) return undefined;
  const fromYml = Object.fromEntries(Object.entries(yml?.linear ?? {}).filter(([, v]) => v !== undefined));
  return { clientId: '', clientSecret: '', webhookSecret: '', ...stored, ...fromYml };
}

/** Writes Linear's OAuth tokens and identifiers to `secrets.json`, leaving its static values as they are there; encrypted with `secrets_key` when factory.yml names one (ORC-398). */
export function saveLinearTokens(home: string, patch: Partial<Omit<LinearSecrets, 'clientId' | 'clientSecret' | 'webhookSecret'>>, yml?: Pick<FactoryYml, 'secretsKey'>): void {
  const key = yml?.secretsKey;
  const s = loadSecrets(home, key);
  saveSecrets(home, { ...s, linear: { clientId: '', clientSecret: '', webhookSecret: '', ...s.linear, ...patch } }, key);
}

/** Encrypts a plaintext `secrets.json` with `key`, at the daemon's start (ORC-398): whether there was one to encrypt. */
export function sealSecretsAtRest(home: string, key: string): boolean {
  const text = secretsText(home);
  if (text === undefined || isSealed(text)) return false;
  saveSecrets(home, parseSecrets(text), key);
  return true;
}

/**
 * Every secret the daemon holds, from `secrets.json` and `factory.yml`: masked in run transcripts. A repository's `env:` secrets
 * are the daemon's own variables, masked from the start so a run reattached after a restart stays covered; those of another
 * source are masked once a setup read them (ORC-308).
 */
export function daemonSecretValues(home: string, yml: FactoryYml | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = (source: string) => source === 'env' || yml?.secretSources?.[source]?.kind === 'env';
  const repoEnv = yml?.repos?.flatMap((r) => Object.values(r.secrets ?? {}).filter((ref) => fromEnv(ref.source)).map((ref) => env[ref.path])) ?? [];
  // The server's `env:` secrets by their references, a source's option among them (ORC-398); another source's are the reader's.
  const serverEnv = Object.values(yml?.secretRefs ?? {}).filter((ref) => ref.source === 'env').map((ref) => env[ref.path]);
  const fromYml = [yml?.github?.privateKey, yml?.github?.webhookSecret, yml?.secretsKey, yml?.messageModel?.apiKey, ...(yml?.claude?.accounts.map((a) => a.token) ?? []), ...repoEnv, ...serverEnv];
  return [...new Set([...secretValues({ linear: linearSettings(home, yml) }), ...fromYml.filter((v): v is string => !!v)])];
}

/**
 * Encrypted with `key` when given (ORC-398), in clear otherwise. Mode 0600 on POSIX. Windows has no mode bits (chmod only sets
 * read-only): the file takes the ACL of its folder, so FACTORY_HOME must be in a folder only the factory's user can read
 * (docs/installation.md).
 */
export function saveSecrets(home: string, s: Secrets, key?: string): void {
  ensureTree(home);
  const file = homePaths(home).secrets;
  const text = JSON.stringify(s, null, 2);
  writeFileSync(file, key ? sealSecretsFile(text, key) : text, { mode: 0o600 });
  chmodSync(file, 0o600);
}
