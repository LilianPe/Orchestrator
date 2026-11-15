import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readSession, signSession } from './session.js';

describe('the signed session of the dashboard (ORC-399)', () => {
  const key = randomBytes(32);

  it('gives back the login it was signed for, until it expires', () => {
    const cookie = signSession('armand', 1_000, key);
    expect(readSession(cookie, key, 999)).toBe('armand');
    expect(readSession(cookie, key, 1_000)).toBeUndefined();
  });

  it('refuses a session signed with another key: a restart of the daemon ends every session', () => {
    expect(readSession(signSession('armand', 1_000, randomBytes(32)), key, 0)).toBeUndefined();
  });

  it('refuses a session whose login or expiry was changed, and anything that is not a session', () => {
    const [login, expires, mac] = signSession('armand', 1_000, key).split('.');
    expect(login).toBe('armand');
    expect(readSession(`lilian.${expires}.${mac}`, key, 0)).toBeUndefined();
    expect(readSession(`${login}.9999999.${mac}`, key, 0)).toBeUndefined();
    for (const value of [undefined, '', 'armand', 'armand.1000', 'armand.x.y', 'a.b.c.d']) expect(readSession(value, key, 0), String(value)).toBeUndefined();
  });
});
