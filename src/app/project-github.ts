import { execCmd, type Exec } from '../adapters/exec.js';
import { parseGitHubRemote } from '../adapters/forge/github-app.js';
import type { CloneAuth, GitAuth } from '../adapters/forge/types.js';

/** What a clone's `origin` names on GitHub (`repo` undefined: elsewhere) and whether git fetches it over HTTPS, or why git could not read it. */
async function readOrigin(exec: Exec, dir: string): Promise<{ failure: string } | { repo: string | undefined; https: boolean }> {
  const r = await exec('git', ['-C', dir, 'remote', 'get-url', 'origin']);
  if (r.code !== 0) return { failure: r.stderr.trim().split('\n')[0] || `git exited with ${r.code}` };
  const ref = parseGitHubRemote(r.stdout);
  return { repo: ref && `${ref.owner}/${ref.name}`, https: /^https:\/\/([^@/]+@)?github\.com\//i.test(r.stdout.trim()) };
}

/**
 * The GitHub repository (`owner/name`) of the checkout `factory init` and `factory doctor` run in, by its `origin` (ORC-480): what
 * `init` writes as its entry's `github`, and how `doctor` finds that entry. The daemon reads no clone for it: each entry of
 * `factory.yml`'s `repos` names its own. An origin that is not on GitHub, or that git cannot read, rejects.
 */
export async function originGithub(dir: string, exec: Exec = execCmd): Promise<string> {
  const origin = await readOrigin(exec, dir);
  if ('failure' in origin) throw new Error(`the origin remote of ${dir} cannot be read: ${origin.failure}`);
  // Its URL is never said: it may carry a credential.
  if (!origin.repo) throw new Error(`the origin remote of ${dir} is not a GitHub repository: set it to https://github.com/<owner>/<name> (or git@github.com:<owner>/<name>.git)`);
  return origin.repo;
}

/** Whether two names of GitHub repositories are one, whatever their case, as GitHub reads them. */
export const sameGithub = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The GitHub repository a clone fetches over HTTPS, the only fetch the App's token serves (ORC-442); undefined for an origin over
 * ssh, elsewhere or unreadable, whose git uses the machine's own credentials and never waits for GitHub's API: the knowledge
 * base's clone, until ORC-471 part 4 gives it a mirror of its own.
 */
export async function httpsGithub(repoPath: string, exec: Exec = execCmd): Promise<string | undefined> {
  const origin = await readOrigin(exec, repoPath);
  return 'repo' in origin && origin.https ? origin.repo : undefined;
}

/**
 * The `CloneAuth` of the knowledge base's clone (ORC-478): the App's token of the GitHub repository a clone at `repoPath` stands for, as
 * `clones` names it (`httpsGithub`); `{}` for any other path (a clone over ssh), whose git uses the machine's own credentials. Without
 * `auth` (no App), none. The projects' mirrors have their own (`RepoMirrors.auth`, ORC-479).
 */
export function cloneAuth(auth: GitAuth | undefined, clones: ReadonlyMap<string, string>): CloneAuth | undefined {
  if (!auth) return undefined;
  return async (repoPath) => {
    const github = clones.get(repoPath);
    return github ? auth(github) : {};
  };
}
