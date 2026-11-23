import { parse, stringify } from 'yaml';
import { SecretReader } from '../adapters/secrets/reader.js';
import { openSecretSources, SECRET_SOURCE_KINDS } from '../adapters/secrets/registry.js';
import { refText, type SecretRef, type SecretSource, type SecretSourceKind } from '../adapters/secrets/types.js';
import { DAY_MS } from '../core/baseline.js';
import { FactoryYmlError, factoryYmlText, parseFactoryYml, type FactoryYml } from './factory-yml.js';
import { effectiveInstance, secretsText } from './instance.js';
import { secretsKeyNeeded } from './start-refusals.js';
import { isSealed, SECRETS_KEY_REQUIRED } from './secrets-file.js';

/** Past this, `doctor` says a secret's rotation is too old (ORC-398, ORC-222 criterion 4). */
export const ROTATION_MAX_DAYS = 180;

const IN_CLEAR_ENV = "in clear in the daemon's environment: a sealed source (systemd-creds) keeps it off the disk";
const IN_CLEAR_ENV_OPTION = "in clear in the daemon's environment, where a source's options are read from: a file option (vault's token_file) keeps it out of it";
const IN_CLEAR_KEY_FILE = "in clear in a file, the key to every secret of its source: no other user may read or write it (its group may, for a Vault Agent's token_file)";
const IN_CLEAR_FILE = "in clear in a file, its owner's alone: for a workstation; on a server, a sealed source (systemd-creds) keeps it off the disk";

export interface SealedFactoryYml {
  yml?: FactoryYml;
  /** The values read from a source other than `env`, by their reference (undefined: not read): what `claudeAccountReader` re-reads with. */
  sealed: ReadonlyMap<string, string | undefined>;
  /** The reader of every source: the server's values already in it, for the masking; it reads the repositories' at each setup. */
  reader: SecretReader;
}

/**
 * `factory.yml` with its server secrets read (ORC-398): a first pass finds their references, each one of another source than
 * `env` is read once through a `SecretReader`, then the file is parsed with the values. A source that fails throws a
 * FactoryYmlError naming the key and its reference, never a value: the daemon does not start.
 */
export async function loadSealedFactoryYml(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  /** `only`: the sections (`github`) or keys (`secrets_key`) to read; every one when absent. */
  o: { kinds?: Readonly<Record<string, SecretSourceKind>>; only?: readonly string[] } = {},
): Promise<SealedFactoryYml> {
  return sealedFrom(factoryYmlText(home), env, o);
}

/**
 * factory.yml's `secrets_key` alone, read from its source (ORC-470): what `factory init` seals Linear's values with, in a shell that
 * need not hold the daemon's other variables. Undefined without one; a source that fails throws, naming the key, never a value.
 */
export async function readSecretsKey(home: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const text = factoryYmlText(home);
  if (text === undefined) return undefined;
  const raw = parse(text) as Record<string, unknown> | null;
  const ref = raw?.['secrets_key'];
  if (ref == null) return undefined;
  // Its own source alone: another one's `env:` options need not be in this shell.
  const source = typeof ref === 'string' ? ref.slice(0, ref.indexOf(':')) : '';
  const sources = raw?.['secret_sources'] as Record<string, unknown> | null | undefined;
  const kept = { ...(sources?.[source] !== undefined ? { secret_sources: { [source]: sources[source] } } : {}), secrets_key: ref };
  return (await sealedFrom(stringify(kept), env, { only: ['secrets_key'] })).yml?.secretsKey;
}

async function sealedFrom(
  text: string | undefined,
  env: NodeJS.ProcessEnv,
  o: { kinds?: Readonly<Record<string, SecretSourceKind>>; only?: readonly string[] },
): Promise<SealedFactoryYml> {
  const kinds = o.kinds ?? SECRET_SOURCE_KINDS;
  const draft = text === undefined ? undefined : parseFactoryYml(text, env, kinds, 'defer');
  const reader = new SecretReader(openSecretSources(draft?.secretSources, kinds, env));
  const refs = Object.entries(draft?.secretRefs ?? {}).filter(([, ref]) => ref.source !== 'env');
  // A command reads only the sections it needs: the others stay unset, so a source out of its reach does not stop it.
  const wanted = refs.filter(([key]) => !o.only || o.only.some((s) => key === s || key.startsWith(`${s}.`)));
  let values: Record<string, string>;
  try {
    values = await reader.read(Object.fromEntries(wanted), 1);
  } catch (err) {
    throw new FactoryYmlError([(err as Error).message]);
  }
  const sealed = new Map<string, string | undefined>(refs.map(([key, ref]) => [refText(ref), values[key]]));
  return { yml: text === undefined ? undefined : parseFactoryYml(text, env, kinds, sealed), sealed, reader };
}

/** The sections whose secrets a CLI command reads besides `env:` (ORC-398): Linear's, with the key of `secrets.json` that holds its tokens; the GitHub App's. */
export const LINEAR_SECRETS = ['linear', 'secrets_key'] as const;
export const GITHUB_APP_SECRETS = ['github'] as const;

/** One line of `doctor`'s instance section: a server secret, where it is kept, its rotation. */
export interface SecretReport {
  /** Its key: `github.private_key`, or `secrets.json` for the file the daemon writes. */
  key: string;
  /** Its reference, or the file that holds it. */
  reference?: string;
  inClear: boolean;
  /** Its last rotation, as its source knows it (ISO 8601). */
  rotatedAt?: string;
  warnings: string[];
}

/**
 * What `doctor` says of the server secrets (ORC-398): for each reference of factory.yml, whether it is in clear (`env`) and its
 * rotation date (`describe`), warned past `ROTATION_MAX_DAYS` or when unknown; a missing `secrets_key` off the loopback, which
 * refuses the start; a GitHub key in `GH_APP_KEY`; and whether `secrets.json` is encrypted; a source's own key file (`credentialFiles`). No value is returned (`sops` and `vault` read one to know a path is held).
 */
export async function serverSecretReport(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  o: { now?: number; kinds?: Readonly<Record<string, SecretSourceKind>> } = {},
): Promise<SecretReport[]> {
  const now = o.now ?? Date.now();
  const kinds = o.kinds ?? SECRET_SOURCE_KINDS;
  const text = factoryYmlText(home);
  const yml = text === undefined ? undefined : parseFactoryYml(text, env, kinds, 'defer');
  const sources = openSecretSources(yml?.secretSources, kinds, env);
  const reports: SecretReport[] = [];
  /** The keys of the sources' options its adapter names in `field`, `secret_sources.<name>.<option>`. */
  const optionKeys = (field: 'credentialOptions' | 'credentialFiles'): Set<string> =>
    new Set(Object.entries(yml?.secretSources ?? {}).flatMap(([name, decl]) => (kinds[decl.kind]?.[field] ?? []).map((option) => `secret_sources.${name}.${option}`)));
  const credentials = optionKeys('credentialOptions');
  const keyFiles = optionKeys('credentialFiles');
  for (const [key, ref] of Object.entries(yml?.secretRefs ?? {})) {
    // A key file's path written `env:NAME`: said once, below, by the file it names.
    if (!keyFiles.has(key)) reports.push(await describeRef(key, ref, yml, sources, now, credentials.has(key)));
  }
  // A source's own key, in clear on the disk though the secrets it opens are sealed (ORC-418).
  for (const [name, decl] of Object.entries(yml?.secretSources ?? {})) {
    for (const option of kinds[decl.kind]?.credentialFiles ?? []) {
      const file = decl.options[option];
      if (typeof file === 'string') reports.push({ key: `secret_sources.${name}.${option}`, reference: file, inClear: true, warnings: [IN_CLEAR_KEY_FILE] });
    }
  }
  const instance = effectiveInstance(yml);
  const stored = secretsText(home);
  // The daemon does not start without it off the loopback, said whether or not secrets.json exists yet, nor beside Linear (ORC-470).
  const needed = secretsKeyNeeded(home, instance, yml);
  const keyMissing = needed !== undefined;
  if (needed) {
    const why = needed === 'exposed' ? `host: ${instance.host}` : 'Linear is set up';
    reports.push({ key: 'secrets_key', inClear: false, warnings: [`missing, the daemon refuses to start (${why}): ${SECRETS_KEY_REQUIRED}`] });
  }
  if (!yml?.secretRefs?.['github.private_key'] && env['GH_APP_KEY']) {
    reports.push({ key: 'github.privateKey', reference: 'env:GH_APP_KEY', inClear: true, warnings: [IN_CLEAR_ENV] });
  }
  if (stored !== undefined) {
    const sealed = isSealed(stored);
    reports.push({ key: 'secrets.json', inClear: !sealed, warnings: sealed ? [] : [keyMissing ? 'in clear on disk' : 'in clear on disk: the daemon encrypts it with secrets_key at its start'] });
  }
  return reports;
}

async function describeRef(
  key: string,
  ref: SecretRef,
  yml: FactoryYml | undefined,
  sources: Record<string, SecretSource>,
  now: number,
  /** A source's credential option (`credentialOptions`): read from the environment alone, it cannot move to a sealed source. */
  sourceCredential = false,
): Promise<SecretReport> {
  const reference = refText(ref);
  const kind = ref.source === 'env' ? 'env' : yml?.secretSources?.[ref.source]?.kind;
  if (kind === 'env') return { key, reference, inClear: true, warnings: [sourceCredential ? IN_CLEAR_ENV_OPTION : IN_CLEAR_ENV] };
  // A workstation's key, mode 0600 (ORC-470): in clear on its disk all the same.
  const inClear = kind === 'file';
  const clear = inClear ? [IN_CLEAR_FILE] : [];
  let rotatedAt: Date | undefined;
  try {
    rotatedAt = (await sources[ref.source]?.describe?.(ref.path))?.rotatedAt;
  } catch (err) {
    return { key, reference, inClear, warnings: [...clear, `its rotation date could not be read: ${(err as Error).message}`] };
  }
  // Rotating `secrets_key` would leave secrets.json unreadable, nothing re-encrypts it yet: never asked for.
  const rotates = key !== 'secrets_key';
  if (!rotatedAt) return { key, reference, inClear, warnings: [...clear, ...(rotates ? ['its source knows no rotation date'] : [])] };
  const days = Math.floor((now - rotatedAt.getTime()) / DAY_MS);
  const stale = rotates && days > ROTATION_MAX_DAYS;
  return { key, reference, inClear, rotatedAt: rotatedAt.toISOString(), warnings: [...clear, ...(stale ? [`rotated ${days} days ago, past ${ROTATION_MAX_DAYS}`] : [])] };
}

/** The report in text, for `doctor`. */
export function serverSecretLines(reports: readonly SecretReport[]): string[] {
  if (reports.length === 0) return [];
  return [
    'Server secrets:',
    ...reports.map((r) => {
      const state = [r.inClear ? 'in clear' : 'sealed', ...(r.rotatedAt ? [`rotated ${r.rotatedAt.slice(0, 10)}`] : [])].join(', ');
      return `  ${r.key}${r.reference ? ` (${r.reference})` : ''}: ${state}${r.warnings.map((w) => ` — warning: ${w}`).join('')}`;
    }),
  ];
}
