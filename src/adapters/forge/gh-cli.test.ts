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
/** A GraphQL connection page: `next` is the cursor of the page after it, `null` on the last one. */
const conn = <N>(nodes: N[], next: string | null = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });
const threadsAnswer = (threads: unknown[], next: string | null = null) => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: conn(threads, next) } } } });
const comment = (login: string, body: string, at: string, path = 'src/a.ts', line: number | null = 12, type = 'User') => ({ author: { __typename: type, login }, body, createdAt: at, path, line });
const thread = { id: 'T', isResolved: false, comments: conn([comment('alice', 'renommer', '2026-10-10T10:00:00Z', 'src/a.ts', 3)]) };

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
      'gh api graphql': { stdout: threadsAnswer([thread]) },
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

  /** A forge whose `gh pr list` finds open PR 7 on branch `b`, and whose `gh pr checks 7` answers `checks`. */
  const answeringChecks = (checks: { stdout: string; stderr?: string; code?: number }) =>
    new GhCliForge(
      fakeExec({
        'gh pr list': { stdout: JSON.stringify([{ number: 7, url: 'https://gh/7', state: 'OPEN', headRefName: 'b' }]) },
        'gh pr checks 7': checks,
      }),
    );

  it.each([
    ['an entry that is not an object', 0, '[null]'],
    ['an entry without a bucket', 0, '[{"name":"ci"}]'],
    ['a null bucket', 0, '[{"name":"ci","bucket":null}]'],
    ['nothing', 0, ''],
    ['an object, not a list', 1, '{"name":"ci","bucket":"pass"}'],
  ])('rejects, naming the command and its output, when gh pr checks lists %s (exit %i)', async (_case, code, stdout) => {
    await expect(answeringChecks({ stdout, code }).findPr('/r', 'b')).rejects.toThrow(
      `gh pr checks 7 --json name,bucket: unreadable output, not a list of checks: ${JSON.stringify(stdout)}`,
    );
  });

  it('cuts a long unreadable output in its error', async () => {
    await expect(answeringChecks({ stdout: `<html>${'x'.repeat(1000)}` }).findPr('/r', 'b')).rejects.toThrow(/: "<html>x{194}"…$/);
  });

  it("keeps gh's stderr in the error even on exit 0, cut like the output", async () => {
    await expect(answeringChecks({ stdout: 'garbage', stderr: 'A new release of gh is available\n' }).findPr('/r', 'b')).rejects.toThrow(
      /: "garbage" \(exit 0: A new release of gh is available\)$/,
    );
    await expect(answeringChecks({ stdout: 'garbage', stderr: 'y'.repeat(1000), code: 1 }).findPr('/r', 'b')).rejects.toThrow(
      /: "garbage" \(exit 1: y{200}…\)$/,
    );
  });

  it('never cuts a character in two in its excerpt', async () => {
    await expect(answeringChecks({ stdout: `${'x'.repeat(199)}😀tail` }).findPr('/r', 'b')).rejects.toThrow(/: "x{199}"…$/);
  });

  it('rejects a PR without checks whose stdout is not empty, as gh never answers it', async () => {
    await expect(
      answeringChecks({ stdout: 'garbage', stderr: "no checks reported on the 'b' branch\n", code: 1 }).findPr('/r', 'b'),
    ).rejects.toThrow(`unreadable output, not a list of checks: "garbage" (exit 1: no checks reported on the 'b' branch)`);
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
          stdout: threadsAnswer([
            { id: 'T1', isResolved: false, comments: conn([comment('lilian', 'Renomme ça', '2026-10-10T10:00:00Z')]) },
            { id: 'T2', isResolved: true, comments: conn([comment('x', 'ok', '2026-10-10T10:00:00Z', 'b', 1)]) },
          ]),
        },
      }),
    );
    expect(await forge.unresolvedReviewComments('/r', 7)).toEqual([
      { author: 'lilian', body: 'src/a.ts:12 — Renomme ça', at: Date.parse('2026-10-10T10:00:00Z'), source: 'review' },
    ]);
  });

  it("reads every thread and every comment of an unresolved thread: a reviewer's reply reaches the agent (ORC-347)", async () => {
    const asked: string[][] = [];
    const forge = new GhCliForge(async (_cmd, args) => {
      if (args[0] === 'repo') return { stdout: JSON.stringify({ owner: { login: 'me' }, name: 'app' }), stderr: '', code: 0 };
      const fields = args.filter((a, i) => args[i - 1] === '-F' || (args[i - 1] === '-f' && !a.startsWith('query=')));
      asked.push(fields);
      const query = args.find((a) => a.startsWith('query='))!;
      let stdout: string;
      if (query.includes('reviewThreads')) {
        stdout = fields.includes('after=threads-1')
          ? threadsAnswer([{ id: 'T2', isResolved: false, comments: conn([comment('carol', 'renomme', '2026-10-10T12:00:00Z', 'src/b.ts', null)]) }])
          : threadsAnswer([{ id: 'T1', isResolved: false, comments: conn([comment('alice', 'gère null', '2026-10-10T10:00:00Z')], 'comments-1') }], 'threads-1');
      } else {
        stdout = JSON.stringify({ data: { node: { comments: conn([comment('alice', 'toujours faux, gère aussi null', '2026-10-10T11:00:00Z')]) } } });
      }
      return { stdout, stderr: '', code: 0 };
    });
    expect(await forge.unresolvedReviewComments('/r', 7)).toEqual([
      { author: 'alice', body: 'src/a.ts:12 — gère null', at: Date.parse('2026-10-10T10:00:00Z'), source: 'review' },
      { author: 'alice', body: 'src/a.ts:12 — toujours faux, gère aussi null', at: Date.parse('2026-10-10T11:00:00Z'), source: 'review' },
      { author: 'carol', body: 'src/b.ts — renomme', at: Date.parse('2026-10-10T12:00:00Z'), source: 'review' },
    ]);
    expect(asked).toEqual([
      ['owner=me', 'name=app', 'number=7'],
      ['owner=me', 'name=app', 'number=7', 'after=threads-1'],
      ['id=T1', 'after=comments-1'],
    ]);
  });

  it("drops a bot's reply and keeps the human one of the same thread, the query asking for the author's type (ORC-366)", async () => {
    let query = '';
    const forge = new GhCliForge(async (_cmd, args) => {
      if (args[0] === 'repo') return { stdout: JSON.stringify({ owner: { login: 'me' }, name: 'app' }), stderr: '', code: 0 };
      query = args.find((a) => a.startsWith('query='))!;
      const comments = [comment('alice', 'gère null', '2026-10-10T10:00:00Z'), comment('ci', 'CI failed', '2026-10-10T10:05:00Z', 'src/a.ts', 12, 'Bot'), comment('bob', 'oui', '2026-10-10T10:10:00Z')];
      return { stdout: threadsAnswer([{ id: 'T1', isResolved: false, comments: conn(comments) }]), stderr: '', code: 0 };
    });
    expect((await forge.unresolvedReviewComments('/r', 7)).map((i) => i.author)).toEqual(['alice', 'bob']);
    expect(query).toContain('author { __typename login }');
  });

  it.each([
    ['threads without their pageInfo', JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })],
    ['no PR', JSON.stringify({ data: { repository: { pullRequest: null } } })],
    ['not JSON', 'oops'],
  ])('rejects review threads answered with %s, never reads them as none (ORC-347)', async (_case, stdout) => {
    const forge = new GhCliForge(fakeExec({ 'gh repo view': { stdout: JSON.stringify({ owner: { login: 'me' }, name: 'app' }) }, 'gh api graphql': { stdout } }));
    const err = await forge.unresolvedReviewComments('/r', 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
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
