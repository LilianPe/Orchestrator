import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { execFailure, type Exec } from '../adapters/exec.js';
import { GitHubApiError } from '../adapters/forge/github-app.js';
import { LinearApi, type FetchLike } from '../adapters/tracker/linear/api.js';
import { fetchOrigin } from '../adapters/workspace/git-workspaces.js';
import { START_RETRY } from '../core/orchestrator.js';
import { EFFECT_RETRY } from './outbox.js';
import { attemptsFor, backoff, isTransient, retryWindow, TRANSIENT_WINDOW_MS } from './transient.js';
import { PROCESS_RETRY } from './worker.js';

/** A loopback port no one listens on: one the system gave, then freed. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** What `LinearApi.gql` throws for this answer of Linear. */
async function linearThrows(status: number, body: string): Promise<unknown> {
  const fetchImpl: FetchLike = async () => ({ ok: status < 400, status, json: async () => JSON.parse(body) as unknown });
  return new LinearApi(async () => 'token', fetchImpl).gql('query { viewer { id } }').catch((err: unknown) => err);
}

/** What `fetchOrigin` throws when git ends with this stderr. */
async function fetchThrows(stderr: string): Promise<unknown> {
  const exec: Exec = async () => ({ code: 128, stdout: '', stderr });
  return fetchOrigin(exec, '/repo').catch((err: unknown) => err);
}

describe('isTransient (ORC-343)', () => {
  it('tells a network that is not there, as fetch and pg really throw it', async () => {
    // A loopback port just freed: nothing listens, the connection is refused at once, no wait and no network.
    const port = await closedPort();
    const fetched = await fetch(`http://127.0.0.1:${port}/`).catch((err: unknown) => err);
    expect(fetched).toBeInstanceOf(TypeError);
    expect(isTransient(fetched)).toBe(true);
    const client = new pg.Client({ host: '127.0.0.1', port, connectionTimeoutMillis: 2_000 });
    const connected = await client.connect().catch((err: unknown) => err);
    expect((connected as { code?: string }).code).toBe('ECONNREFUSED');
    expect(isTransient(connected)).toBe(true);
    // Drizzle wraps every failed query, the driver's error as its cause.
    expect(isTransient(new DrizzleQueryError('select 1', [], connected as Error))).toBe(true);
  });

  it('tells Postgres down, starting or overloaded from a refusal of the query', () => {
    const pgError = (code: string, message = 'x') => Object.assign(new pg.DatabaseError(message, 0, 'error'), { code });
    for (const code of ['57P01', '57P03', '08006', '53300', '40001', '40P01']) expect(isTransient(new DrizzleQueryError('q', [], pgError(code))), code).toBe(true);
    for (const code of ['23505', '42P01', '22P02']) expect(isTransient(new DrizzleQueryError('q', [], pgError(code))), code).toBe(false);
    for (const message of ['Connection terminated unexpectedly', 'timeout exceeded when trying to connect', 'Client has encountered a connection error and is not queryable']) {
      expect(isTransient(new Error(message)), message).toBe(true);
    }
    // This process closing its own pool: no outage to wait out.
    expect(isTransient(new Error('Cannot use a pool after calling end on the pool'))).toBe(false);
    expect(isTransient(new Error('Client was closed and is not queryable'))).toBe(false);
  });

  it('tells a SQLite database another connection holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transient-'));
    const file = join(dir, 'db.sqlite');
    const a = new DatabaseSync(file);
    const b = new DatabaseSync(file, { timeout: 0 });
    try {
      a.exec('CREATE TABLE t (x)');
      a.exec('BEGIN EXCLUSIVE');
      let busy: unknown;
      try {
        b.exec('INSERT INTO t VALUES (1)');
      } catch (err) {
        busy = err;
      }
      expect(isTransient(busy)).toBe(true);
      a.exec('ROLLBACK');
      let syntax: unknown;
      try {
        b.exec('INSERT INTO nowhere VALUES (1)');
      } catch (err) {
        syntax = err;
      }
      expect(isTransient(syntax)).toBe(false);
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tells GitHub down or rate limited from a refusal', () => {
    expect(isTransient(new GitHubApiError(502, 'GET /repos/o/r: 502'))).toBe(true);
    expect(isTransient(new GitHubApiError(429, 'GET /repos/o/r: 429'))).toBe(true);
    expect(isTransient(new GitHubApiError(403, 'API rate limit exceeded', 'API rate limit exceeded', true))).toBe(true);
    expect(isTransient(new GitHubApiError(403, 'Resource not accessible by integration'))).toBe(false);
    expect(isTransient(new GitHubApiError(404, 'Not Found'))).toBe(false);
    expect(isTransient(new GitHubApiError(422, 'Validation Failed'))).toBe(false);
  });

  it('tells Linear down or rate limited from a refusal, as LinearApi throws it', async () => {
    // A proxy's 502 has an HTML body: the status is all there is.
    const html = await linearThrows(502, '<html>Bad gateway</html>');
    expect(html).toMatchObject({ message: 'HTTP 502', status: 502 });
    expect(isTransient(html)).toBe(true);
    expect(isTransient(await linearThrows(500, JSON.stringify({ errors: [{ message: 'Internal server error' }] })))).toBe(true);
    expect(isTransient(await linearThrows(400, JSON.stringify({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] })))).toBe(true);
    expect(isTransient(await linearThrows(200, JSON.stringify({ errors: [{ message: 'Entity not found: Issue' }] })))).toBe(false);
    expect(isTransient(await linearThrows(401, JSON.stringify({ errors: [{ message: 'Authentication required' }] })))).toBe(false);
  });

  it("tells the forge out of reach from a refused fetch, by git's stderr kept as the cause", async () => {
    const unreachable = await fetchThrows("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com");
    // The message, which reaches the ticket, still names neither the path nor git's words.
    expect(unreachable).toMatchObject({ message: 'the forge could not be read (git fetch, code 128)' });
    expect(isTransient(unreachable)).toBe(true);
    expect(isTransient(await fetchThrows("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 502"))).toBe(true);
    expect(isTransient(await fetchThrows("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403"))).toBe(false);
    expect(isTransient(await fetchThrows('remote: Repository not found.\nfatal: repository not found'))).toBe(false);
    expect(isTransient(execFailure('gh', ['pr', 'checks', '1'], { code: 1, stdout: '', stderr: 'error connecting to api.github.com' }))).toBe(true);
    expect(isTransient(execFailure('gh', ['pr', 'checks', '1'], { code: 1, stdout: '', stderr: 'no pull requests found' }))).toBe(false);
  });

  it('reads through a wrapper, and calls anything else permanent', () => {
    expect(isTransient(new Error('start failed', { cause: new GitHubApiError(503, 'x') }))).toBe(true);
    expect(isTransient(new Error('boom'))).toBe(false);
    // undici's failure says nothing by itself: a certificate refused is not an outage.
    expect(isTransient(new TypeError('fetch failed', { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) }))).toBe(false);
    expect(isTransient(new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }))).toBe(true);
    expect(isTransient(Object.assign(new Error('invalid'), { code: 'UND_ERR_INVALID_ARG' }))).toBe(false);
    expect(isTransient('a string')).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});

describe('the retry policies (ORC-343)', () => {
  it('wait out a 30-minute outage, and give a permanent failure the short window they had', () => {
    const transient = new GitHubApiError(503, 'x');
    for (const [name, policy, short] of [
      ['outbox', EFFECT_RETRY, 127_000],
      ['worker', PROCESS_RETRY, 80_000],
      ['queue', START_RETRY, 30_000],
    ] as const) {
      expect(retryWindow(policy, attemptsFor(policy, transient)), name).toBeGreaterThanOrEqual(TRANSIENT_WINDOW_MS);
      // Not much more: one step of the cap, at most.
      expect(retryWindow(policy, attemptsFor(policy, transient)), name).toBeLessThan(TRANSIENT_WINDOW_MS + policy.capMs!);
      expect(retryWindow(policy, attemptsFor(policy, new Error('boom'))), name).toBe(short);
    }
    expect(backoff(EFFECT_RETRY, 20)).toBe(300_000);
  });
});
