import { SecretReader } from '../adapters/secrets/reader.js';
import { openSecretSources, SECRET_SOURCE_KINDS } from '../adapters/secrets/registry.js';
import { refText, type SecretRef, type SecretSource, type SecretSourceKind } from '../adapters/secrets/types.js';
import { DAY_MS } from '../core/baseline.js';
import { FactoryYmlError, factoryYmlText, parseFactoryYml, type FactoryYml } from './factory-yml.js';
import { loadInstance, secretsText } from './instance.js';
import { isSealed } from './secrets-file.js';

/** Past this, `doctor` says a secret's rotation is too old (ORC-398, ORC-222 criterion 4). */
export const ROTATION_MAX_DAYS = 180;

const IN_CLEAR_ENV = "in clear in the daemon's environment: a sealed source (systemd-creds) keeps it off the disk";

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
  const kinds = o.kinds ?? SECRET_SOURCE_KINDS;
  const text = factoryYmlText(home);
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
 * rotation date (`describe`), warned past `ROTATION_MAX_DAYS` or when unknown; a GitHub key left in config.yaml or `GH_APP_KEY`;
 * and whether `secrets.json` is encrypted. No value is read.
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
  for (const [key, ref] of Object.entries(yml?.secretRefs ?? {})) reports.push(await describeRef(key, ref, yml, sources, now));
  // A copy left in config.yaml is still on the disk, even when factory.yml's reference replaces it.
  if (loadInstance(home).github?.privateKey) {
    reports.push({ key: 'github.privateKey', reference: 'config.yaml', inClear: true, warnings: ['in clear on disk: write github.private_key in factory.yml with a sealed source (systemd-creds)'] });
  } else if (!yml?.secretRefs?.['github.private_key'] && env['GH_APP_KEY']) {
    reports.push({ key: 'github.privateKey', reference: 'env:GH_APP_KEY', inClear: true, warnings: [IN_CLEAR_ENV] });
  }
  const stored = secretsText(home);
  if (stored !== undefined) {
    const sealed = isSealed(stored);
    reports.push({ key: 'secrets.json', inClear: !sealed, warnings: sealed ? [] : ['in clear on disk: set secrets_key in factory.yml to encrypt it'] });
  }
  return reports;
}

async function describeRef(key: string, ref: SecretRef, yml: FactoryYml | undefined, sources: Record<string, SecretSource>, now: number): Promise<SecretReport> {
  const reference = refText(ref);
  const kind = ref.source === 'env' ? 'env' : yml?.secretSources?.[ref.source]?.kind;
  if (kind === 'env') return { key, reference, inClear: true, warnings: [IN_CLEAR_ENV] };
  let rotatedAt: Date | undefined;
  try {
    rotatedAt = (await sources[ref.source]?.describe?.(ref.path))?.rotatedAt;
  } catch (err) {
    return { key, reference, inClear: false, warnings: [`its rotation date could not be read: ${(err as Error).message}`] };
  }
  // Rotating `secrets_key` would leave secrets.json unreadable, nothing re-encrypts it yet: never asked for.
  const rotates = key !== 'secrets_key';
  if (!rotatedAt) return { key, reference, inClear: false, warnings: rotates ? ['its source knows no rotation date'] : [] };
  const days = Math.floor((now - rotatedAt.getTime()) / DAY_MS);
  const stale = rotates && days > ROTATION_MAX_DAYS;
  return { key, reference, inClear: false, rotatedAt: rotatedAt.toISOString(), warnings: stale ? [`rotated ${days} days ago, past ${ROTATION_MAX_DAYS}`] : [] };
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
