import { execCmd, type Exec } from '../adapters/exec.js';
import { parseGitHubRemote } from '../adapters/forge/github-app.js';

/**
 * The GitHub repository (`owner/name`) of the checkout `factory init` and `factory doctor` run in, by its `origin` (ORC-480): what
 * `init` writes as its entry's `github`, and how `doctor` finds that entry. The daemon reads no clone for it: each entry of
 * `factory.yml`'s `repos` names its own. An origin that is not on GitHub, or that git cannot read, rejects.
 */
export async function originGithub(dir: string, exec: Exec = execCmd): Promise<string> {
  const r = await exec('git', ['-C', dir, 'remote', 'get-url', 'origin']);
  if (r.code !== 0) throw new Error(`the origin remote of ${dir} cannot be read: ${r.stderr.trim().split('\n')[0] || `git exited with ${r.code}`}`);
  const ref = parseGitHubRemote(r.stdout);
  // Its URL is never said: it may carry a credential.
  if (!ref) throw new Error(`the origin remote of ${dir} is not a GitHub repository: set it to https://github.com/<owner>/<name> (or git@github.com:<owner>/<name>.git)`);
  return `${ref.owner}/${ref.name}`;
}

/** Whether two names of GitHub repositories are one, whatever their case, as GitHub reads them. */
export const sameGithub = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
