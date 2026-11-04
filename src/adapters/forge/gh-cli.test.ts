import { describe, expect, it } from 'vitest';
import { describeForgeContract } from '../../../test/contracts/forge.contract.js';
import type { Exec } from '../exec.js';
import { aggregateChecks, GhCliForge } from './gh-cli.js';

function fakeExec(map: Record<string, { stdout: string; stderr?: string; code?: number }>): Exec {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const hit = Object.entries(map).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unexpected: ${key}`);
    return { stdout: hit[1].stdout, stderr: hit[1].stderr ?? '', code: hit[1].code ?? 0 };
  };
}

const pr = (number: number, branch: string) => JSON.stringify([{ number, url: `https://github.test/pr/${number}`, state: 'OPEN', headRefName: branch }]);
const thread = { isResolved: false, comments: { nodes: [{ author: { login: 'alice' }, body: 'renommer', createdAt: '2026-10-10T10:00:00Z', path: 'src/a.ts', line: 3 }] } };

describeForgeContract('GhCliForge (scripted gh)', () => ({
  forge: new GhCliForge(
    fakeExec({
      'gh pr list --head factory/rel-404 ': { stdout: '[]' },
      'gh pr list --head factory/rel-1-x ': { stdout: pr(7, 'factory/rel-1-x') },
      'gh pr checks 7 ': { stdout: JSON.stringify([{ name: 'test', bucket: 'fail' }, { name: 'lint', bucket: 'pass' }]), code: 1 },
      'gh pr list --head factory/rel-2-y ': { stdout: pr(8, 'factory/rel-2-y') },
      'gh pr checks 8 ': { stdout: 'not json' },
      // What gh 2.63 and 2.103 answer: exit 1, nothing on stdout, for a PR without checks as for a failure.
      'gh pr list --head factory/rel-3-z ': { stdout: pr(9, 'factory/rel-3-z') },
      'gh pr checks 9 ': { stdout: '', stderr: "no checks reported on the 'factory/rel-3-z' branch\n", code: 1 },
      'gh pr list --head factory/rel-4-w ': { stdout: pr(10, 'factory/rel-4-w') },
      'gh pr checks 10 ': { stdout: '', stderr: 'Post "https://api.github.com/graphql": dial tcp: connection refused\n', code: 1 },
      'gh pr list --head factory/rel-5-v ': { stdout: pr(11, 'factory/rel-5-v') },
      'gh pr checks 11 ': { stdout: JSON.stringify([{ name: 'lint', bucket: 'pass' }, { name: 'deploy', bucket: 'mystery' }, { name: 'docs', bucket: '' }]) },
      'gh repo view': { stdout: JSON.stringify({ owner: { login: 'me' }, name: 'app' }) },
      'gh api graphql': { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [thread] } } } } }) },
    }),
  ),
  repoPath: '/repo',
  missingBranch: 'factory/rel-404',
  pr: { branch: 'factory/rel-1-x', number: 7 },
  unresolved: [{ author: 'alice', body: 'src/a.ts:3 — renommer', at: Date.parse('2026-10-10T10:00:00Z'), source: 'review' }],
  unreachable: new GhCliForge(async () => ({ stdout: '', stderr: 'error connecting to api.github.com', code: 1 })),
  unreadableChecks: 'factory/rel-2-y',
  noChecks: 'factory/rel-3-z',
  checksDown: 'factory/rel-4-w',
  unknownBucket: 'factory/rel-5-v',
}));

describe('aggregateChecks', () => {
  it.each([
    [[], 'none'],
    [['pass', 'skipping'], 'pass'],
    [['pass', 'pending'], 'pending'],
    [['pending', 'fail'], 'fail'],
    [['cancel'], 'fail'],
    [['skipping'], 'pass'],
    [['pass', 'mystery'], 'pending'],
    [['pass', ''], 'pending'],
    [['skipping', 'mystery'], 'pending'],
    [['mystery', 'fail'], 'fail'],
  ])('%j -> %s', (b, r) => expect(aggregateChecks(b as string[])).toBe(r));
});

describe('GhCliForge', () => {
  it('finds an open PR with failing checks even when gh exits non-zero', async () => {
    const forge = new GhCliForge(
      fakeExec({
        'gh pr list': { stdout: JSON.stringify([{ number: 7, url: 'https://gh/7', state: 'OPEN', headRefName: 'factory/rel-1-x' }]) },
        'gh pr checks 7': { stdout: JSON.stringify([{ name: 'test', bucket: 'fail' }, { name: 'lint', bucket: 'pass' }]), code: 1 },
      }),
    );
    expect(await forge.findPr('/r', 'factory/rel-1-x')).toEqual({
      number: 7, url: 'https://gh/7', state: 'OPEN', branch: 'factory/rel-1-x', checks: 'fail', failedChecks: ['test'],
    });
  });

  it.each([
    ['an entry that is not an object', '[null]'],
    ['an entry without a bucket', '[{"name":"ci"}]'],
  ])('reads checks listing %s as none, not as green', async (_case, stdout) => {
    const forge = new GhCliForge(
      fakeExec({
        'gh pr list': { stdout: JSON.stringify([{ number: 7, url: 'https://gh/7', state: 'OPEN', headRefName: 'b' }]) },
        'gh pr checks 7': { stdout },
      }),
    );
    expect(await forge.findPr('/r', 'b')).toMatchObject({ checks: 'none', failedChecks: [] });
  });

  it("rejects with gh pr checks' own failure when gh answers the PR but not its checks", async () => {
    const forge = new GhCliForge(
      fakeExec({
        'gh pr list': { stdout: JSON.stringify([{ number: 10, url: 'https://gh/10', state: 'OPEN', headRefName: 'b' }]) },
        'gh pr checks 10': { stdout: '', stderr: 'Post "https://api.github.com/graphql": dial tcp: connection refused\n', code: 1 },
      }),
    );
    await expect(forge.findPr('/r', 'b')).rejects.toThrow(
      'gh pr checks 10 --json name,bucket: Post "https://api.github.com/graphql": dial tcp: connection refused',
    );
  });

  it('names the gh version required when gh has no --json on pr checks', async () => {
    const forge = new GhCliForge(
      fakeExec({
        'gh pr list': { stdout: JSON.stringify([{ number: 7, url: 'https://gh/7', state: 'OPEN', headRefName: 'b' }]) },
        // What gh 2.45 answers.
        'gh pr checks 7': { stdout: '', stderr: 'unknown flag: --json\n\nUsage:  gh pr checks [<number> | <url> | <branch>] [flags]\n', code: 1 },
      }),
    );
    await expect(forge.findPr('/r', 'b')).rejects.toThrow(/^gh pr checks 7 --json name,bucket: this gh has no --json on pr checks, gh 2\.50 or later is required$/);
  });

  it('returns undefined without PR and skips checks for merged PRs', async () => {
    expect(await new GhCliForge(fakeExec({ 'gh pr list': { stdout: '[]' } })).findPr('/r', 'b')).toBeUndefined();
    const merged = await new GhCliForge(
      fakeExec({ 'gh pr list': { stdout: JSON.stringify([{ number: 2, url: 'u', state: 'MERGED', headRefName: 'b', mergeCommit: { oid: 'm2' }, mergedAt: '2026-10-22T09:00:00Z' }]) } }),
    ).findPr('/r', 'b');
    expect(merged).toMatchObject({ state: 'MERGED', checks: 'none', mergeSha: 'm2', mergedAt: Date.parse('2026-10-22T09:00:00Z') });
  });

  it('lists unresolved review threads as feedback', async () => {
    const forge = new GhCliForge(
      fakeExec({
        'gh repo view': { stdout: JSON.stringify({ owner: { login: 'me' }, name: 'app' }) },
        'gh api graphql': {
          stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
            { isResolved: false, comments: { nodes: [{ author: { login: 'lilian' }, body: 'Renomme ça', createdAt: '2026-10-10T10:00:00Z', path: 'src/a.ts', line: 12 }] } },
            { isResolved: true, comments: { nodes: [{ author: { login: 'x' }, body: 'ok', createdAt: '2026-10-10T10:00:00Z', path: 'b', line: 1 }] } },
          ] } } } } }),
        },
      }),
    );
    expect(await forge.unresolvedReviewComments('/r', 7)).toEqual([
      { author: 'lilian', body: 'src/a.ts:12 — Renomme ça', at: Date.parse('2026-10-10T10:00:00Z'), source: 'review' },
    ]);
  });
});

describe('GhCliForge.repoPermission (ORC-186)', () => {
  it("reads a user's role on the repo through gh api, and throws on any failure, a 404 included", async () => {
    const forge = new GhCliForge(async (_cmd, args) => {
      const path = args[1]!;
      if (path.includes('/dev/')) return { stdout: JSON.stringify({ permission: 'admin', role_name: 'admin' }), stderr: '', code: 0 };
      if (path.includes('/ghost/')) return { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 };
      return { stdout: '', stderr: 'error connecting to api.github.com', code: 1 };
    });
    expect(await forge.repoPermission('/repo', 'dev')).toBe('admin');
    await expect(forge.repoPermission('/repo', 'ghost')).rejects.toThrow(/HTTP 404/);
    await expect(forge.repoPermission('/repo', 'down')).rejects.toThrow(/error connecting/);
  });
});
