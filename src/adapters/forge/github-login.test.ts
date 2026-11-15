import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpRequest } from './github-app.js';
import { githubAuthorizeUrl, githubSignIn, type DashboardAccess } from './github-login.js';

/** GitHub as the sign-in reaches it: the code exchange, the user, and the memberships `members` holds, by URL. */
function github(members: Record<string, { status: number; state?: string; headers?: Record<string, string> }> = {}, token: { status?: number; body?: unknown } = {}) {
  const calls: { url: string; init: HttpRequest }[] = [];
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init });
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status < 300, status, headers: new Headers(headers), text: async () => JSON.stringify(body) });
    if (url === 'https://github.com/login/oauth/access_token') return answer(token.status ?? 200, token.body ?? { access_token: 'ghu_user', token_type: 'bearer' });
    if (url === 'https://api.github.com/user') return answer(200, { login: 'Armand', id: 1 });
    const m = members[url];
    return m ? answer(m.status, { state: m.state }, m.headers) : answer(404, { message: 'Not Found' });
  };
  return { http, calls };
}

const signIn = (access: DashboardAccess, gh: ReturnType<typeof github>) =>
  githubSignIn({ clientId: 'Iv1.client', clientSecret: 'client-secret', redirectUri: 'https://factory.example/auth/github/callback', access, http: gh.http }, 'the-code');

describe('signing in to the dashboard with GitHub, through the factory App (ORC-399)', () => {
  it("sends the browser to GitHub's authorization of the App, with its state and the callback", () => {
    const url = new URL(githubAuthorizeUrl({ clientId: 'Iv1.client', redirectUri: 'https://factory.example/auth/github/callback', state: 's1' }));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'Iv1.client', redirect_uri: 'https://factory.example/auth/github/callback', state: 's1', allow_signup: 'false' });
  });

  it('exchanges the code with the App credentials, reads who signed in with the user token, and lets in a login of the list, whatever its case', async () => {
    const gh = github();
    expect(await signIn({ logins: ['armand', 'lilianpe'] }, gh)).toEqual({ login: 'Armand', allowed: true });
    const [exchange, user] = gh.calls;
    expect(JSON.parse(exchange!.init.body!)).toEqual({ client_id: 'Iv1.client', client_secret: 'client-secret', code: 'the-code', redirect_uri: 'https://factory.example/auth/github/callback' });
    expect(exchange!.init.headers).toMatchObject({ accept: 'application/json' });
    expect(user!.init.headers).toMatchObject({ authorization: 'Bearer ghu_user' });
    // On the list: no membership asked.
    expect(gh.calls).toHaveLength(2);
  });

  it('lets in an active member of the org, never a pending one nor someone GitHub says is not a member', async () => {
    const url = 'https://api.github.com/user/memberships/orgs/acme';
    expect(await signIn({ logins: [], org: 'acme' }, github({ [url]: { status: 200, state: 'active' } }))).toEqual({ login: 'Armand', allowed: true });
    expect(await signIn({ logins: [], org: 'acme' }, github({ [url]: { status: 200, state: 'pending' } }))).toEqual({ login: 'Armand', allowed: false });
    expect(await signIn({ logins: [], org: 'acme' }, github({ [url]: { status: 403 } }))).toEqual({ login: 'Armand', allowed: false });
    expect(await signIn({ logins: ['lilianpe'], org: 'acme' }, github())).toEqual({ login: 'Armand', allowed: false });
  });

  it('lets in an active member of the team, asked of the org by its slug', async () => {
    const url = 'https://api.github.com/orgs/acme/teams/factory-ops/memberships/Armand';
    expect(await signIn({ logins: [], team: 'acme/factory-ops' }, github({ [url]: { status: 200, state: 'active' } }))).toEqual({ login: 'Armand', allowed: true });
    expect(await signIn({ logins: [], team: 'acme/factory-ops' }, github())).toEqual({ login: 'Armand', allowed: false });
  });

  it('throws on a refused code or a GitHub that does not answer, rather than deciding who it is', async () => {
    await expect(signIn({ logins: ['armand'] }, github({}, { body: { error: 'bad_verification_code' } }))).rejects.toThrow(/bad_verification_code/);
    await expect(signIn({ logins: ['armand'] }, github({}, { status: 500, body: {} }))).rejects.toThrow(/500/);
    const url = 'https://api.github.com/user/memberships/orgs/acme';
    await expect(signIn({ logins: [], org: 'acme' }, github({ [url]: { status: 502 } }))).rejects.toThrow(/502/);
    // A rate limit is no answer about the membership: it throws, never refuses a member.
    await expect(signIn({ logins: [], org: 'acme' }, github({ [url]: { status: 403, headers: { 'x-ratelimit-remaining': '0' } } }))).rejects.toThrow(/403/);
  });
});
