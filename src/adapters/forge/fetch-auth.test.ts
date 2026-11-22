import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { repoRoot } from '../../app/root.js';
import { execCmd, type Exec } from '../exec.js';
import { GitHubAppForge } from './github-app.js';
import type { HttpClient } from './github-app.js';
import type { CloneAuth } from './types.js';
import { cloneAuth } from '../../app/project-github.js';
import { makeRepoConfig } from '../../app/repo-variables.js';
import { fetchFromForge } from '../../core/clean-verify.js';
import { cloneAtStart } from '../../ghost/history.js';
import { KnowledgeBase } from '../../knowledge/kb.js';
import { isTransient } from '../../runtime/transient.js';
import { fetchOrigin, GitWorkspaces } from '../workspace/git-workspaces.js';

/**
 * ORC-442: the daemon reads a private repository with the App's installation token, on a machine without any git credential of
 * its own, and the token reaches neither a URL, nor a command line, nor a log line, nor the repository's config.
 */

const TOKEN = 'ghs_private_fetch_442';
const BASIC = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
const privatePem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...NO_CREDENTIALS } }).trim();

/** A machine with no git credential: no global or system config (no helper), no askpass, no prompt. */
const NO_CREDENTIALS = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_TERMINAL_PROMPT: '0' };

/** git's smart HTTP, served by `git http-backend`, to whoever sends the installation token alone: a private repository. */
async function privateServer(root: string): Promise<{ base: string; auths: (string | undefined)[] }> {
  const auths: (string | undefined)[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    auths.push(req.headers.authorization);
    if (req.headers.authorization !== BASIC) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="private"' }).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...process.env, ...NO_CREDENTIALS, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET', CONTENT_TYPE: req.headers['content-type'] ?? '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', REMOTE_ADDR: '127.0.0.1',
        // Authenticated: the push of the knowledge base's note is received.
        REMOTE_USER: 'x-access-token',
      },
    });
    req.pipe(cgi.stdin);
    const out: Buffer[] = [];
    cgi.stdout.on('data', (b: Buffer) => out.push(b));
    cgi.on('close', () => {
      const all = Buffer.concat(out);
      const end = all.indexOf('\r\n\r\n');
      const head = all.subarray(0, end).toString().split('\r\n');
      const headers = Object.fromEntries(head.map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
      const status = Number(/^\d+/.exec(headers['Status'] ?? '200')?.[0]);
      delete headers['Status'];
      res.writeHead(status, headers).end(all.subarray(end + 4));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  onTestFinished(() => void server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, auths };
}

/** The App's API, scripted: an installation token, `TOKEN`, for `acme/app` alone. */
const tokenApi: HttpClient = async (url, init) => {
  const ok = new URL(url).pathname === '/app/installations/42/access_tokens' && init.method === 'POST';
  const text = ok ? JSON.stringify({ token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }) : '{}';
  return { ok, status: ok ? 201 : 404, headers: { get: () => null }, text: async () => text };
};

/** The factory's repository of a private `acme/app`, its origin on the server, and a commit on the server it does not have yet. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-fetch-auth-'));
  const root = join(dir, 'srv');
  const bare = join(root, 'acme', 'app.git');
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', bare);
  // As GitHub: any commit of the repository can be fetched by its id (the ghost's clone at the start).
  git(bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  const work = join(dir, 'work');
  git(dir, 'init', '--quiet', '-b', 'main', work);
  const commit = (msg: string) => {
    writeFileSync(join(work, 'f.txt'), `${msg}\n`);
    git(work, 'add', '.');
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', msg);
    git(work, 'push', '--quiet', bare, 'main');
    return git(work, 'rev-parse', 'HEAD');
  };
  commit('one');
  const server = await privateServer(root);
  const repo = join(dir, 'repo');
  git(dir, 'clone', '--quiet', bare, repo);
  git(repo, 'remote', 'set-url', 'origin', `${server.base}/acme/app.git`);
  const second = commit('two');
  // Every command the daemon spawns, its line kept; run on a machine without credentials.
  const lines: string[] = [];
  const exec: Exec = (cmd, args, opts = {}) => {
    lines.push([cmd, ...args].join(' '));
    return execCmd(cmd, args, { ...opts, env: { ...NO_CREDENTIALS, ...opts.env } });
  };
  const logs: string[] = [];
  const forge = new GitHubAppForge({ appId: '1', privateKey: privatePem, installationId: 42, http: tokenApi, webBase: server.base, log: (m) => logs.push(m) });
  // As the daemon wires it (ORC-478): the factory's clone stands for `acme/app`.
  const auth = cloneAuth((github) => forge.fetchEnv(github), new Map([[repo, 'acme/app']]))!;
  return { dir, repo, second, server, exec, lines, logs, forge, auth, url: `${server.base}/acme/app.git` };
}

describe('the daemon fetches a private repository with the App installation token (ORC-442)', () => {
  it('fetches it with the token on a machine without git credentials, and is refused without it', async () => {
    const f = await fixture();
    const without = await fetchOrigin(f.exec, f.repo, { log: (m) => f.logs.push(m) }).then(() => 'fetched', (err: Error) => err.message);
    expect(without).toMatch(/the forge could not be read/);
    await fetchOrigin(f.exec, f.repo, { auth: f.auth, log: (m) => f.logs.push(m) });
    expect(git(f.repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(f.second);
    expect(f.server.auths).toContain(BASIC);
  });

  it('never puts the token in a command line, a log line, an error or the repository config', async () => {
    const f = await fixture();
    await fetchOrigin(f.exec, f.repo, { auth: f.auth, log: (m) => f.logs.push(m) });
    // A failed fetch too: its error and its log line name the command, never the token.
    git(f.repo, 'remote', 'set-url', 'origin', `${f.server.base}/acme/gone.git`);
    const err = await fetchOrigin(f.exec, f.repo, { auth: f.auth, log: (m) => f.logs.push(m) }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const said = [...f.lines, ...f.logs, (err as Error).message, String((err as Error).cause), readFileSync(join(f.repo, '.git', 'config'), 'utf8')].join('\n');
    expect(f.lines.some((l) => l.includes(' fetch '))).toBe(true);
    expect(said).not.toContain(TOKEN);
    expect(said).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
  });

  it('never sends the token to an origin off the App\'s forge, whatever the clone\'s origin says', async () => {
    const f = await fixture();
    // The same repository served elsewhere: another host for git, though the env holds the token (ORC-478).
    const elsewhere = await privateServer(join(f.dir, 'srv'));
    git(f.repo, 'remote', 'set-url', 'origin', `${elsewhere.base}/acme/app.git`);
    await expect(fetchOrigin(f.exec, f.repo, { auth: f.auth, log: (m) => f.logs.push(m) })).rejects.toThrow(/the forge could not be read/);
    expect(elsewhere.auths.length).toBeGreaterThan(0);
    expect(elsewhere.auths).not.toContain(BASIC);
  });

  it("leaves the machine's own credentials to a clone that stands for no project, and to a repository the App has no token for", async () => {
    const f = await fixture();
    expect(await f.auth(join(f.dir, 'replayed'))).toEqual({});
    const noToken = new GitHubAppForge({ appId: '1', privateKey: privatePem, installationId: 7, http: tokenApi, webBase: f.server.base, log: (m) => f.logs.push(m) });
    expect(await noToken.fetchEnv('acme/app')).toEqual({});
    expect(f.logs.join('\n')).toMatch(/the machine's git credentials/);
  });
});

/** Each read of the forge the daemon makes, against the private server: what it gives back, given `auth` or not. */
type Fixture = Awaited<ReturnType<typeof fixture>>;
const READS: Record<string, (f: Fixture, auth?: CloneAuth) => Promise<unknown>> = {
  "a launch's fetch (GitWorkspaces)": (f, auth) =>
    new GitWorkspaces({ root: join(f.dir, 'ws'), exec: f.exec, ...(auth ? { auth } : {}) }).prepare({ projectId: 'p', repoPath: f.repo, ticketId: 'T-1', title: 't', kind: 'trunk-readonly', runId: 'r1' }),
  "the repository's config, on its default branch (read before a launch)": (f, auth) => makeRepoConfig({ exec: f.exec, ...(auth ? { auth } : {}) })({ repoPath: f.repo }),
  "verify's and the dry run's clone": async (f, auth) => {
    const clone = mkdtempSync(join(f.dir, 'clone-'));
    git(clone, 'init', '--quiet');
    await fetchFromForge({ originUrl: f.url, exec: f.exec, ...(auth ? { forgeEnv: () => auth(f.repo) } : {}) }, clone, ['+HEAD:refs/factory/base'], 'base branch');
  },
  "the knowledge base's pull, its default branch asked, and its note's push": async (f, auth) => {
    git(f.repo, 'remote', 'set-head', 'origin', '-d');
    const kb = new KnowledgeBase(f.repo, { exec: f.exec, freshMs: 0, auth });
    const pulled = await kb.pull().catch((err: Error) => err.message);
    if (pulled !== undefined) throw new Error(pulled);
    const pushed = await kb.commitNote('notes/preview/app.md', 'start\n', 'notes: app');
    if (pushed !== undefined) throw new Error(pushed);
  },
  "the ghost's clone at the start": async (f, auth) => cloneAtStart({ remote: f.url, mergeSha: f.second, dir: join(f.dir, auth ? 'ghost' : 'ghost-refused'), exec: f.exec, ...(auth ? { env: await auth(f.repo) } : {}) }),
};

describe('when GitHub does not give the token (ORC-442)', () => {
  const answering = (status: number, asked: string[]): HttpClient => async (url) => {
    asked.push(new URL(url).pathname);
    return { ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify({ message: `answer ${status}` }) };
  };
  const forgeOn = (f: Fixture, http: HttpClient, now = () => Date.now()) =>
    new GitHubAppForge({ appId: '1', privateKey: privatePem, installationId: 42, http, webBase: f.server.base, log: (m) => f.logs.push(m), now });

  it('a 5xx fails the read as a transient error, never a read without the token', async () => {
    const f = await fixture();
    const forge = forgeOn(f, answering(502, []));
    const err = await fetchOrigin(f.exec, f.repo, { auth: () => forge.fetchEnv('acme/app') }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/no installation token/);
    expect(isTransient(err)).toBe(true);
    expect(f.lines.some((l) => l.includes(' fetch '))).toBe(false);
  });

  it('a refusal (4xx) falls back to the machine credentials, asked again only after 10 minutes, said once', async () => {
    const f = await fixture();
    const asked: string[] = [];
    let now = Date.parse('2026-11-21T10:00:00Z');
    const forge = forgeOn(f, answering(404, asked), () => now);
    expect(await forge.fetchEnv('acme/app')).toEqual({});
    expect(await forge.fetchEnv('acme/app')).toEqual({});
    expect(asked).toHaveLength(1);
    expect(f.logs.filter((l) => l.includes('no installation token'))).toHaveLength(1);
    now += 10 * 60_000 + 1;
    await forge.fetchEnv('acme/app');
    expect(asked).toHaveLength(2);
  });

  it('a token that does not come within the deadline is a forge silent: a timeout, transient', async () => {
    const f = await fixture();
    const err = await fetchOrigin(f.exec, f.repo, { deadlineMs: 50, auth: () => new Promise(() => {}) }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'ETIMEDOUT' });
    expect(isTransient(err)).toBe(true);
  });
});

describe('every read of the forge by the daemon goes through the App token (ORC-442)', () => {
  for (const [name, read] of Object.entries(READS)) {
    it(`${name}: read with the token, refused without it, the token nowhere`, async () => {
      const f = await fixture();
      await expect(read(f)).rejects.toThrow();
      await read(f, f.auth);
      const said = [...f.lines, ...f.logs, readFileSync(join(f.repo, '.git', 'config'), 'utf8')].join('\n');
      expect(said).not.toContain(TOKEN);
    });
  }
});

/**
 * The guard on the source: the daemon's git gets an extraheader through `GIT_CONFIG_*` alone, in its environment. Never as a
 * `-c` argument (the command line is visible to every process of the host, and quoted in git's errors), never written by
 * `git config` to a repository's config, never in a URL's userinfo built from the token.
 */
describe('no extraheader on a command line nor in a written config (ORC-442)', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
    });
  const sources = files(join(repoRoot(), 'src')).map((p) => ({ path: relative(repoRoot(), p), text: readFileSync(p, 'utf8') }));

  it('names an extraheader only as the key of a GIT_CONFIG_* variable', () => {
    const offenders = sources.flatMap(({ path, text }) =>
      text.split('\n').flatMap((line, i) => (/extraheader/i.test(line) && !/^\s*(\/\/|\*|\/\*\*)/.test(line) && !/GIT_CONFIG_KEY_\d+'?\s*[:,]/.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(offenders).toEqual([]);
  });

  it('builds no URL with an x-access-token userinfo', () => {
    const offenders = sources.flatMap(({ path, text }) => text.split('\n').flatMap((line, i) => (/x-access-token:\$\{[^}]+\}@/.test(line) ? [`${path}:${i + 1}`] : [])));
    expect(offenders).toEqual([]);
  });
});
