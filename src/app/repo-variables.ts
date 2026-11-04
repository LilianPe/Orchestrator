import { execCmd, type Exec } from '../adapters/exec.js';
import { parseGitHubRemote } from '../adapters/forge/github-app.js';
import type { FactoryYml } from '../config/factory-yml.js';
import { parseRepoConfig } from '../config/repo-config.js';
import { NO_REPO_VARIABLES, repoVariables, type RepoVariables } from '../config/repo-variables.js';

/**
 * The variables of a project's repository at each launch (ORC-211): its entry in `factory.yml`, found by
 * its team and its `origin` on GitHub, and what `.factory/config.yml` declares on the default branch,
 * never in a worktree the agent writes. Anything that fails gives no variable and a log line: a launch goes
 * on without them, and a setup that needs a secret then fails by itself.
 * ponytail: its own read of the config, for these two keys; ORC-209 C reads it whole at the launch.
 * Until the agent loses its read-write `.git` (ORC-205), `origin` and `origin/HEAD` are refs it could move:
 * the team bounds that to the entries of the project's own team.
 */
export function makeRepoVariables(o: { yml: FactoryYml | undefined; log: (message: string) => void; exec?: Exec }): (project: { id: string; repoPath: string; teamKey: string }) => Promise<RepoVariables> {
  const exec = o.exec ?? execCmd;
  const git = (repo: string, ...args: string[]) => exec('git', ['-C', repo, ...args]);
  return async ({ id, repoPath, teamKey }) => {
    const entries = o.yml?.repos?.filter((r) => r.linearTeam === teamKey);
    if (!entries?.length) return NO_REPO_VARIABLES;
    try {
      const origin = await git(repoPath, 'remote', 'get-url', 'origin');
      const remote = origin.code === 0 ? parseGitHubRemote(origin.stdout) : undefined;
      const name = remote && `${remote.owner}/${remote.name}`.toLowerCase();
      const server = entries.find((r) => r.github.toLowerCase() === name);
      if (!server) return NO_REPO_VARIABLES;
      const head = await git(repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
      const trunk = head.code === 0 ? head.stdout.trim() : 'origin/main';
      const file = await git(repoPath, 'show', `${trunk}:.factory/config.yml`);
      const vars = repoVariables(parseRepoConfig(file.code === 0 ? file.stdout : undefined), server);
      if (vars.missing.length) o.log(`${id} : variables déclarées par le dépôt, sans valeur dans factory.yml, absentes du runner : ${vars.missing.join(', ')}`);
      return vars;
    } catch (err) {
      o.log(`${id} : variables du dépôt non lues, aucune ne passe : ${(err as Error).message}`);
      return NO_REPO_VARIABLES;
    }
  };
}
