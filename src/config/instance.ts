import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Document, parseDocument } from 'yaml';
import { FANTOME, FactoryYmlError, factoryYmlText, parseInstanceKeys, type FactoryYml, type ProjectConfig, type Relay } from './factory-yml.js';
import { isSealed, openSecretsFile, sealSecretsFile } from './secrets-file.js';
import { validatorsNeeded } from '../core/authz.js';

export type { ProjectConfig } from './factory-yml.js';

/** The instance as the daemon runs it (ORC-199): factory.yml's instance keys, each with its default, and its GitHub App. */
export interface InstanceConfig {
  port: number;
  host: string;
  publicUrl?: string;
  relay: Relay;
  dev?: boolean;
  projects: ProjectConfig[];
  knowledge?: { repoPath: string };
  github?: FactoryYml['github'];
}

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
    factoryYml: join(home, 'factory.yml'),
    secrets: join(home, 'secrets.json'),
    /** The daemon's Unix socket for the CLI on its server (ORC-405), 0600 in a folder 0700: no GitHub sign-in through it. */
    socket: join(home, 'cli', 'factory.sock'),
    transcripts: join(home, 'transcripts'),
    workspaces: join(home, 'workspaces'),
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
  for (const dir of [home, p.transcripts, p.workspaces, p.sessions, p.runs]) mkdirSync(dir, { recursive: true });
}

/** The instance of a factory.yml (ORC-199), each key it leaves unset at its default; the defaults alone without one. */
export function effectiveInstance(yml: FactoryYml | undefined): InstanceConfig {
  return {
    port: yml?.port ?? 4100,
    host: yml?.host ?? '127.0.0.1',
    relay: yml?.relay ?? { kind: 'none' },
    projects: yml?.projects ?? [],
    ...(yml?.publicUrl ? { publicUrl: yml.publicUrl } : {}),
    ...(yml?.dev !== undefined ? { dev: yml.dev } : {}),
    ...(yml?.knowledge ? { knowledge: yml.knowledge } : {}),
    ...(yml?.github ? { github: yml.github } : {}),
  };
}

/**
 * The instance keys of `<home>/factory.yml` alone (ORC-199), without its GitHub App nor its secrets: what the CLI reads (the
 * port it calls, the projects), in a shell without the daemon's variables. The defaults without the file: the daemon refuses to
 * start then (`startRefusals`). `config.yaml` is never read.
 */
export function loadInstance(home: string): InstanceConfig {
  const text = factoryYmlText(home);
  return effectiveInstance(text === undefined ? undefined : parseInstanceKeys(text));
}

/** A project as factory.yml writes it. */
function projectYml({ id, repoPath, linearTeamKey, authz, effects, preset }: ProjectConfig): Record<string, unknown> {
  return {
    id,
    repo_path: repoPath,
    linear_team_key: linearTeamKey,
    ...(authz ? { authz: { maintainers: authz.maintainers, validators: authz.validators, github_logins: authz.githubLogins } } : {}),
    ...(effects ? { effects } : {}),
    ...(preset ? { preset } : {}),
  };
}

/**
 * Writes the instance keys into `<home>/factory.yml` (ORC-199), for `factory init`: only those whose value, as the daemon reads
 * it, changed, so the rest of the file and the comments of what did not change stay as they are; a default the file leaves out is
 * never written. `base` is the rest of a file written where there is none. Never its GitHub App, whose key is a reference only a
 * person writes. Validated as the daemon reads it: a value it would refuse is never written. Replaced whole by a rename: the
 * daemon, which reads its Claude account there at each launch (`claudeAccountReader`), never reads it half-written.
 */
export function saveInstance(home: string, cfg: Omit<InstanceConfig, 'github'>, base?: string): void {
  const text = factoryYmlText(home) ?? base;
  const doc = text === undefined ? new Document({}) : parseDocument(text);
  if (doc.errors.length > 0) throw new FactoryYmlError([`unreadable YAML: ${doc.errors[0]!.message}`]);
  const before = effectiveInstance(text === undefined ? undefined : parseInstanceKeys(text));
  const keys: [keyof typeof cfg, string, unknown][] = [
    ['port', 'port', cfg.port],
    ['host', 'host', cfg.host],
    ['publicUrl', 'public_url', cfg.publicUrl],
    ['dev', 'dev', cfg.dev],
    ['relay', 'relay', cfg.relay],
    ['projects', 'projects', cfg.projects.map(projectYml)],
    ['knowledge', 'knowledge', cfg.knowledge && { repo_path: cfg.knowledge.repoPath }],
  ];
  for (const [key, yml, value] of keys) {
    if (isDeepStrictEqual(before[key], cfg[key])) continue;
    if (value === undefined) doc.delete(yml);
    else doc.set(yml, doc.createNode(value));
  }
  const written = doc.toString();
  parseInstanceKeys(written);
  ensureTree(home);
  const file = homePaths(home).factoryYml;
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, written);
  renameSync(temp, file);
}

/**
 * The files of the instance before ORC-199, in `home`: never read again, `factory.yml` holds what `config.yaml` held, and the
 * daemon writes neither the run settings (ORC-179) nor logs there.
 */
const OLD_INSTANCE_FILES = ['config.yaml', 'run-settings.json', 'logs']; // transition, à retirer

/**
 * What the start and `factory doctor` say of each file of the instance before ORC-199 still in `home`: not read, its content not
 * taken into `factory.yml`, to delete. Only its presence is looked at; `config.yaml` may hold the GitHub App's key in clear.
 */
export function oldInstanceFileWarnings(home: string): string[] {
  return OLD_INSTANCE_FILES.filter((name) => existsSync(join(home, name))).map((name) =>
    name === 'config.yaml'
      ? "config.yaml: left from before factory.yml, not read (ORC-199): write what it declares in factory.yml (port, host, public_url, dev, relay, projects, knowledge, github), its keys in snake_case (publicUrl is public_url, repoPath repo_path…), then delete it; it may hold the GitHub App's key in clear"
      : `${name}: left from before ORC-199, not read: delete it`,
  );
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
    if (count === 0) return [`Warning: ${p.id}: no spec validator (authz.validators in factory.yml): every ticket waits at the spec gate for a designated validator's \`/approve\`, and stops there. Designate validators by their Linear user ids.`];
    return [`Warning: ${p.id}: one spec validator (authz.validators in factory.yml): a ticket they delegate themselves stops at the spec gate, as no one may approve the spec of a run they launched. Designate a second validator.`];
  });
}

/**
 * The Smee relay in the development mode alone (ORC-444), the `dev: true` that `factory init --dev` writes, for `factory doctor` and
 * the daemon's start (ORC-446): a public channel, for a workstation, never a server. `dev: false` is refused, as is `dev: true` beside a
 * `publicUrl`, a server's or a tunnel's, which brings Linear's webhooks already; a factory.yml without the marker is
 * a warning.
 */
export function relayWarnings(instance: Pick<InstanceConfig, 'relay' | 'dev' | 'publicUrl'>): string[] {
  if (instance.relay.kind !== 'smee') return [];
  const fix = instance.publicUrl
    ? `public_url: ${instance.publicUrl} brings Linear's webhooks already, set relay: { kind: none }`
    : 'on a server, set public_url to its https:// address and relay: { kind: none }; on a workstation, run factory init --dev (it writes dev: true)';
  if (instance.dev) {
    if (instance.publicUrl) throw new Error(`relay: { kind: smee } in factory.yml beside ${fix}, or remove public_url on a workstation.`);
    return [];
  }
  if (instance.dev === false) throw new Error(`relay: { kind: smee } in factory.yml outside the development mode (dev: false): a smee.io channel is public, for a workstation only: ${fix}.`);
  return [`Warning: relay: { kind: smee } in factory.yml without dev: true, the development mode factory init --dev writes: the daemon starts it as before that marker; ${fix}.`];
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
