import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execCmd, execFailure, type Exec } from '../adapters/exec.js';
import { fetchOrigin, originHeadOf, type FetchOrigin } from '../adapters/workspace/git-workspaces.js';
import type { FactoryYml } from '../config/factory-yml.js';
import { IGNORED_WORKFLOW_FILES, parseRepoConfig, REPO_CONFIG_DIR, REPO_CONFIG_PATH, RepoConfigError, type RepoConfig, type RepoConfigRead } from '../config/repo-config.js';
import { NO_REPO_VARIABLES, repoVariables, type RepoVariables } from '../config/repo-variables.js';
import { zFields } from '../core/clean-verify.js';
import { fingerprintFiles, type FingerprintFiles } from '../core/dry-run.js';
import { START_FILES } from '../knowledge/preview-recipe.js';
import { canonical } from '../runtime/workflow-version.js';
import { repoEntry } from './project-github.js';
import { isTable, parseToml, type TomlTable, type TomlValue } from '../checks/toml.js';

/**
 * `.factory/config.yml` of a project's repository, read once at each launch (ORC-209 C): on its default branch as
 * the factory's mirror has it (`originHead`, ORC-479), never in a worktree the agent writes nor on its branch. The agent
 * has neither `origin` nor `origin/HEAD` of this repository to write: its git dir is its own (ORC-317). No file: the
 * socle. An invalid file, or a default branch git cannot read, rejects: no run starts on a config half read. `fetch`: what
 * fetches the mirror (`RepoMirrors.fetch`); a plain `fetchOrigin` for `factory doctor` and `factory init`, which read the checkout
 * they run in, with `fetch: false`.
 */
export function makeRepoConfig(o: { exec?: Exec; fetchDeadlineMs?: number; log?: (message: string) => void; fetch?: FetchOrigin } = {}): (project: { mirror: string }, read?: RepoConfigRead) => Promise<RepoConfig> {
  const exec = o.exec ?? execCmd;
  const fetchMirror: FetchOrigin = o.fetch ?? ((repo, f) => fetchOrigin(exec, repo, f));
  return async ({ mirror: repoPath }, { fetch = true } = {}) => {
    // A failure's message reaches the ticket (Linear): never the server's path nor the command, which go to the daemon's log.
    const git = async (args: string[], failure: () => string): Promise<string> => {
      const r = await exec('git', ['-C', repoPath, ...args]);
      if (r.code === 0) return r.stdout;
      o.log?.(`${REPO_CONFIG_PATH}: ${execFailure('git', ['-C', repoPath, ...args], r).message}`);
      throw new Error(failure());
    };
    // A worktree that already exists is prepared without a fetch: what was merged since applies all the same.
    // A forge that does not answer refuses the launch, which never waits for it forever.
    if (fetch) await fetchMirror(repoPath, { deadlineMs: o.fetchDeadlineMs, log: (m) => o.log?.(`${REPO_CONFIG_PATH}: ${m}`) });
    const { ref, name, set } = await originHeadOf(exec, repoPath);
    // The hint only when `origin/HEAD` is missing: `origin/main` is then a guess, perhaps not the default branch.
    const unreadable = `unreadable default branch (${name})${set ? '' : `: origin/HEAD is not set; the factory's mirror sets it at a fetch once the repository has a default branch, a clone by \`git remote set-head origin --auto\``}`;
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
export function makeStartFingerprint(o: { exec?: Exec; log?: (message: string) => void } = {}): (project: { mirror: string }) => Promise<string | undefined> {
  const exec = o.exec ?? execCmd;
  return async ({ mirror: repoPath }) => {
    const { ref } = await originHeadOf(exec, repoPath);
    const tree = await exec('git', ['-C', repoPath, '--literal-pathspecs', 'ls-tree', '-z', ref, '--', ...START_FILES]);
    if (tree.code !== 0) {
      o.log?.(`start fingerprint: ${execFailure('git', ['-C', repoPath, 'ls-tree', ref], tree).message}`);
      return undefined;
    }
    const entries = zFields(tree.stdout).flatMap((entry) => {
      const m = /^\d+ \w+ ([0-9a-f]+)\t(.+)$/.exec(entry);
      return m ? [{ blob: m[1]!, path: m[2]! }] : [];
    });
    // A file whose part counts read in parallel; one git could not read leaves the fingerprint unread, never another one.
    const parts = await Promise.all(
      entries.map(async ({ blob, path }) => {
        const part = START_PART[path];
        if (!part) return `${path}\0${blob}`;
        const args = ['-C', repoPath, 'cat-file', 'blob', blob];
        const r = await exec('git', args);
        if (r.code !== 0) {
          o.log?.(`start fingerprint: ${execFailure('git', args, r).message}`);
          return undefined;
        }
        return `${path}\0${part(r.stdout)}`;
      }),
    );
    if (parts.includes(undefined)) return undefined;
    return createHash('sha256').update(parts.sort().join('\n')).digest('hex');
  };
}

/**
 * The default branch's head and the files of the dry run's fingerprint there (ORC-409), as `makeRepoConfig` reads the branch, with
 * no fetch of its own: a delegated ticket's launch fetched it just before. A branch git cannot read rejects, as the config's read.
 */
export function makeDryRunFiles(o: { exec?: Exec; log?: (message: string) => void } = {}): (project: { mirror: string }) => Promise<FingerprintFiles & { sha: string }> {
  const exec = o.exec ?? execCmd;
  return async ({ mirror: repoPath }) => {
    const { ref, name } = await originHeadOf(exec, repoPath);
    // A failure's message reaches the ticket (Linear): never the server's path nor the command, which go to the daemon's log.
    const git = async (...args: string[]): Promise<string> => {
      const r = await exec('git', ['-C', repoPath, ...args]);
      if (r.code === 0) return r.stdout;
      o.log?.(`dry run fingerprint: ${execFailure('git', ['-C', repoPath, ...args], r).message}`);
      throw new Error(`the dry run's fingerprint: unreadable default branch (${name})`);
    };
    const [sha, files] = await Promise.all([git('rev-parse', '--verify', `${ref}^{commit}`), fingerprintFiles((...args) => git('ls-tree', ...args), ref)]);
    return { sha: sha.trim(), ...files };
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

/**
 * The tables of a pyproject.toml that say how it starts: PEP 621's scripts and entry points, Poetry's scripts and plugins, and the
 * task runners' (PDM, Rye, poethepoet, taskipy; Hatch's, in each of its environments).
 */
const PYPROJECT_START = ['project.scripts', 'project.gui-scripts', 'project.entry-points', 'tool.poetry.scripts', 'tool.poetry.plugins', 'tool.pdm.scripts', 'tool.rye.scripts', 'tool.poe.tasks', 'tool.taskipy.tasks'];

const at = (t: TomlValue | undefined, dotted: string): TomlValue | undefined => dotted.split('.').reduce<TomlValue | undefined>((v, k) => (isTable(v) ? v[k] : undefined), t);

/**
 * What of a pyproject.toml says how it starts (ORC-406): `PYPROJECT_START`'s tables, in canonical JSON, so that neither the
 * version, the dependencies nor the order of the scripts count; the whole text where it does not parse.
 */
export function pyprojectStart(text: string): string {
  let toml: TomlTable;
  try {
    toml = parseToml(text);
  } catch {
    return text;
  }
  const picked: Record<string, TomlValue> = {};
  for (const path of PYPROJECT_START) {
    const v = at(toml, path);
    if (v !== undefined) picked[path] = v;
  }
  const envs = at(toml, 'tool.hatch.envs');
  for (const [name, env] of isTable(envs) ? Object.entries(envs) : []) {
    const scripts = at(env, 'scripts');
    if (scripts !== undefined) picked[`tool.hatch.envs.${name}.scripts`] = scripts;
  }
  return Object.keys(picked).length ? canonical(picked) : '';
}

/** What of a start file counts in the fingerprint, where not its whole blob. */
const START_PART: Partial<Record<string, (text: string) => string>> = { 'package.json': packageScripts, 'pyproject.toml': pyprojectStart };

/**
 * Where `verify`, the dry run and the start recipe read a project's forge (ORC-151): the URL of its repository on GitHub as the start
 * resolved it (`projectGithub`, ORC-478), never what a clone's config or an agent says. A replayed ticket's (ORC-376) is its clone at
 * the start, which stands for the repository: never the forge's default branch, which holds the human's PR and all that came after.
 */
export function makeOriginUrl(): (project: { github: string; mirror: string; replayed?: unknown }) => Promise<string> {
  return async ({ github, mirror, replayed }) => (replayed ? pathToFileURL(mirror).href : `https://github.com/${github}`);
}

/**
 * The workflow files an older factory read (ORC-388) on the default branch of a project's mirror (ORC-479), as `makeRepoConfig`
 * reads it: said at the daemon's start. None where git cannot read the branch (a mirror not made yet), which the launch says.
 */
export async function ignoredWorkflowFilesOn(mirror: string, exec: Exec = execCmd): Promise<string[]> {
  const { ref } = await originHeadOf(exec, mirror);
  const r = await exec('git', ['-C', mirror, '--literal-pathspecs', 'ls-tree', '-z', '--name-only', ref, '--', ...IGNORED_WORKFLOW_FILES]);
  return r.code === 0 ? zFields(r.stdout) : [];
}

/**
 * The variables of a project's repository at each launch (ORC-211): its entry in `factory.yml`, found by its team and
 * its repository on GitHub (`github`, ORC-478), and the names `config` declares, as the launch (`makeRepoConfig`) or `verify`
 * (ORC-151) read it.
 */
export function makeRepoVariables(o: { yml: FactoryYml | undefined; log: (message: string) => void }): (project: { id: string; github: string; teamKey: string }, config: RepoConfig) => Promise<RepoVariables> {
  return async ({ id, github, teamKey }, config) => {
    const server = repoEntry(o.yml?.repos, teamKey, github);
    if (!server) return NO_REPO_VARIABLES;
    const vars = repoVariables(config, server);
    if (vars.missing.length) o.log(`${id}: variables declared by the repository, with no value in factory.yml, left out of the runner: ${vars.missing.join(', ')}`);
    return vars;
  };
}
