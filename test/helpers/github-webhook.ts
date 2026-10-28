import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGithubIngest, githubMapContext } from '../../src/adapters/forge/github-ingest.js';
import type { Forge } from '../../src/adapters/forge/types.js';
import type { FactoryEvent } from '../../src/core/types.js';
import type { Store } from '../../src/store/types.js';

export const GH_SECRET = 'github-test-secret';
export const BRANCH = 'factory/rel-1-export-csv';
const REPO = { full_name: 'acme/app', html_url: 'https://github.com/acme/app' };

/** A GitHub delivery of `body` as event `name`, signed with `secret`. */
export function githubDelivery(name: string, body: unknown, secret = GH_SECRET): { raw: string; headers: Record<string, string> } {
  const raw = JSON.stringify(body);
  return {
    raw,
    headers: {
      'x-github-event': name,
      'x-github-delivery': `d-${name}`,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
  };
}

/** A `pull_request` body on the ticket's branch. */
export function pullRequestBody(action: string, pr: { number?: number; merged?: boolean; state?: string; mergeable_state?: string; head?: string } = {}) {
  const n = pr.number ?? 3;
  return {
    action,
    repository: REPO,
    sender: { login: 'lilian', type: 'User' },
    pull_request: {
      number: n,
      html_url: `https://github.com/acme/app/pull/${n}`,
      state: pr.state ?? (action === 'closed' ? 'closed' : 'open'),
      updated_at: '2026-10-28T10:00:00Z',
      closed_at: action === 'closed' ? '2026-10-28T10:00:00Z' : null,
      merged: pr.merged ?? false,
      mergeable_state: pr.mergeable_state ?? 'clean',
      head: { ref: BRANCH, sha: pr.head ?? 'head1' },
      base: { ref: 'main', sha: 'base1' },
    },
  };
}

/** A completed `check_run` on the PR's head. */
export function checkRunBody(conclusion: string, opts: { number?: number; head?: string; prHead?: string; name?: string } = {}) {
  const head = opts.head ?? 'head1';
  return {
    action: 'completed',
    repository: REPO,
    sender: { login: 'github-actions[bot]', type: 'Bot' },
    check_run: {
      name: opts.name ?? 'test',
      head_sha: head,
      status: 'completed',
      conclusion,
      pull_requests: [{ number: opts.number ?? 3, head: { ref: BRANCH, sha: opts.prHead ?? head } }],
    },
  };
}

export function pushBody(sender: { login: string; type: string }, after = 'c0ffee', branch = BRANCH) {
  return { ref: `refs/heads/${branch}`, after, deleted: false, repository: REPO, pusher: { name: sender.login }, sender };
}

/** The daemon's GitHub ingestion over `store` and `forge`, project `p` on `/repo`, writing through `accept`. */
export function githubIngest(store: Store, accept: (e: FactoryEvent) => Promise<boolean>, forge?: Forge, now = () => 1_000) {
  return createGithubIngest({
    secret: () => GH_SECRET,
    accept,
    log: () => {},
    ctx: githubMapContext({
      store,
      forge: forge ?? { findPr: async () => undefined },
      projects: [{ id: 'p', repoPath: '/repo' }],
      repoOf: async (repoPath) => (repoPath === '/repo' ? REPO.full_name : undefined),
      now,
    }),
  });
}

/**
 * Runs `crash-after-github-ack.ts` in a child process: the signed delivery of `body` is written to the
 * inbox of `target` (a SQLite file or a Postgres URL) through the GitHub ingestion, then the process is
 * killed with SIGKILL. Returns the status it answered and how it ended.
 */
export function crashAfterGithubAck(
  target: string,
  name: string,
  body: unknown,
): { response: { status: number }; exited: { status: number | null; signal: string | null } } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-gh-crash-'));
  const statusFile = join(dir, 'status.json');
  const deliveryFile = join(dir, 'delivery.json');
  writeFileSync(deliveryFile, JSON.stringify({ name, body }));
  const root = join(import.meta.dirname, '../..');
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(root, 'test/helpers/crash-after-github-ack.ts'), target, statusFile, deliveryFile],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  );
  let response: { status: number };
  try {
    response = JSON.parse(readFileSync(statusFile, 'utf8')) as { status: number };
  } catch {
    throw new Error(`crash-after-github-ack wrote no status (exit ${child.status}, ${child.signal}): ${child.stderr}`);
  }
  return { response, exited: { status: child.status, signal: child.signal } };
}
