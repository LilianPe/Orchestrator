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

/** The agent's own model calls. The proxy sets the factory's token on them: the sandbox has none (ORC-337). */
export const CLAUDE_API = ['api.anthropic.com'];

/**
 * What Claude Code calls there, method and path, the query aside (ORC-337, measured on 2.1.316 with the
 * factory's run env): the model, its token count, and the two reads of the account's managed settings.
 * Everything else is refused, `/v1/files` first: with the factory's token on it, it would be a write channel.
 * Telemetry (`/api/event_logging/*`, `/api/eval/*`), the CLI bootstrap and the MCP registry, which the run env
 * turns off already, are refused too: Claude Code runs on without them (measured).
 */
export const CLAUDE_API_CALLS: ReadonlySet<string> = new Set([
  'POST /v1/messages',
  'POST /v1/messages/count_tokens',
  'GET /api/claude_code/settings',
  'GET /api/claude_code/policy_limits',
]);

/**
 * The `anthropic-beta` values Claude Code sends (measured on 2.1.316, haiku, sonnet and opus, with the factory's
 * options): the proxy drops any other (ORC-337). A beta can turn on what makes Anthropic's servers call out
 * (`mcp-client-*`, `code-execution-*`, `web-fetch-*`, `files-api-*`) on the factory's account.
 */
export const CLAUDE_BETAS: ReadonlySet<string> = new Set([
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'per-turn-control-2026-07-01',
  'mid-conversation-tool-changes-2026-07-01',
  'thinking-token-count-2026-05-13',
  'advanced-tool-use-2025-11-20',
  'mid-conversation-system-clear-at-2026-08-21',
  'effort-2025-11-24',
  'thinking-binding-controls-2026-08-01',
  'thinking-display-updates-2026-08-18',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
]);

/** The Messages API's own cap on a request: a body the proxy reads whole before it lets it through (ORC-337). */
export const CLAUDE_BODY_MAX = 32 * 1024 * 1024;

/**
 * Tools run by the client, Claude Code: its own (no `type`, or `custom`), and the Anthropic-defined ones the
 * client executes. Any other type is a server tool (web search, web fetch, code execution, MCP toolset, tool
 * search…), run by Anthropic's servers on the factory's account: a way out for a hijacked agent.
 */
const CLIENT_TOOL = /^(custom|(bash|text_editor|computer|memory)_\d{8})$/;

/**
 * A model call's body (`/v1/messages`, `/v1/messages/count_tokens`), read by the proxy (ORC-337): JSON, no MCP
 * server, no container, client tools only. Claude Code sends none of these (measured).
 */
export function claudeBodyVerdict(body: Buffer): Verdict {
  let call: unknown;
  try {
    call = JSON.parse(body.toString('utf8'));
  } catch {
    return refuse('Claude API body refused: not JSON');
  }
  if (typeof call !== 'object' || call === null || Array.isArray(call)) return refuse('Claude API body refused: not a JSON object');
  const c = call as Record<string, unknown>;
  for (const k of ['mcp_servers', 'container']) if (Object.hasOwn(c, k)) return refuse(`Claude API body refused: ${k}`);
  if (c['tools'] === undefined) return { ok: true };
  if (!Array.isArray(c['tools'])) return refuse('Claude API body refused: tools is not a list');
  for (const t of c['tools'] as unknown[]) {
    const type = typeof t === 'object' && t !== null ? (t as Record<string, unknown>)['type'] : 'not an object';
    if (type !== undefined && !(typeof type === 'string' && CLIENT_TOOL.test(type))) return refuse(`Claude API body refused: server tool ${String(type)}`);
  }
  return { ok: true };
}

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

/**
 * An agent run's policy (ORC-209 C): the repository's level, the Claude API kept for a repository at `none`, as
 * the MVP doc says of a step that calls the agent: without it, no run can start.
 * ponytail: every agent run at the repository's level; the step's own level (`stepPolicy(config, step)`, the
 * preset's `review` at `claude-api`) applies once the review needs no network (ORC-322).
 */
export function agentPolicy(config: RepoConfig): EgressPolicy {
  const p = stepPolicy(config);
  return p.level === 'none' ? { level: 'claude-api', allow: [] } : p;
}

/** A `CONNECT host:443`: the host alone, before the proxy decrypts the requests (`allowRequest`). */
export function allowConnect(p: EgressPolicy, host: string): Verdict {
  const h = norm(host);
  if (p.level === 'full') return { ok: true };
  if (p.level !== 'none' && CLAUDE_API.includes(h)) return { ok: true };
  if (p.level === 'limited' && (LIMITED.includes(h) || p.allow.includes(h))) return { ok: true };
  return refuse(`${h} not allowed at ${p.level}`);
}

/** One HTTP request, decrypted or in clear: host, method and path. */
export function allowRequest(p: EgressPolicy, host: string, method: string, path: string): Verdict {
  const h = norm(host);
  if (p.level === 'full') return { ok: true };
  const c = allowConnect(p, h);
  if (!c.ok) return c;
  const [pathname = '', query = ''] = path.split('?');
  if (CLAUDE_API.includes(h)) return CLAUDE_API_CALLS.has(`${method} ${pathname}`) ? { ok: true } : refuse(`${method} ${h}${pathname} refused: not a call of Claude Code`);
  // A push starts with this advertisement, then POSTs to git-receive-pack.
  // Read as a forge reads it, whatever its spelling. A push's real step is the POST, which no rule below lets through.
  if (new URLSearchParams(query.toLowerCase()).getAll('service').includes('git-receive-pack')) return refuse(`${h}: git push refused (read-only)`);
  if (READ.has(method)) return { ok: true };
  // A git fetch over smart HTTP is a POST, and only reads.
  if (h === 'github.com' && method === 'POST' && pathname.endsWith('/git-upload-pack')) return { ok: true };
  return refuse(`${method} ${h}${pathname} refused: GET, HEAD and OPTIONS only`);
}

/** Lowercase, no trailing dot: the one spelling the lists, the proxy's certificate, Host and journal see. */
export function norm(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

function refuse(reason: string): Verdict {
  return { ok: false, reason };
}
