import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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
 * decoded password).
 */
export function transcriptSecrets(env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
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
  // Longest first, so a secret that contains another is masked whole.
  return [...out].sort((a, b) => b.length - a.length);
}

/** Masks a transcript line (a JSON line of the stream): known secret values, then secret shapes. */
export function maskTranscriptLine(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const s of secrets) {
    // A secret appears in the line as JSON escapes it (a PEM's newlines become \n).
    for (const form of new Set([s, JSON.stringify(s).slice(1, -1)])) out = out.split(form).join(MASK);
  }
  for (const p of SECRET_PATTERNS) out = out.replace(p, MASK);
  return out;
}

/** When a transcript last written at `writtenAt` expires. */
export function transcriptExpiresAt(writtenAt: number): number {
  return writtenAt + TRANSCRIPT_RETENTION_MS;
}

/** Deletes the transcripts whose last write is older than the retention; returns the deleted file names. */
export function purgeTranscripts(dir: string, now: number, retentionMs = TRANSCRIPT_RETENTION_MS): string[] {
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
      if (statSync(file).mtimeMs + retentionMs <= now) {
        unlinkSync(file);
        removed.push(name);
      }
    } catch {
      // gone meanwhile, or unreadable: the next purge retries
    }
  }
  return removed;
}
