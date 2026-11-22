import { execCmd, type Exec } from '../adapters/exec.js';
import { parseGitHubRemote } from '../adapters/forge/github-app.js';
import type { CloneAuth, GitAuth } from '../adapters/forge/types.js';

/** What a clone's `origin` names on GitHub (`repo` undefined: elsewhere) and whether git fetches it over HTTPS, or why git could not read it. */
async function readOrigin(exec: Exec, repoPath: string): Promise<{ failure: string } | { repo: string | undefined; https: boolean }> {
  const r = await exec('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
  if (r.code !== 0) return { failure: r.stderr.trim().split('\n')[0] || `git exited with ${r.code}` };
  const ref = parseGitHubRemote(r.stdout);
  return { repo: ref && `${ref.owner}/${ref.name}`, https: /^https:\/\/([^@/]+@)?github\.com\//i.test(r.stdout.trim()) };
}

/**
 * The GitHub repository (`owner/name`) of a project (ORC-478), resolved once at the start: the forge, its writer, the captures, the App's
 * git token, the roles, the GitHub webhooks, `verify` and the daemon's mirror (ORC-479) know the repository by it, never by the clone's remote again.
 * The entry of `factory.yml`'s `repos` of the project's Linear team that the clone's `origin` names gives its spelling, else the
 * origin's own name. An origin that is not on GitHub, or that git cannot read, rejects: the factory reads and writes only there.
 * ponytail: ORC-471 part 3 gives each repository its `github` in `factory.yml`, and no clone is read for it any more.
 */
export async function projectGithub(o: { repoPath: string; teamKey?: string; repos?: readonly RepoEntry[]; exec?: Exec }): Promise<{ github: string }> {
  const origin = await readOrigin(o.exec ?? execCmd, o.repoPath);
  if ('failure' in origin) throw new Error(`the origin remote of ${o.repoPath} cannot be read: ${origin.failure}`);
  // Its URL is never said: it may carry a credential.
  if (!origin.repo) throw new Error(`the origin remote of ${o.repoPath} is not a GitHub repository: set it to https://github.com/<owner>/<name> (or git@github.com:<owner>/<name>.git)`);
  return { github: repoEntry(o.repos, o.teamKey, origin.repo)?.github ?? origin.repo };
}

type RepoEntry = { linearTeam: string; github: string };

/** The entry of `factory.yml`'s `repos` of the Linear team `teamKey` for the GitHub repository `github`, whatever its case. */
export function repoEntry<T extends RepoEntry>(repos: readonly T[] | undefined, teamKey: string | undefined, github: string): T | undefined {
  const named = github.toLowerCase();
  return repos?.find((r) => r.linearTeam === teamKey && r.github.toLowerCase() === named);
}

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
