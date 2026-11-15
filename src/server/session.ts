import { createHmac, timingSafeEqual } from 'node:crypto';

/** The characters of a GitHub login: what a session may name, and never a `.`, which separates its parts. */
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

const mac = (payload: string, key: Buffer) => createHmac('sha256', key).update(payload).digest('base64url');

/**
 * The dashboard's session (ORC-399): `<login>.<expiry ms>.<HMAC-SHA256 of both>`, signed with a key the daemon draws at
 * its start and keeps in memory alone. Nothing to store or rotate; a restart ends every session.
 */
export function signSession(login: string, expiresAt: number, key: Buffer): string {
  if (!LOGIN.test(login)) throw new Error(`not a GitHub login: ${login}`);
  const payload = `${login}.${expiresAt}`;
  return `${payload}.${mac(payload, key)}`;
}

/** The login of a session signed with `key` that has not expired at `now`; undefined for anything else. */
export function readSession(value: string | undefined, key: Buffer, now: number): string | undefined {
  const [login, expires, given, ...rest] = value?.split('.') ?? [];
  if (rest.length > 0 || !login || !LOGIN.test(login) || !expires || !/^\d{1,15}$/.test(expires) || given === undefined) return undefined;
  const expected = Buffer.from(mac(`${login}.${expires}`, key));
  const got = Buffer.from(given);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return undefined;
  return Number(expires) > now ? login : undefined;
}
