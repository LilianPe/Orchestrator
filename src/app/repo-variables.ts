import { execCmd, mustExec, type Exec } from '../adapters/exec.js';
import { githubRepoOf } from '../adapters/forge/github-ingest.js';
import { originHead } from '../adapters/workspace/git-workspaces.js';
import type { FactoryYml } from '../config/factory-yml.js';
import { parseRepoConfig, type RepoConfig } from '../config/repo-config.js';
import { NO_REPO_VARIABLES, repoVariables, type RepoVariables } from '../config/repo-variables.js';

/**
 * The variables of a project's repository at each launch (ORC-211): its entry in `factory.yml`, found by
 * its team and its `origin` on GitHub, and what `.factory/config.yml` declares on the default branch,
 * never in a worktree the agent writes. A failure is the caller's: a launch goes on without them, and a
 * setup that needs a secret then fails by itself.
 * ponytail: its own read of the config, for these two keys; ORC-209 C reads it whole at the launch.
 * The agent has neither `origin` nor `origin/HEAD` of this repository to write: its git dir is its own (ORC-317).
 */
/**
 * Where a project's forge is, read once by process (ORC-151): `bootstrap` asks it before any run starts.
 * ponytail: the URL should come from the instance's configuration (`factory.yml`), with ORC-273's forge.
 */
export function makeOriginUrl(o: { exec?: Exec } = {}): (project: { repoPath: string }) => Promise<string> {
  const exec = o.exec ?? execCmd;
  const known = new Map<string, string>();
  return async ({ repoPath }) => {
    const seen = known.get(repoPath);
    if (seen) return seen;
    const url = (await mustExec(exec, 'git', ['-C', repoPath, 'config', '--get', 'remote.origin.url'])).trim();
    known.set(repoPath, url);
    return url;
  };
}

export function makeRepoVariables(o: { yml: FactoryYml | undefined; log: (message: string) => void; exec?: Exec }): (project: { id: string; repoPath: string; teamKey: string }, config?: RepoConfig) => Promise<RepoVariables> {
  const exec = o.exec ?? execCmd;
  const github = githubRepoOf(exec);
  return async ({ id, repoPath, teamKey }, config) => {
    const entries = o.yml?.repos?.filter((r) => r.linearTeam === teamKey);
    if (!entries?.length) return NO_REPO_VARIABLES;
    const name = (await github(repoPath))?.toLowerCase();
    const server = entries.find((r) => r.github.toLowerCase() === name);
    if (!server) return NO_REPO_VARIABLES;
    // `config`: the file as `verify` read it from the forge (ORC-151), not through a ref of this repository.
    const file = config ? undefined : await exec('git', ['-C', repoPath, 'show', `${await originHead(exec, repoPath)}:.factory/config.yml`]);
    const vars = repoVariables(config ?? parseRepoConfig(file?.code === 0 ? file.stdout : undefined), server);
    if (vars.missing.length) o.log(`${id} : variables déclarées par le dépôt, sans valeur dans factory.yml, absentes du runner : ${vars.missing.join(', ')}`);
    return vars;
  };
}
