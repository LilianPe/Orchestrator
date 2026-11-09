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

/**
 * The largest model call the proxy reads (ORC-337), far below the API's own 32 MB. A run's first calls are ~52 KB
 * with the factory's tools (measured on 2.1.316, a tool call and its result included); a call grows with the conversation up to the model's context window, 1M tokens, about
 * 4 MiB of text, plus the images Claude Code read (each resized under the API's 5 MB).
 * ponytail: 16 MiB, four times a full window of text; a run past it gets a 413 in its journal, raise it then.
 */
export const CLAUDE_BODY_MAX = 16 * 1024 * 1024;

/**
 * Model calls held at once, from their first byte until they are sent on, per run and in all (ORC-337). A run gets
 * its share alone, so four runs at least are served side by side. Past it, a 429, which Claude Code retries.
 * Memory at worst, to size the proxy's container by: the calls held, `CLAUDE_READS_MAX` × `CLAUDE_BODY_MAX`, plus
 * about 5 copies of the one being checked (`claudeBody`: its bytes joined, decoded, parsed, serialised again and
 * encoded), one call at a time since the check is synchronous: (8 + 5) × 16 MiB, ~210 MiB, over the process's own.
 * A body outside Latin-1 decodes to two bytes a character, so a little more.
 */
export const CLAUDE_READS_PER_RUN = 2;
export const CLAUDE_READS_MAX = 8;

/** How long a model call's body may take to come in (ORC-337): past it, the call is cut and its place freed. */
export const CLAUDE_READ_MS = 30_000;

/**
 * How deep a model call may nest (ORC-337), checked on the raw bytes before anything parses them: deeper, a parse,
 * a walk or a serialisation could run out of stack. Claude Code's calls nest 10 deep (measured on 2.1.316, haiku and
 * opus, its tools' schemas and a tool call included).
 */
export const CLAUDE_BODY_DEPTH = 64;

/**
 * Tools run by the client, Claude Code: its own (no `type`, or `custom`), and the Anthropic-defined ones the
 * client executes. Any other type is a server tool (web search, web fetch, code execution, MCP toolset, tool
 * search…), run by Anthropic's servers on the factory's account: a way out for a hijacked agent.
 */
const CLIENT_TOOL = /^(custom|(bash|text_editor|computer|memory)_\d{8})$/;

const UTF8 = new TextDecoder('utf-8', { fatal: true });

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** A byte a JSON number is written with, or the `e` of `true` and `false`, which `numberProblem` leaves alone. */
const inNumber = (c: number) => (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2b || c === 0x2e || c === 0x65 || c === 0x45;

/** A number token that does not survive a parse and a serialisation as the API would read it: one past a double's range. */
function numberProblem(raw: Buffer, start: number, end: number): string | undefined {
  const token = raw.toString('latin1', start, end);
  return /^-?\d/.test(token) && !Number.isFinite(Number(token)) ? `the number ${token.slice(0, 20)} out of range` : undefined;
}

/**
 * One linear pass over the raw bytes, before any parse (ORC-337): nesting past `CLAUDE_BODY_DEPTH`, or a number a
 * double cannot hold. A string is skipped to its closing quote, one not escaped by an odd run of backslashes.
 */
function rawProblem(raw: Buffer): string | undefined {
  let depth = 0;
  let number = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inNumber(c)) {
      if (number < 0) number = i;
      continue;
    }
    if (number >= 0) {
      const p = numberProblem(raw, number, i);
      if (p) return p;
      number = -1;
    }
    if (c === QUOTE) {
      let close = raw.indexOf(QUOTE, i + 1);
      while (close > 0) {
        let slashes = 0;
        while (raw[close - 1 - slashes] === BACKSLASH) slashes++;
        if (slashes % 2 === 0) break;
        close = raw.indexOf(QUOTE, close + 1);
      }
      if (close < 0) return undefined; // unterminated: the parse refuses it
      i = close;
    } else if ((c === 0x5b || c === 0x7b) && ++depth > CLAUDE_BODY_DEPTH) return `nested deeper than ${CLAUDE_BODY_DEPTH}`;
    else if (c === 0x5d || c === 0x7d) depth--;
  }
  return number >= 0 ? numberProblem(raw, number, raw.length) : undefined;
}

/** A block's content Anthropic would fetch: anything but inline data. */
const INLINE_SOURCE = new Set(['base64', 'text']);

/**
 * Why a list of content blocks (a message's, the system's, a tool result's) would make Anthropic fetch a URL: an
 * image or document by URL or by file, a block or a citation carrying a `url`, a search result's `source`. Nested
 * contents are read too. A tool call's `input` is the agent's own data, never fetched: not read.
 */
function contentProblem(content: unknown): string | undefined {
  if (content === undefined || typeof content === 'string') return undefined;
  if (!Array.isArray(content)) return 'a content that is not a list';
  for (const block of content as unknown[]) {
    if (typeof block !== 'object' || block === null) return 'a content block that is not an object';
    const b = block as Record<string, unknown>;
    const kind = String(b['type']);
    if (Object.hasOwn(b, 'url')) return `a ${kind} block with a url`;
    if (Object.hasOwn(b, 'source')) {
      const source = b['source'];
      const type = typeof source === 'object' && source !== null ? (source as Record<string, unknown>)['type'] : undefined;
      if (typeof type !== 'string' || !INLINE_SOURCE.has(type)) return `a ${kind} block sourced by ${typeof type === 'string' ? type : typeof source}`;
    }
    const citations = b['citations'];
    if (Array.isArray(citations) && citations.some((c) => typeof c !== 'object' || c === null || Object.hasOwn(c, 'url'))) return `a ${kind} block cited by url`;
    const inner = contentProblem(b['content']);
    if (inner) return inner;
  }
  return undefined;
}

/** Why a model call would make Anthropic's servers reach out on the factory's account, if it would. */
function callProblem(c: Record<string, unknown>): string | undefined {
  for (const k of ['mcp_servers', 'container']) if (Object.hasOwn(c, k)) return k;
  const tools = c['tools'];
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return 'tools is not a list';
    for (const t of tools as unknown[]) {
      const type = typeof t === 'object' && t !== null ? (t as Record<string, unknown>)['type'] : 'not an object';
      if (type !== undefined && !(typeof type === 'string' && CLIENT_TOOL.test(type))) return `server tool ${String(type)}`;
    }
  }
  const messages = c['messages'];
  if (messages !== undefined && !Array.isArray(messages)) return 'messages is not a list';
  for (const m of (messages ?? []) as unknown[]) {
    if (typeof m !== 'object' || m === null) return 'a message that is not an object';
    const p = contentProblem((m as Record<string, unknown>)['content']);
    if (p) return p;
  }
  return contentProblem(c['system']);
}

/**
 * A model call's body (`/v1/messages`, `/v1/messages/count_tokens`), read by the proxy (ORC-337): JSON, no MCP
 * server, no container, client tools only, no content fetched by URL. Claude Code sends none of these (measured).
 * What goes on is the call as checked, serialised again: duplicate keys, which a parser may read otherwise than
 * this one, are gone.
 */
export function claudeBody(raw: Buffer): { ok: true; body: Buffer } | { ok: false; reason: string } {
  const scanned = rawProblem(raw);
  if (scanned) return { ok: false, reason: `Claude API body refused: ${scanned}` };
  let call: unknown;
  try {
    call = JSON.parse(UTF8.decode(raw));
  } catch {
    return { ok: false, reason: 'Claude API body refused: not JSON in UTF-8' };
  }
  if (typeof call !== 'object' || call === null || Array.isArray(call)) return { ok: false, reason: 'Claude API body refused: not a JSON object' };
  const problem = callProblem(call as Record<string, unknown>);
  // ponytail: scanned, parsed, walked and serialised again whole: ~40 ms of the event loop for a 4.3 MiB call (measured),
  // ~1 ms for a run's usual ~50 KB, ~150 ms at the 16 MiB cap. If calls grow there, check duplicate keys in a parse of
  // one's own and send the bytes as they came.
  return problem ? { ok: false, reason: `Claude API body refused: ${problem}` } : { ok: true, body: Buffer.from(JSON.stringify(call)) };
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
 * An agent run's policy (ORC-209 C): its step's level narrowed by the repository's, the Claude API kept for a repository at
 * `none`, as the MVP doc says of a step that calls the agent: without it, no run can start. The preset's `review` runs at
 * `claude-api` (ORC-183): it reads a clone the factory made and has no tool that reaches anything else. A job out of the
 * preset (`ask`, `learn`) has no step, and runs at the repository's level.
 */
export function agentPolicy(config: RepoConfig, step?: NetworkLevel): EgressPolicy {
  const p = stepPolicy(config, step);
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
