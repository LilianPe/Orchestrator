import { describe, expect, it } from 'vitest';
import type { Exec } from '../exec.js';
import { aggregateChecks, GhCliForge } from './gh-cli.js';

function fakeExec(map: Record<string, { stdout: string; code?: number }>): Exec {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const hit = Object.entries(map).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unexpected: ${key}`);
    return { stdout: hit[1].stdout, stderr: '', code: hit[1].code ?? 0 };
  };
}

describe('aggregateChecks', () => {
  it.each([
    [[], 'none'],
    [['pass', 'skipping'], 'pass'],
    [['pass', 'pending'], 'pending'],
    [['pending', 'fail'], 'fail'],
    [['cancel'], 'fail'],
  ])('%j -> %s', (b, r) => expect(aggregateChecks(b as string[])).toBe(r));
});

describe('GhCliForge', () => {
  it('finds an open PR with failing checks even when gh exits non-zero', async () => {
    const forge = new GhCliForge(
      fakeExec({
        'gh pr list': { stdout: JSON.stringify([{ number: 7, url: 'https://gh/7', state: 'OPEN', headRefName: 'relais/rel-1-x' }]) },
        'gh pr checks 7': { stdout: JSON.stringify([{ name: 'test', bucket: 'fail' }, { name: 'lint', bucket: 'pass' }]), code: 1 },
      }),
    );
    expect(await forge.findPr('/r', 'relais/rel-1-x')).toEqual({
      number: 7, url: 'https://gh/7', state: 'OPEN', branch: 'relais/rel-1-x', checks: 'fail', failedChecks: ['test'],
    });
  });

  it('returns undefined without PR and skips checks for merged PRs', async () => {
    expect(await new GhCliForge(fakeExec({ 'gh pr list': { stdout: '[]' } })).findPr('/r', 'b')).toBeUndefined();
    const merged = await new GhCliForge(
      fakeExec({ 'gh pr list': { stdout: JSON.stringify([{ number: 2, url: 'u', state: 'MERGED', headRefName: 'b' }]) } }),
    ).findPr('/r', 'b');
    expect(merged).toMatchObject({ state: 'MERGED', checks: 'none' });
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
