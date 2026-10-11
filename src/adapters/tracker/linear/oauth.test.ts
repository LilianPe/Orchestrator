import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, exchangeCode, TokenManager, type TokenSet } from './oauth.js';

describe('oauth', () => {
  it('builds an app-actor authorize URL', () => {
    const u = new URL(buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'http://localhost:4100/oauth/callback', state: 'xyz' }));
    expect(u.origin + u.pathname).toBe('https://linear.app/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: 'cid', redirect_uri: 'http://localhost:4100/oauth/callback', response_type: 'code',
      scope: 'read,write,app:assignable,app:mentionable', actor: 'app', state: 'xyz',
    });
  });

  it('exchanges a code', async () => {
    let body = '';
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    const t = await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'k', redirectUri: 'r', fetchImpl, now: 1000 });
    expect(t).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 3_600_000 });
    expect(new URLSearchParams(body).get('grant_type')).toBe('authorization_code');
  });

  it('refreshes a token about to expire', async () => {
    let saved: TokenSet | undefined;
    const fetchImpl = (async () => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600 }))) as unknown as typeof fetch;
    const m = new TokenManager({
      load: () => ({ accessToken: 'old', refreshToken: 'rt', expiresAt: 1000 + 60_000 }),
      save: (t) => (saved = t),
      clientId: 'c', clientSecret: 's', fetchImpl, now: () => 1000,
    });
    expect(await m.get()).toBe('new');
    expect(saved).toEqual({ accessToken: 'new', refreshToken: 'rt2', expiresAt: 1000 + 3_600_000 });
  });

  it('throws when not connected', async () => {
    const m = new TokenManager({ load: () => undefined, save: () => {}, clientId: 'c', clientSecret: 's' });
    await expect(m.get()).rejects.toThrow('Linear non connecté');
  });
});
