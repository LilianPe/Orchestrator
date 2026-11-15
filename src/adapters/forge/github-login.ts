import { fetchHttp, type HttpClient } from './github-app.js';

/**
 * Who may sign in to the dashboard (ORC-399), `dashboard` of factory.yml: any of these logins, the active members of
 * `org`, or those of `team` (`<org>/<team-slug>`). Logins compare as GitHub compares them, whatever their case.
 */
export interface DashboardAccess {
  logins: string[];
  org?: string;
  team?: string;
}

/** Who GitHub says signed in, and whether `DashboardAccess` lets them in. */
export interface SignIn {
  login: string;
  allowed: boolean;
}

export interface GithubLoginOptions {
  /** The factory App's OAuth client: a user-to-server token, for this sign-in alone, never kept. */
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  access: DashboardAccess;
  http?: HttpClient;
}

const API = 'https://api.github.com';

/** GitHub's authorization of the factory App for the browser to open; no sign-up offered there. */
export function githubAuthorizeUrl(o: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('state', o.state);
  u.searchParams.set('allow_signup', 'false');
  return u.toString();
}

/**
 * The sign-in of the code GitHub's callback brings: exchanged with the App's credentials for a user token, who it is
 * read with that token, then the list, the org, the team. Throws when GitHub refuses the code or does not answer: no one
 * is let in on an answer that is not GitHub's.
 */
export async function githubSignIn(o: GithubLoginOptions, code: string): Promise<SignIn> {
  const http = o.http ?? fetchHttp;
  const exchange = await http('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'factory-orchestrator' },
    body: JSON.stringify({ client_id: o.clientId, client_secret: o.clientSecret, code, redirect_uri: o.redirectUri }),
  });
  if (!exchange.ok) throw new Error(`GitHub OAuth answered ${exchange.status}`);
  const token = JSON.parse(await exchange.text()) as { access_token?: string; error?: string };
  if (!token.access_token) throw new Error(`GitHub OAuth refused: ${token.error ?? 'no token'}`);
  const get = (path: string) =>
    http(`${API}${path}`, {
      method: 'GET',
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token.access_token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'factory-orchestrator' },
    });
  const user = await get('/user');
  if (!user.ok) throw new Error(`GitHub answered ${user.status} on /user`);
  const { login } = JSON.parse(await user.text()) as { login: string };
  // An active membership, read with the person's own token: 403 or 404 when GitHub says they are not a member.
  const member = async (path: string) => {
    const res = await get(path);
    if (res.status === 403 || res.status === 404) return false;
    if (!res.ok) throw new Error(`GitHub answered ${res.status} on ${path}`);
    return (JSON.parse(await res.text()) as { state?: string }).state === 'active';
  };
  const { logins, org, team } = o.access;
  if (logins.some((l) => l.toLowerCase() === login.toLowerCase())) return { login, allowed: true };
  if (org && (await member(`/user/memberships/orgs/${encodeURIComponent(org)}`))) return { login, allowed: true };
  if (team) {
    const [teamOrg, slug] = team.split('/');
    if (await member(`/orgs/${encodeURIComponent(teamOrg!)}/teams/${encodeURIComponent(slug!)}/memberships/${encodeURIComponent(login)}`)) return { login, allowed: true };
  }
  return { login, allowed: false };
}
