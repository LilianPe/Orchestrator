import { createHash } from 'node:crypto';
import { execCmd, execFailure, mustExec, type Exec } from '../adapters/exec.js';
import { githubRepoOf } from '../adapters/forge/github-ingest.js';
import { fetchOrigin, originHeadOf } from '../adapters/workspace/git-workspaces.js';
import type { FactoryYml } from '../config/factory-yml.js';
import { parseRepoConfig, REPO_CONFIG_DIR, REPO_CONFIG_PATH, RepoConfigError, type RepoConfig, type RepoConfigRead } from '../config/repo-config.js';
import { NO_REPO_VARIABLES, repoVariables, type RepoVariables } from '../config/repo-variables.js';
import { zFields } from '../core/clean-verify.js';
import { START_FILES } from '../knowledge/preview-recipe.js';
import { canonical } from '../runtime/workflow-version.js';

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
    // The branch names the factory makes must not collide with it (ORC-283): `origin/main` is the branch `main`.
    const defaultBranch = name.replace(/^origin\//, '');
    const dir = await entryOf(REPO_CONFIG_DIR);
    if (!dir) return parseRepoConfig(undefined, { defaultBranch });
    if (!dir.startsWith('040000 tree ')) throw new RepoConfigError([`${REPO_CONFIG_DIR} is not a folder on ${name} (symbolic link, file or submodule)`]);
    const entry = await entryOf(REPO_CONFIG_PATH);
    if (!entry) return parseRepoConfig(undefined, { defaultBranch });
    const blob = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(entry)?.[1];
    if (!blob) throw new RepoConfigError([`${REPO_CONFIG_PATH} is not a file on ${name} (symbolic link, folder or submodule)`]);
    const config = parseRepoConfig(await git(['cat-file', 'blob', blob], () => `${REPO_CONFIG_PATH} unreadable on ${name} (git object missing or damaged)`), { defaultBranch });
    for (const w of config.sensitivePathWarnings ?? []) o.log?.(`${REPO_CONFIG_PATH} on ${name}: ignored ${w}; a branch that took untrusted content is refused until it is fixed`);
    return config;
  };
}

/**
 * The fingerprint of the files that decide how a project's application starts (ORC-406, `START_FILES`), on its default branch as
 * `makeRepoConfig` reads it, with no fetch of its own: each file by its blob, package.json and pyproject.toml by what in them says
 * how it starts (`START_PART`). Undefined, logged, where git cannot read the branch.
 */
export function makeStartFingerprint(o: { exec?: Exec; log?: (message: string) => void } = {}): (project: { repoPath: string }) => Promise<string | undefined> {
  const exec = o.exec ?? execCmd;
  return async ({ repoPath }) => {
    const { ref } = await originHeadOf(exec, repoPath);
    const tree = await exec('git', ['-C', repoPath, '--literal-pathspecs', 'ls-tree', '-z', ref, '--', ...START_FILES]);
    if (tree.code !== 0) {
      o.log?.(`start fingerprint: ${execFailure('git', ['-C', repoPath, 'ls-tree', ref], tree).message}`);
      return undefined;
    }
    const parts: string[] = [];
    for (const entry of zFields(tree.stdout)) {
      const m = /^\d+ \w+ ([0-9a-f]+)\t(.+)$/.exec(entry);
      if (!m) continue;
      const blob = m[1]!;
      const path = m[2]!;
      const part = START_PART[path];
      parts.push(`${path}\0${part ? part((await exec('git', ['-C', repoPath, 'cat-file', 'blob', blob])).stdout) : blob}`);
    }
    return createHash('sha256').update(parts.sort().join('\n')).digest('hex');
  };
}

/** The scripts of a package.json, in a stable form; the whole text where it does not parse, which a fix changes all the same. */
function packageScripts(text: string): string {
  try {
    return canonical((JSON.parse(text) as { scripts?: unknown }).scripts ?? {});
  } catch {
    return text;
  }
}

/** The tables of a pyproject.toml that say how it starts: PEP 621's scripts and entry points, Poetry's scripts and plugins. */
const PYPROJECT_START = /^(project\.(scripts|gui-scripts|entry-points(\..+)?)|tool\.poetry\.(scripts|plugins(\..+)?))$/;
/** A key that would set one of them from elsewhere: an inline or dotted table. */
const PYPROJECT_START_KEY = /^(project\.|tool\.poetry\.)?(scripts|gui-scripts|entry-points|plugins)(\.|\s*=)/;

/**
 * The lines of `PYPROJECT_START`'s tables, each under its table, comments and blank lines out (ORC-406): the version and the
 * dependencies change nothing of it. With no TOML parser, the whole text where it cannot tell them apart surely: a multi-line
 * string, or a key that sets them from another table.
 */
export function pyprojectStart(text: string): string {
  if (text.includes('"'.repeat(3)) || text.includes("'".repeat(3))) return text;
  const kept: string[] = [];
  let table = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      table = header[1]!.replace(/\s*\.\s*/g, '.');
      continue;
    }
    if (PYPROJECT_START.test(table)) kept.push(`[${table}] ${line}`);
    else if (PYPROJECT_START_KEY.test(line)) return text;
  }
  return kept.join('\n');
}

/** What of a start file counts in the fingerprint, where not its whole blob. */
const START_PART: Partial<Record<string, (text: string) => string>> = { 'package.json': packageScripts, 'pyproject.toml': pyprojectStart };

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
