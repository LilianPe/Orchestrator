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
 * The GitHub repository (`owner/name`) of a project (ORC-478), resolved once at the start: the forge, its writer, the captures,
 * the App's git token, the roles, the GitHub webhooks and `verify` know the repository by it, never by the clone's remote again.
 * The entry of `factory.yml`'s `repos` of the project's Linear team that the clone's `origin` names gives its spelling, else the
 * origin's own name. An origin that is not on GitHub, or that git cannot read, rejects: the factory reads and writes only there.
 * ponytail: ORC-471 part 3 gives each repository its `github` in `factory.yml`, and no clone is read for it any more.
 */
export async function projectGithub(o: { repoPath: string; teamKey?: string; repos?: readonly { linearTeam: string; github: string }[]; exec?: Exec }): Promise<string> {
  const origin = await readOrigin(o.exec ?? execCmd, o.repoPath);
  if ('failure' in origin) throw new Error(`the origin remote of ${o.repoPath} cannot be read: ${origin.failure}`);
  // Its URL is never said: it may carry a credential.
  if (!origin.repo) throw new Error(`the origin remote of ${o.repoPath} is not a GitHub repository: set it to https://github.com/<owner>/<name> (or git@github.com:<owner>/<name>.git)`);
  const named = origin.repo.toLowerCase();
  return o.repos?.find((r) => r.linearTeam === o.teamKey && r.github.toLowerCase() === named)?.github ?? origin.repo;
}

/**
 * The GitHub repository a clone fetches over HTTPS, the only fetch the App's token serves (ORC-442); undefined for an origin over
 * ssh, elsewhere or unreadable, whose git uses the machine's own credentials and never waits for GitHub's API: the projects'
 * clones, the knowledge base's, the ghost's.
 */
export async function httpsGithub(repoPath: string, exec: Exec = execCmd): Promise<string | undefined> {
  const origin = await readOrigin(exec, repoPath);
  return 'repo' in origin && origin.https ? origin.repo : undefined;
}

/**
 * The `CloneAuth` of the factory's clones (ORC-478): the App's token of the GitHub repository a clone at `repoPath` stands for, as
 * `clones` names it (`httpsGithub`); `{}` for any other path (a clone over ssh, a replayed ticket's clone, whose origin is local),
 * whose git uses the machine's own credentials. Without `auth` (no App), none.
 */
export function cloneAuth(auth: GitAuth | undefined, clones: ReadonlyMap<string, string>): CloneAuth | undefined {
  if (!auth) return undefined;
  return async (repoPath) => {
    const github = clones.get(repoPath);
    return github ? auth(github) : {};
  };
}
