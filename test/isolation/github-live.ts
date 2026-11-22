import { GitHubAppForge, repoRef, type GitHubAppForgeOptions } from '../../src/adapters/forge/github-app.js';
import { readPrivateKey } from '../../src/config/github-app.js';

/**
 * Isolation n° 12 and 13 (ORC-219) on the real GitHub: the factory's GitHub App and a test repository it is installed on.
 * Never the production App: variables of their own, which the CI passes from an environment limited to main (docs/tests.md,
 * Isolation tests). Without them, each test skips and its title says which are missing.
 */
export const GITHUB_ENV = ['FACTORY_ISO_GH_APP_ID', 'FACTORY_ISO_GH_APP_KEY', 'FACTORY_ISO_GH_REPO'];

/** The run's repository, `owner/name`. */
export const REPO = process.env['FACTORY_ISO_GH_REPO']?.trim() ?? '';

/** Whether a test needing `names` skips, and its title, which says why when it does. */
export function gate(title: string, names: string[]): { skip: boolean; title: string } {
  const unset = names.filter((n) => !process.env[n]?.trim());
  return { skip: unset.length > 0, title: unset.length ? `${title} (skipped: ${unset.join(', ')} not set)` : title };
}

/** The App's settings from the variables; the forge names a repository by its `owner/name` (ORC-478). */
export function appOptions(): GitHubAppForgeOptions {
  const installationId = process.env['FACTORY_ISO_GH_INSTALLATION_ID']?.trim();
  return {
    appId: process.env['FACTORY_ISO_GH_APP_ID']!.trim(),
    privateKey: readPrivateKey(process.env['FACTORY_ISO_GH_APP_KEY']!),
    ...(installationId ? { installationId } : {}),
  };
}

/** The factory's forge on the test App, and the token it holds for a repository: the run's token. */
export class LiveForge extends GitHubAppForge {
  async token(github: string): Promise<string> {
    return this.installationToken(repoRef(github));
  }
}

/** A call of GitHub's REST API with `token` (none: anonymous): its status and JSON body. */
export async function gh(path: string, token: string | undefined, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'factory-isolation-test',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}
