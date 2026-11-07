import { execCmd, execFailure, mustExec, TIMED_OUT, type Exec, type ExecOpts } from '../adapters/exec.js';
import { githubRepoOf } from '../adapters/forge/github-ingest.js';
import { originHeadOf } from '../adapters/workspace/git-workspaces.js';
import type { FactoryYml } from '../config/factory-yml.js';
import { parseRepoConfig, REPO_CONFIG_DIR, REPO_CONFIG_PATH, RepoConfigError, type RepoConfig, type RepoConfigRead } from '../config/repo-config.js';
import { NO_REPO_VARIABLES, repoVariables, type RepoVariables } from '../config/repo-variables.js';
import { STALLED } from '../publish/publish.js';

/** A launch waits this long for the forge, at most: past it, it is refused (ORC-209 C). */
const FETCH_DEADLINE_MS = 2 * 60_000;

/**
 * `.factory/config.yml` of a project's repository, read once at each launch (ORC-209 C): on its default branch as
 * the factory's repository has it (`originHead`), never in a worktree the agent writes nor on its branch. The agent
 * has neither `origin` nor `origin/HEAD` of this repository to write: its git dir is its own (ORC-317). No file: the
 * socle. An invalid file, or a default branch git cannot read, rejects: no run starts on a config half read.
 */
export function makeRepoConfig(o: { exec?: Exec; fetchDeadlineMs?: number; log?: (message: string) => void } = {}): (project: { repoPath: string }, read?: RepoConfigRead) => Promise<RepoConfig> {
  const exec = o.exec ?? execCmd;
  const deadlineMs = o.fetchDeadlineMs ?? FETCH_DEADLINE_MS;
  return async ({ repoPath }, { fetch = true } = {}) => {
    // A failure's message reaches the ticket (Linear): never the server's path nor the command, which go to the daemon's log.
    const git = async (args: string[], failure: (code: number) => string, opts?: ExecOpts): Promise<string> => {
      const r = await exec('git', ['-C', repoPath, ...args], opts);
      if (r.code === 0) return r.stdout;
      o.log?.(`${REPO_CONFIG_PATH} : ${execFailure('git', ['-C', repoPath, ...args], r).message}`);
      throw new Error(failure(r.code));
    };
    // A worktree that already exists is prepared without a fetch: what was merged since applies all the same.
    // Never a prompt for a credential; a forge that does not answer refuses the launch, which never waits for it forever.
    // Past the deadline, git and its ssh are killed: nothing is left holding the repository's locks.
    if (fetch) {
      const failure = (code: number) => (code === TIMED_OUT ? `la forge ne répond plus après ${deadlineMs / 1000} s` : `la forge n'a pas pu être lue (git fetch, code ${code})`);
      await git(['fetch', '--quiet', 'origin'], failure, { env: { GIT_TERMINAL_PROMPT: '0', ...STALLED }, timeoutMs: deadlineMs });
    }
    const head = await originHeadOf(exec, repoPath);
    const name = head.name.replace(/^remotes\//, '');
    // In full: a short `origin/main` (the fallback without `origin/HEAD`) is resolved by git as `refs/tags/origin/main`
    // first, a tag anyone who pushes to the forge can make.
    const ref = `refs/remotes/${name}`;
    // The hint only when `origin/HEAD` is missing: `origin/main` is then a guess, perhaps not the default branch.
    const unreadable = `branche par défaut illisible (${name})${head.set ? '' : ` : origin/HEAD n'est pas défini sur le dépôt de l'usine ; si ${name} n'est pas la branche par défaut, lancez \`git remote set-head origin --auto\` sur ce dépôt`}`;
    // `ls-tree` tells a file absent from a branch it could not read, which `git show` answers alike.
    const entryOf = (path: string) => git(['ls-tree', '-z', ref, '--', path], () => unreadable);
    // `ls-tree` does not go through a `.factory` that is a link: the file under it would read as absent.
    const dir = await entryOf(REPO_CONFIG_DIR);
    if (!dir) return parseRepoConfig(undefined);
    if (!dir.startsWith('040000 tree ')) throw new RepoConfigError([`${REPO_CONFIG_DIR} n'est pas un dossier sur ${name} (lien symbolique, fichier ou sous-module)`]);
    const entry = await entryOf(REPO_CONFIG_PATH);
    if (!entry) return parseRepoConfig(undefined);
    const blob = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(entry)?.[1];
    if (!blob) throw new RepoConfigError([`${REPO_CONFIG_PATH} n'est pas un fichier sur ${name} (lien symbolique, dossier ou sous-module)`]);
    return parseRepoConfig(await git(['cat-file', 'blob', blob], () => `${REPO_CONFIG_PATH} illisible sur ${name} (objet git manquant ou abîmé)`));
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
    if (vars.missing.length) o.log(`${id} : variables déclarées par le dépôt, sans valeur dans factory.yml, absentes du runner : ${vars.missing.join(', ')}`);
    return vars;
  };
}
