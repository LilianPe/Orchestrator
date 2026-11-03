import { readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/types.js';

/** How long a run transcript is kept (ORC-132): the daemon purges older ones. */
export const TRANSCRIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What replaces a secret in a transcript; plain text, so a JSON line stays valid. */
export const MASK = '[masqué]';

/** Environment variables whose value is a secret: tokens, keys, passwords, connection strings. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|_PASS|_PWD|APIKEY|_KEY|CREDENTIALS?|DATABASE_URL)$/i;

/** Shorter values are left alone: masking "1" or "true" everywhere would wreck the transcript. */
const MIN_SECRET_LENGTH = 8;

/** Secret shapes masked even when no variable holds them (a token pasted in a file, echoed by a tool). */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b/g,
  /\bBearer [A-Za-z0-9._~+/-]{20,}=*/g,
];

/**
 * The secret values of an environment, to mask literally: the value of every secret variable, and
 * the credentials of every URL value whatever its variable (`user:password` as written, and the
 * decoded password). `extra` adds the secrets held outside the environment (the daemon's secrets file).
 */
export function transcriptSecrets(env: Record<string, string | undefined>, extra: readonly string[] = []): string[] {
  const out = new Set(extra.filter((s) => s.length >= MIN_SECRET_LENGTH));
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (SECRET_NAME.test(name) && value.length >= MIN_SECRET_LENGTH) out.add(value);
    if (!value.includes('@')) continue;
    try {
      const url = new URL(value);
      if (!url.password) continue;
      out.add(`${url.username}:${url.password}`);
      const password = decodeURIComponent(url.password);
      if (password.length >= MIN_SECRET_LENGTH) out.add(password);
    } catch {
      // not a URL
    }
  }
  // Each as written and as JSON escapes it in a stream line (a PEM's newlines become \n), computed
  // once per run; longest first, so a secret that contains another is masked whole.
  const forms = new Set([...out].flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]));
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Masks a transcript line (a JSON line of the stream): known secret values, then secret shapes. */
export function maskTranscriptLine(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(MASK);
  for (const p of SECRET_PATTERNS) out = out.replace(p, MASK);
  return out;
}

const stale = (path: string, now: number): boolean => statSync(path).mtimeMs + TRANSCRIPT_RETENTION_MS <= now;

/** Deletes the transcripts whose last write is older than the retention; returns the deleted file names. */
export function purgeTranscripts(dir: string, now: number): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(dir, name);
    try {
      if (stale(file, now)) {
        unlinkSync(file);
        removed.push(name);
      }
    } catch {
      // gone meanwhile, or unreadable: the next purge retries
    }
  }
  return removed;
}

const dirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

/** Deletes the per-run dirs (`<runs>/<runId>`: refusals log, ORC-217) last changed 30 days ago or more; returns their names. */
export function purgeRunDirs(dir: string, now: number): string[] {
  return dirs(dir).filter((name) => {
    try {
      if (!stale(join(dir, name), now)) return false;
      rmSync(join(dir, name), { recursive: true, force: true });
      return true;
    } catch {
      return false; // gone meanwhile, or unreadable: the next purge retries
    }
  });
}

/**
 * Deletes the session dirs (`<sessions>/<project>/<ticket>`, ORC-217) of the closed tickets (done, or
 * their PR closed without merge, in the store's projection) whose dir was last changed 30 days ago or
 * more; returns them as `<project>/<ticket>`. A ticket the store does not know is left.
 */
export async function purgeSessionDirs(dir: string, now: number, store: Pick<Store, 'getTicket'>): Promise<string[]> {
  const closed = async (projectId: string, ticketId: string) => {
    const t = await store.getTicket(projectId, ticketId);
    return !!t && (t.logical === 'done' || t.prState === 'CLOSED');
  };
  const removed: string[] = [];
  for (const project of dirs(dir)) {
    for (const ticket of dirs(join(dir, project))) {
      const path = join(dir, project, ticket);
      try {
        if (!stale(path, now) || !(await closed(project, ticket))) continue;
        rmSync(path, { recursive: true, force: true });
        removed.push(`${project}/${ticket}`);
      } catch {
        // gone meanwhile, or unreadable: the next purge retries
      }
    }
  }
  return removed;
}
