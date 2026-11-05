import { execCmd, type Exec } from '../adapters/exec.js';
import { githubRepoOf } from '../adapters/forge/github-ingest.js';
import { originHead } from '../adapters/workspace/git-workspaces.js';
import type { FactoryYml } from '../config/factory-yml.js';
import { parseRepoConfig } from '../config/repo-config.js';
import { NO_REPO_VARIABLES, repoVariables, type RepoVariables } from '../config/repo-variables.js';

/**
 * The variables of a project's repository at each launch (ORC-211): its entry in `factory.yml`, found by
 * its team and its `origin` on GitHub, and what `.factory/config.yml` declares on the default branch,
 * never in a worktree the agent writes. A failure is the caller's: a launch goes on without them, and a
 * setup that needs a secret then fails by itself.
 * ponytail: its own read of the config, for these two keys; ORC-209 C reads it whole at the launch.
 * Until the agent loses its read-write `.git` (ORC-205), `origin/HEAD` is a ref it could move, and
 * `origin` too before its first read here: the team bounds that to the entries of the project's own team.
 */
export function makeRepoVariables(o: { yml: FactoryYml | undefined; log: (message: string) => void; exec?: Exec }): (project: { id: string; repoPath: string; teamKey: string }) => Promise<RepoVariables> {
  const exec = o.exec ?? execCmd;
  const github = githubRepoOf(exec);
  return async ({ id, repoPath, teamKey }) => {
    const entries = o.yml?.repos?.filter((r) => r.linearTeam === teamKey);
    if (!entries?.length) return NO_REPO_VARIABLES;
    const name = (await github(repoPath))?.toLowerCase();
    const server = entries.find((r) => r.github.toLowerCase() === name);
    if (!server) return NO_REPO_VARIABLES;
    const file = await exec('git', ['-C', repoPath, 'show', `${await originHead(exec, repoPath)}:.factory/config.yml`]);
    const vars = repoVariables(parseRepoConfig(file.code === 0 ? file.stdout : undefined), server);
    if (vars.missing.length) o.log(`${id} : variables déclarées par le dépôt, sans valeur dans factory.yml, absentes du runner : ${vars.missing.join(', ')}`);
    return vars;
  };
}
