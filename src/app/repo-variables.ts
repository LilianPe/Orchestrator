import { execCmd, execFailure, mustExec, type Exec } from '../adapters/exec.js';
import { githubRepoOf } from '../adapters/forge/github-ingest.js';
import { fetchOrigin, originHeadOf } from '../adapters/workspace/git-workspaces.js';
import type { FactoryYml } from '../config/factory-yml.js';
import { parseRepoConfig, REPO_CONFIG_DIR, REPO_CONFIG_PATH, RepoConfigError, type RepoConfig, type RepoConfigRead } from '../config/repo-config.js';
import { NO_REPO_VARIABLES, repoVariables, type RepoVariables } from '../config/repo-variables.js';

/**
 * `.factory/config.yml` of a project's repository, read once at each launch (ORC-209 C): on its default branch as
 * the factory's repository has it (`originHead`), never in a worktree the agent writes nor on its branch. The agent
 * has neither `origin` nor `origin/HEAD` of this repository to write: its git dir is its own (ORC-317). No file: the
 * socle. An invalid file, or a default branch git cannot read, rejects: no run starts on a config half read.
 */
export function makeRepoConfig(o: { exec?: Exec; fetchDeadlineMs?: number; log?: (message: string) => void } = {}): (project: { repoPath: string }, read?: RepoConfigRead) => Promise<RepoConfig> {
  const exec = o.exec ?? execCmd;
  return async ({ repoPath }, { fetch = true } = {}) => {
    // A failure's message reaches the ticket (Linear): never the server's path nor the command, which go to the daemon's log.
    const git = async (args: string[], failure: () => string): Promise<string> => {
      const r = await exec('git', ['-C', repoPath, ...args]);
      if (r.code === 0) return r.stdout;
      o.log?.(`${REPO_CONFIG_PATH}: ${execFailure('git', ['-C', repoPath, ...args], r).message}`);
      throw new Error(failure());
    };
    // A worktree that already exists is prepared without a fetch: what was merged since applies all the same.
    // A forge that does not answer refuses the launch, which never waits for it forever.
    if (fetch) await fetchOrigin(exec, repoPath, { deadlineMs: o.fetchDeadlineMs, log: (m) => o.log?.(`${REPO_CONFIG_PATH}: ${m}`) });
    const { ref, name, set } = await originHeadOf(exec, repoPath);
    // The hint only when `origin/HEAD` is missing: `origin/main` is then a guess, perhaps not the default branch.
    const unreadable = `unreadable default branch (${name})${set ? '' : `: origin/HEAD is not set on the factory's repository; if ${name} is not the default branch, run \`git remote set-head origin --auto\` on this repository`}`;
    // `ls-tree` tells a file absent from a branch it could not read, which `git show` answers alike.
    const entryOf = (path: string) => git(['ls-tree', '-z', ref, '--', path], () => unreadable);
    // `ls-tree` does not go through a `.factory` that is a link: the file under it would read as absent.
    const dir = await entryOf(REPO_CONFIG_DIR);
    if (!dir) return parseRepoConfig(undefined);
    if (!dir.startsWith('040000 tree ')) throw new RepoConfigError([`${REPO_CONFIG_DIR} is not a folder on ${name} (symbolic link, file or submodule)`]);
    const entry = await entryOf(REPO_CONFIG_PATH);
    if (!entry) return parseRepoConfig(undefined);
    const blob = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(entry)?.[1];
    if (!blob) throw new RepoConfigError([`${REPO_CONFIG_PATH} is not a file on ${name} (symbolic link, folder or submodule)`]);
    return parseRepoConfig(await git(['cat-file', 'blob', blob], () => `${REPO_CONFIG_PATH} unreadable on ${name} (git object missing or damaged)`));
  };
}

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
    if (vars.missing.length) o.log(`${id}: variables declared by the repository, with no value in factory.yml, left out of the runner: ${vars.missing.join(', ')}`);
    return vars;
  };
}
