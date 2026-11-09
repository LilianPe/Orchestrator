import { GitHubAppForge, type GitHubAppForgeOptions, type GitHubRepoRef } from '../../src/adapters/forge/github-app.js';
import type { GitAccess } from '../../src/adapters/forge/types.js';
import { readPrivateKey } from '../../src/config/github-app.js';

/**
 * Isolation n° 12 and 13 (ORC-219) on the real GitHub: the factory's GitHub App and a test repository it is installed on.
 * Never the production App: variables of their own, which the CI passes from its secrets when they exist (docs/tests.md,
 * Isolation tests). Without them, each test skips and its title says which are missing.
 */
export const GITHUB_ENV = ['FACTORY_ISO_GH_APP_ID', 'FACTORY_ISO_GH_APP_KEY', 'FACTORY_ISO_GH_REPO'] as const;

/** The variables among `names` that are not set: a skipped test's title names them. */
export function missing(...names: string[]): string[] {
  return names.filter((n) => !process.env[n]?.trim());
}

/** The title of a test that runs only with `names` set: with why it skips when one is not. */
export const titled = (title: string, names: string[]) => (missing(...names).length ? `${title} (skipped: ${missing(...names).join(', ')} not set)` : title);

/** `owner/name`, as the variables give a repository. */
export function repoRef(value: string): GitHubRepoRef {
  const [owner = '', name = ''] = value.split('/');
  if (!owner || !name) throw new Error(`a repository as owner/name expected, got "${value}"`);
  return { owner, name };
}

/** The App's settings from the variables; a repository path is its `owner/name`. */
export function appOptions(): GitHubAppForgeOptions {
  const installationId = process.env['FACTORY_ISO_GH_INSTALLATION_ID']?.trim();
  return {
    appId: process.env['FACTORY_ISO_GH_APP_ID']!.trim(),
    privateKey: readPrivateKey(process.env['FACTORY_ISO_GH_APP_KEY']!),
    ...(installationId ? { installationId } : {}),
    resolveRepo: async (path) => repoRef(path),
  };
}

export const appForge = () => new GitHubAppForge(appOptions());

/** The installation token inside a `gitAccess`: the run's token, as the factory holds it. */
export function tokenOf(access: GitAccess): string {
  const basic = /Basic (\S+)/.exec(access.env['GIT_CONFIG_VALUE_0'] ?? '')?.[1] ?? '';
  return Buffer.from(basic, 'base64').toString().replace(/^x-access-token:/, '');
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
