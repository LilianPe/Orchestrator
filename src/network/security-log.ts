import { z } from 'zod';
import { readCapped } from '../adapters/read-capped.js';
import type { EgressRecord, RefusalRecord, SecurityLog } from '../store/types.js';

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
] as const;

/** Postgres text and jsonb refuse NUL: a line carrying one would fail the whole write. */
const text = (max: number) => z.string().max(max).refine((s) => !s.includes('\0'));
const at = z.iso.datetime().transform((s) => Date.parse(s));
const bytes = z.number().int().nonnegative();

const egressLine = z.object({
  at,
  method: text(32),
  host: text(300),
  port: z.number().int().min(0).max(65_535).optional(),
  path: text(4096).optional(),
  ok: z.boolean(),
  reason: text(1000).optional(),
  up: bytes,
  down: bytes,
});

/** A command, or the path of a refused read, is kept for the maintainers, capped: it may be long, and is never posted (it can hold a secret). */
const COMMAND_MAX = 2000;
const refusalLine = (ticketId: string) =>
  z.object({
    at,
    tool: z.enum(['Bash', 'WebSearch', 'Read']),
    command: z
      .string()
      .refine((s) => !s.includes('\0'))
      .transform((s) => s.slice(0, COMMAND_MAX)),
    rule: z.enum(REFUSAL_RULES),
    // The hook writes the run's FACTORY_TICKET: another ticket is a forged line.
    ticket: z.literal(ticketId),
  });

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

const drop = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * A run's security log (ORC-296), from the proxy's journal (`egress`, absent without a proxy) and the
 * hook's refusals log. Never throws on what a journal holds: a bad line is skipped and counted.
 */
export function readSecurityLog(
  run: Pick<SecurityLog, 'runId' | 'projectId' | 'ticketId' | 'at'>,
  paths: { egress?: string; refusals: string },
): SecurityLog {
  const egress = parse(paths.egress, EGRESS_MAX_BYTES, egressLine, isNote);
  const refusals = parse(paths.refusals, REFUSALS_MAX_BYTES, refusalLine(run.ticketId));
  return {
    ...run,
    egress: egress.entries.map((e) => drop(e) as EgressRecord),
    refusals: refusals.entries.map(({ at, tool, rule, command }): RefusalRecord => ({ at, tool, rule, command })),
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
  const skipped = log.skipped.egress + log.skipped.refusals;
  if (skipped) out.push(`\n${skipped} log line${skipped > 1 ? 's' : ''} ignored (malformed or forged).`);
  return out.join('\n');
}
