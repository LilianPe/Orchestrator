import { z } from 'zod';
import { readCapped } from '../adapters/read-capped.js';
import { BUILT_IN_TOOLS } from '../presets/tools.js';
import type { SecurityLog, SecurityStats } from '../store/types.js';
import { unusualReads, type CountedRead } from './reads.js';

/** The rules of the pack's PreToolUse hook (`packs/standard/hooks/pre-tool-use.mjs`): a refusal naming another is forged. */
export const REFUSAL_RULES = [
  'web-search',
  'no-verify',
  'container-socket',
  'pipe-to-shell',
  'rm-root',
  'merge',
  'gh-write',
  'commit-no-verify',
  'reset-origin',
  'force-push',
  'push-trunk',
  'push',
  'full-read',
  'tool-not-allowed',
] as const;

/** The tools the hook's command and read rules judge. */
const JUDGED_TOOLS: readonly string[] = ['Bash', 'WebSearch', 'Read'];
/**
 * `tool-not-allowed` (ORC-383) refuses any tool, and the line names it as the agent's log wrote it: only a built-in tool's name is kept,
 * any other is `mcp` or `other`, never text the agent chose.
 */
const keptTool = (tool: string): string => (BUILT_IN_TOOLS.includes(tool) ? tool : tool.startsWith('mcp__') ? 'mcp' : 'other');

/** Rules the hook wrote once and no longer does: a log written before is still read. `forge-read`, a knowledge run's, until ORC-193. */
const RETIRED_RULES = ['forge-read'] as const;

/** Postgres text and jsonb refuse NUL: a line carrying one would fail the whole write. */
const text = (max: number) => z.string().max(max).refine((s) => !s.includes('\0'));
const at = z.iso.datetime().transform((s) => Date.parse(s));
const bytes = z.number().int().nonnegative();

/** A read that moves a public counter (ORC-370): what of its path is kept, to audit what a run read of a registry or a forge. */
const countedRead = z.object({ kind: z.enum(['npm', 'pypi', 'release']), name: text(300).min(1), item: text(300).min(1) });

const egressLine = z.object({
  at,
  method: text(32),
  host: text(300),
  port: z.number().int().min(0).max(65_535).optional(),
  // Its path, and the reason the proxy gave, which names it, are not read: they can hold a secret. A counted read's
  // package and version, or asset, are (ORC-370): one this log cannot vouch for is dropped, the line kept.
  ok: z.boolean(),
  up: bytes,
  down: bytes,
  read: countedRead.optional().catch(undefined),
  suspicious: z.literal(true).optional(),
});

/** What the lockfiles of a run's repository declared when it started (`DeclaredReads`, written by the orchestrator). */
const declaredFile = z.object({ judged: z.array(z.enum(['npm', 'pypi', 'release'])), reads: z.array(z.string()) });
const DECLARED_MAX_BYTES = 16 * 1024 * 1024;

/** The run's declaration, undefined when there is none or it cannot be read: no read is then judged unusual. */
function declared(path: string | undefined): ((read: CountedRead) => boolean) | undefined {
  const read = path === undefined ? undefined : readCapped(path, DECLARED_MAX_BYTES);
  if (read === undefined || read === 'not a file' || read.cut) return undefined;
  try {
    const d = declaredFile.safeParse(JSON.parse(read.text));
    return d.success ? unusualReads(d.data) : undefined;
  } catch {
    return undefined;
  }
}

/** The command a line names, or the path of a refused read, is not read: it can hold a secret. */
const refusalLine = (ticketId: string) =>
  z
    .object({
      at,
      tool: text(200),
      rule: z.enum([...REFUSAL_RULES, ...RETIRED_RULES]),
      // The hook writes the run's FACTORY_TICKET: another ticket is a forged line.
      ticket: z.literal(ticketId),
    })
    .refine((l) => l.rule === 'tool-not-allowed' || JUDGED_TOOLS.includes(l.tool))
    .transform((l) => ({ ...l, tool: keptTool(l.tool) }));

/** The proxy's journal is the daemon's; the refusals log is the agent's, a few lines at most. */
const EGRESS_MAX_BYTES = 16 * 1024 * 1024;
const REFUSALS_MAX_BYTES = 1024 * 1024;

/**
 * The valid lines of a journal, and how many were skipped: malformed, forged, cut by the cap (the rest past it counts as one).
 * A line `aside` names is neither: the proxy's notes (ORC-337), no request nor refusal, stay in its journal alone.
 */
function parse<T>(path: string | undefined, cap: number, line: z.ZodType<T>, aside: (raw: unknown) => boolean = () => false): { entries: T[]; skipped: number } {
  const read = path === undefined ? undefined : readCapped(path, cap);
  if (read === undefined) return { entries: [], skipped: 0 };
  if (read === 'not a file') return { entries: [], skipped: 1 };
  const lines = read.text.split('\n');
  // A file cut mid-line: its last line is a piece, the rest unread; both count as one.
  if (read.cut) lines.pop();
  const entries: T[] = [];
  let skipped = read.cut ? 1 : 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(l);
    } catch {
      skipped++;
      continue;
    }
    if (aside(raw)) continue;
    const r = line.safeParse(raw);
    if (r.success) entries.push(r.data);
    else skipped++;
  }
  return { entries, skipped };
}

/** A note of the proxy's journal (`EgressNote`): a beta dropped, a model call throttled or cut, its client gone. */
const isNote = (raw: unknown) => typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'note';

/**
 * A run's security log (ORC-296), from the proxy's journal (`egress`, absent without a proxy) and the
 * hook's refusals log: the rule and the host, never a command nor a path, but a counted read's package and version
 * or asset (ORC-370), flagged `suspicious` when the proxy refused it past the run's cap, `unusual` when the lockfiles
 * `declared` at the run's start do not name it. Never throws on what a journal holds: a bad line is skipped and counted.
 */
export function readSecurityLog(
  run: Pick<SecurityLog, 'runId' | 'projectId' | 'ticketId' | 'at'>,
  paths: { egress?: string; refusals: string; declared?: string },
): SecurityLog {
  const egress = parse(paths.egress, EGRESS_MAX_BYTES, egressLine, isNote);
  const refusals = parse(paths.refusals, REFUSALS_MAX_BYTES, refusalLine(run.ticketId));
  const unusual = declared(paths.declared);
  // The lines' fields not declared above, a command, a path, the proxy's reason, are already left out by the parse.
  return {
    ...run,
    egress: egress.entries.map(({ read, suspicious, ...e }) => {
      const flag = suspicious ? 'suspicious' : read && e.ok && unusual?.(read) ? 'unusual' : undefined;
      return { ...e, ...(read ? { read } : {}), ...(flag ? { flag } : {}) };
    }),
    refusals: refusals.entries.map(({ at, tool, rule }) => ({ at, tool, rule })),
    skipped: { egress: egress.skipped, refusals: refusals.skipped },
  };
}

/** A host as the proxy saw it, from the agent's request: posted only when it is a plain host name. */
const PLAIN_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const HOSTS_SHOWN = 10;

function counts(keys: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * What the factory posts in the ticket's session after a run with refusals (ORC-296): refusals per rule,
 * hosts the proxy refused. Never a command nor a path: they can hold a secret. Undefined without a refusal.
 */
export function refusalSummary(log: SecurityLog): string | undefined {
  const refused = log.egress.filter((e) => !e.ok);
  if (log.refusals.length === 0 && refused.length === 0) return undefined;
  const out = ['Refusals during this run:'];
  for (const [rule, n] of counts(log.refusals.map((r) => r.rule))) out.push(`- rule \`${rule}\`: ${n}`);
  const hosts = counts(refused.map((e) => e.host).filter((h) => PLAIN_HOST.test(h)));
  const other = refused.length - hosts.reduce((s, [, n]) => s + n, 0) + hosts.slice(HOSTS_SHOWN).reduce((s, [, n]) => s + n, 0);
  if (refused.length) {
    const named = hosts.slice(0, HOSTS_SHOWN).map(([h, n]) => `\`${h}\` (${n})`);
    out.push(`- hosts refused by the proxy: ${[...named, ...(other ? [`${other} other${other > 1 ? 's' : ''}`] : [])].join(', ')}`);
  }
  const suspicious = refused.filter((e) => e.flag === 'suspicious').length;
  if (suspicious) out.push(`- ${suspicious} read${suspicious > 1 ? 's' : ''} refused as suspicious (past the per-run cap of distinct versions or release assets)`);
  const skipped = log.skipped.egress + log.skipped.refusals;
  if (skipped) out.push(`\n${skipped} log line${skipped > 1 ? 's' : ''} ignored (malformed or forged).`);
  return out.join('\n');
}

/**
 * A run's security log as the dashboard shows it (ORC-300): its refusals listed and counted per rule, the hosts it
 * contacted with those the proxy refused. Only the rule and a plain host name: never a command, a path, the proxy's
 * reason nor a host that is not a plain name, which can hold a secret or what the agent wrote.
 */
export interface RunSecurityView {
  runId: string;
  projectId: string;
  ticketId: string;
  at: number;
  rules: SecurityStats['rules'];
  refusals: { at: number; tool: string; rule: string }[];
  /** Contacted, with the requests the proxy refused; those not a plain host name together, under `OTHER_HOSTS`. */
  hosts: HostCount[];
  skipped: SecurityLog['skipped'];
}

type HostCount = SecurityStats['hosts'][number];

/** The row of the hosts that are not a plain host name: the agent wrote them, they can hold anything. */
export const OTHER_HOSTS = '(not a host name)';

/** Host counts as the dashboard shows them: plain host names as counted, the others merged into one row, last. */
export function shownHosts(hosts: readonly HostCount[]): HostCount[] {
  const named = hosts.filter((h) => PLAIN_HOST.test(h.host));
  const other = hosts.filter((h) => !PLAIN_HOST.test(h.host));
  if (!other.length) return named;
  return [...named, { host: OTHER_HOSTS, requests: other.reduce((s, h) => s + h.requests, 0), refused: other.reduce((s, h) => s + h.refused, 0) }];
}

export function runSecurityView(log: SecurityLog): RunSecurityView {
  const refused = new Map(counts(log.egress.filter((e) => !e.ok).map((e) => e.host)));
  return {
    runId: log.runId,
    projectId: log.projectId,
    ticketId: log.ticketId,
    at: log.at,
    rules: counts(log.refusals.map((r) => r.rule)).map(([rule, refusals]) => ({ rule, refusals })),
    refusals: log.refusals.map(({ at, tool, rule }) => ({ at, tool, rule })),
    hosts: shownHosts(counts(log.egress.map((e) => e.host)).map(([host, requests]) => ({ host, requests, refused: refused.get(host) ?? 0 }))),
    skipped: log.skipped,
  };
}
