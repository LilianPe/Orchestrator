import { GitHubAppForge } from '../adapters/forge/github-app.js';
import { NO_GITHUB_APP } from '../adapters/forge/no-forge.js';
import type { FactoryYml } from '../config/factory-yml.js';
import { resolveGithubApp } from '../config/github-app.js';
import { effectiveInstance } from '../config/instance.js';

/**
 * The GitHub App for a command of the CLI (`baseline`, `ghost`), on the daemon's configuration: the only way it reads GitHub
 * (ORC-181, no `gh`). A message for the human without the App, or with an incomplete one.
 */
export function cliGithubForge(home: string, yml: FactoryYml | undefined, command: string): GitHubAppForge | string {
  let githubApp;
  try {
    githubApp = resolveGithubApp(effectiveInstance(home, yml));
  } catch (err) {
    return (err as Error).message;
  }
  return githubApp ? new GitHubAppForge(githubApp) : `factory ${command} reads GitHub by its App alone: ${NO_GITHUB_APP}.`;
}
