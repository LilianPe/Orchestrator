import type { NetworkLevel } from '../adapters/sandbox/types.js';
import { repoNetworkCeiling, type RepoConfig } from '../config/repo-config.js';

/** Network levels of the MVP doc, narrowest first: a step can only narrow the repository's level. */
export const NETWORK_RANK: Record<NetworkLevel, number> = { none: 0, 'claude-api': 1, limited: 2, full: 3 };

/** What the egress proxy lets one run through (ORC-213, docs/decisions/ORC-213.md). */
export interface EgressPolicy {
  level: NetworkLevel;
  /** The repository's own hosts (`network.allow` of a `custom` repository), at `limited` only. */
  allow: readonly string[];
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Every method goes there: the agent's own model calls. */
export const CLAUDE_API = ['api.anthropic.com'];

/**
 * Hosts with a write API (push, gist, publish): never tunnelled, so the proxy sees each method and
 * path. The sandbox points git, npm and pip at their `http://` form; the proxy goes on in HTTPS.
 */
export const INSPECTED = ['github.com', 'api.github.com', 'registry.npmjs.org', 'pypi.org'];

/** Read-only downloads and docs: tunnelled, the host alone is checked (TLS hides the method). */
export const TUNNELLED = [
  // Package and repository downloads, behind the inspected hosts above.
  'files.pythonhosted.org',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
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
  return { level, allow: level === 'limited' && config.network.level === 'custom' ? config.network.allow : [] };
}

/** A `CONNECT host:443`: TLS end to end, so only the host is checked. */
export function allowConnect(p: EgressPolicy, host: string): Verdict {
  const h = norm(host);
  if (p.level === 'full') return { ok: true };
  if (CLAUDE_API.includes(h) && p.level !== 'none') return { ok: true };
  if (p.level !== 'limited') return refuse(`${h} not allowed at ${p.level}`);
  if (INSPECTED.includes(h)) return refuse(`${h} is never tunnelled: http://${h} through the proxy, which checks the method`);
  if (TUNNELLED.includes(h) || p.allow.includes(h)) return { ok: true };
  return refuse(`${h} not allowed at ${p.level}`);
}

/** A plain HTTP request through the proxy (sent on in HTTPS): host, method and path are checked. */
export function allowRequest(p: EgressPolicy, host: string, method: string, path: string): Verdict {
  const h = norm(host);
  if (p.level === 'full') return { ok: true };
  if (CLAUDE_API.includes(h) && p.level !== 'none') return { ok: true };
  if (p.level !== 'limited') return refuse(`${h} not allowed at ${p.level}`);
  if (!INSPECTED.includes(h) && !TUNNELLED.includes(h) && !p.allow.includes(h)) return refuse(`${h} not allowed at ${p.level}`);
  const [pathname = '', query = ''] = path.split('?');
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
