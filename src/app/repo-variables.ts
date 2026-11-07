import { execCmd, mustExec, type Exec } from '../adapters/exec.js';
import { githubRepoOf } from '../adapters/forge/github-ingest.js';
import { originHead } from '../adapters/workspace/git-workspaces.js';
import type { FactoryYml } from '../config/factory-yml.js';
import { parseRepoConfig, type RepoConfig } from '../config/repo-config.js';
import { NO_REPO_VARIABLES, repoVariables, type RepoVariables } from '../config/repo-variables.js';

/**
 * `.factory/config.yml` of a project's repository, read once at each launch (ORC-209 C): on its default branch as
 * the factory's repository has it (`originHead`), never in a worktree the agent writes nor on its branch. The agent
 * has neither `origin` nor `origin/HEAD` of this repository to write: its git dir is its own (ORC-317). No file: the
 * socle. An invalid file, or a default branch git cannot read, rejects: no run starts on a config half read.
 */
export function makeRepoConfig(o: { exec?: Exec } = {}): (project: { repoPath: string }) => Promise<RepoConfig> {
  const exec = o.exec ?? execCmd;
  return async ({ repoPath }) => {
    // A worktree that already exists is prepared without a fetch: what was merged since applies all the same.
    await mustExec(exec, 'git', ['-C', repoPath, 'fetch', '--quiet', 'origin']);
    const ref = await originHead(exec, repoPath);
    // `ls-tree` tells a file absent from a branch it could not read, which `git show` answers alike.
    const entry = await mustExec(exec, 'git', ['-C', repoPath, 'ls-tree', '-z', ref, '--', REPO_CONFIG_PATH]).catch((err: Error) => {
      throw new Error(`branche par défaut illisible (${ref}) : ${err.message} ; si ce n'est pas la branche par défaut, lancez \`git remote set-head origin --auto\` dans ${repoPath}`);
    });
    if (!entry) return parseRepoConfig(undefined);
    const blob = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(entry)?.[1];
    if (!blob) throw new Error(`${REPO_CONFIG_PATH} n'est pas un fichier sur ${ref} (lien symbolique ou dossier)`);
    return parseRepoConfig(await mustExec(exec, 'git', ['-C', repoPath, 'cat-file', 'blob', blob]));
  };
}

const REPO_CONFIG_PATH = '.factory/config.yml';

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

/**
 * The variables of a project's repository at each launch (ORC-211): its entry in `factory.yml`, found by its team and
 * its `origin` on GitHub, and the names `config` declares, as the launch (`makeRepoConfig`) or `verify` (ORC-151) read it.
 */
export function makeRepoVariables(o: { yml: FactoryYml | undefined; log: (message: string) => void; exec?: Exec }): (project: { id: string; repoPath: string; teamKey: string }, config: RepoConfig) => Promise<RepoVariables> {
  const exec = o.exec ?? execCmd;
  const github = githubRepoOf(exec);
  return async ({ id, repoPath, teamKey }, config) => {
    const entries = o.yml?.repos?.filter((r) => r.linearTeam === teamKey);
    if (!entries?.length) return NO_REPO_VARIABLES;
    const name = (await github(repoPath))?.toLowerCase();
    const server = entries.find((r) => r.github.toLowerCase() === name);
    if (!server) return NO_REPO_VARIABLES;
    const vars = repoVariables(config, server);
    if (vars.missing.length) o.log(`${id} : variables déclarées par le dépôt, sans valeur dans factory.yml, absentes du runner : ${vars.missing.join(', ')}`);
    return vars;
  };
}
