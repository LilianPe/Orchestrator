import { envSecretKind } from './env.js';
import type { SecretSource, SecretSourceKind } from './types.js';

/**
 * The adapters `secret_sources.<name>.kind` may name (ORC-308): an adapter is added here, by its file and this line.
 * No real secret manager before ORC-151 and ORC-179: `verify` and the host runs can read the daemon's environment,
 * so a manager's credential, worth far more than one secret.
 */
export const SECRET_SOURCE_KINDS: Readonly<Record<string, SecretSourceKind>> = {
  env: envSecretKind,
};

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
    const kind = kinds[decl.kind];
    if (!kind) throw new Error(`secret_sources.${name}: no adapter ${decl.kind}`);
    sources[name] = kind.create(decl.options, env);
  }
  return sources;
}
