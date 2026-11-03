import type { NetworkLevel } from '../adapters/sandbox/types.js';
import { repoNetworkCeiling, type RepoConfig } from '../config/repo-config.js';

/** Network levels of the MVP doc, narrowest first: a step can only narrow the repository's level. */
export const NETWORK_RANK: Record<NetworkLevel, number> = { none: 0, 'claude-api': 1, limited: 2, full: 3 };

/** What the egress proxy lets one run through (ORC-213, docs/decisions/ORC-213.md). */
export interface EgressPolicy {
  level: NetworkLevel;
  /** The repository's own hosts (`network.allow` of a `custom` repository), lowercase, at `limited` only. */
  allow: readonly string[];
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Every method goes there: the agent's own model calls. */
export const CLAUDE_API = ['api.anthropic.com'];

/**
 * Claude Code's OAuth token refresh, the token endpoint alone (POST); reads elsewhere on the host.
 * Unmeasured: ORC-128 saw only api.anthropic.com with a long-lived token, which never refreshes.
 */
export const CLAUDE_AUTH: Readonly<Record<string, string>> = {
  'console.anthropic.com': '/v1/oauth/token',
  'platform.claude.com': '/v1/oauth/token',
};

/** The `limited` hosts. Every request is decrypted by the proxy: read methods only, whatever the host. */
export const LIMITED = [
  // GitHub, read-only: `git fetch` and the API's GETs.
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  // Package registries and their downloads.
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  // Docs of the libs, MDN, npmjs.
  'developer.mozilla.org',
  'nodejs.org',
  'docs.npmjs.com',
  'www.npmjs.com',
  'www.typescriptlang.org',
  'docs.python.org',
  'docs.github.com',
];

const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The run's policy for one step: the step narrows the repository's level, `full` is refused (setup only). */
export function stepPolicy(config: RepoConfig, step: NetworkLevel = 'limited'): EgressPolicy {
  if (step === 'full') throw new Error('network full is reserved for setup, never for the agent');
  const ceiling = repoNetworkCeiling(config);
  const level = NETWORK_RANK[step] < NETWORK_RANK[ceiling] ? step : ceiling;
  return { level, allow: level === 'limited' && config.network.level === 'custom' ? config.network.allow.map(norm) : [] };
}

/** A `CONNECT host:443`: the host alone, before the proxy decrypts the requests (`allowRequest`). */
export function allowConnect(p: EgressPolicy, host: string): Verdict {
  const h = norm(host);
  if (p.level === 'full') return { ok: true };
  if (p.level !== 'none' && (CLAUDE_API.includes(h) || Object.hasOwn(CLAUDE_AUTH, h))) return { ok: true };
  if (p.level === 'limited' && (LIMITED.includes(h) || p.allow.includes(h))) return { ok: true };
  return refuse(`${h} not allowed at ${p.level}`);
}

/** One HTTP request, decrypted or in clear: host, method and path. */
export function allowRequest(p: EgressPolicy, host: string, method: string, path: string): Verdict {
  const h = norm(host);
  if (p.level === 'full') return { ok: true };
  const c = allowConnect(p, h);
  if (!c.ok) return c;
  if (CLAUDE_API.includes(h)) return { ok: true };
  const [pathname = '', query = ''] = path.split('?');
  if (Object.hasOwn(CLAUDE_AUTH, h) && method === 'POST' && pathname === CLAUDE_AUTH[h]) return { ok: true };
  // A push starts with this advertisement, then POSTs to git-receive-pack.
  if (/(^|&)service=git-receive-pack(&|$)/.test(query)) return refuse(`${h}: git push refused (read-only)`);
  if (READ.has(method)) return { ok: true };
  // A git fetch over smart HTTP is a POST, and only reads.
  if (h === 'github.com' && method === 'POST' && pathname.endsWith('/git-upload-pack')) return { ok: true };
  return refuse(`${method} ${h}${pathname} refused: GET, HEAD and OPTIONS only`);
}

function norm(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

function refuse(reason: string): Verdict {
  return { ok: false, reason };
}
