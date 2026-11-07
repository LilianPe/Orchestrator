export const LINEAR_SCOPES = 'read,write,app:assignable,app:mentionable';
const TOKEN_URL = 'https://api.linear.app/oauth/token';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export function buildAuthorizeUrl(o: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL('https://linear.app/oauth/authorize');
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', LINEAR_SCOPES);
  u.searchParams.set('actor', 'app');
  u.searchParams.set('state', o.state);
  return u.toString();
}

async function tokenRequest(params: Record<string, string>, fetchImpl: typeof fetch, now: number): Promise<TokenSet> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`Linear OAuth refused: ${json.error ?? res.status}`);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? now + json.expires_in * 1000 : undefined,
  };
}

export function exchangeCode(o: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<TokenSet> {
  return tokenRequest(
    { grant_type: 'authorization_code', code: o.code, redirect_uri: o.redirectUri, client_id: o.clientId, client_secret: o.clientSecret },
    o.fetchImpl ?? fetch,
    o.now ?? Date.now(),
  );
}

export function refreshToken(o: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<TokenSet> {
  return tokenRequest(
    { grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.clientId, client_secret: o.clientSecret },
    o.fetchImpl ?? fetch,
    o.now ?? Date.now(),
  );
}

export class TokenManager {
  private inflight: Promise<string> | undefined;

  constructor(
    private o: {
      load: () => TokenSet | undefined;
      save: (t: TokenSet) => void;
      clientId: string;
      clientSecret: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  async get(): Promise<string> {
    const t = this.o.load();
    if (!t) throw new Error('Linear not connected');
    const now = (this.o.now ?? Date.now)();
    if (!t.expiresAt || !t.refreshToken || t.expiresAt - now > 5 * 60_000) return t.accessToken;
    this.inflight ??= refreshToken({
      clientId: this.o.clientId,
      clientSecret: this.o.clientSecret,
      refreshToken: t.refreshToken,
      fetchImpl: this.o.fetchImpl,
      now,
    })
      .then((fresh) => {
        const merged = { ...fresh, refreshToken: fresh.refreshToken ?? t.refreshToken };
        this.o.save(merged);
        return merged.accessToken;
      })
      .finally(() => (this.inflight = undefined));
    return this.inflight;
  }
}
