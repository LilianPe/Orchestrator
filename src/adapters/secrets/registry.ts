import { envSecretKind } from './env.js';
import { fileSecretKind } from './file.js';
import { sopsKind } from './sops.js';
import { systemdCredsKind } from './systemd-creds.js';
import type { SecretSource, SecretSourceKind } from './types.js';
import { vaultKind } from './vault.js';

/**
 * The adapters `secret_sources.<name>.kind` may name (ORC-308): an adapter is added here, by its file and this line.
 * Those that hold a manager's credential (`sops`'s key, `vault`'s token, ORC-418) came once no code of a run could read the
 * daemon's environment (ORC-151, ORC-179). `systemd-creds` needs none (ORC-398), nor `file`, the key `factory init --dev`
 * draws on a workstation (ORC-470).
 */
export const SECRET_SOURCE_KINDS: Readonly<Record<string, SecretSourceKind>> = {
  env: envSecretKind,
  'systemd-creds': systemdCredsKind,
  file: fileSecretKind,
  sops: sopsKind,
  vault: vaultKind,
};

/** The adapter `kind` names, an own entry of `kinds` only: `constructor` or `toString` name none. */
export function kindOf(kinds: Readonly<Record<string, SecretSourceKind>>, kind: string): SecretSourceKind | undefined {
  return Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
}

/** A source as `factory.yml` declares it, validated against its kind. */
export interface SecretSourceDecl {
  kind: string;
  options: Record<string, unknown>;
}

/** `env`, always there, and the sources of `secret_sources`. */
export function openSecretSources(
  declared: Record<string, SecretSourceDecl> | undefined,
  kinds: Readonly<Record<string, SecretSourceKind>> = SECRET_SOURCE_KINDS,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, SecretSource> {
  const sources: Record<string, SecretSource> = {};
  for (const [name, decl] of Object.entries({ env: { kind: 'env', options: {} }, ...declared })) {
    const kind = kindOf(kinds, decl.kind);
    if (!kind) throw new Error(`secret_sources.${name}: no adapter ${decl.kind}`);
    sources[name] = kind.create(decl.options, env);
  }
  return sources;
}
