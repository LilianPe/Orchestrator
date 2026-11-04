import type { RepoConfig } from './repo-config.js';

/** What the runner gets of a repository (ORC-211): `env` for the setup and the agent, `setupSecrets` for the setup alone. */
export interface RepoVariables {
  env: Record<string, string>;
  setupSecrets: Record<string, string>;
  /** Declared by the repository, with no value on the server: absent from the runner, for the daemon's log. */
  missing: string[];
}

export const NO_REPO_VARIABLES: RepoVariables = Object.freeze({ env: Object.freeze({}), setupSecrets: Object.freeze({}), missing: Object.freeze([]) as unknown as string[] });

/**
 * A variable passes when the repository declares its name and the server gives its value. The repository
 * alone cannot name a variable of the daemon and be handed it; the server alone does not put one in a
 * runner. Each list is read in its own map: a declared `env` is never filled from a secret.
 */
export function repoVariables(config: RepoConfig, server: { env?: Record<string, string> | undefined; secrets?: Record<string, string> | undefined } | undefined): RepoVariables {
  const out: RepoVariables = { env: {}, setupSecrets: {}, missing: [] };
  const pick = (names: readonly string[], from: Record<string, string> | undefined, into: Record<string, string>) => {
    for (const name of names) {
      const value = from && Object.hasOwn(from, name) ? from[name] : undefined;
      if (value === undefined) out.missing.push(name);
      else into[name] = value;
    }
  };
  pick(config.env, server?.env, out.env);
  pick(config.setupSecrets, server?.secrets, out.setupSecrets);
  return out;
}
