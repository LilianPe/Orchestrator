import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KEPT_PR } from '../ghost/replay.js';
import { newTicketState } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import type { RunRecord } from '../store/types.js';
import { GHOST_USAGE, runGhost, type GhostOptions, type HumanPr } from './ghost.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PRS: Record<number, HumanPr> = {
  12: { number: 12, url: 'https://github.test/pr/12', author: 'lilian', mergeSha: 'merge12', diff: 'diff --git a/x12' },
  34: { number: 34, url: 'https://github.test/pr/34', author: 'lilian', mergeSha: 'merge34', diff: 'diff --git a/x34' },
  56: { number: 56, url: 'https://github.test/pr/56', author: 'lilian', diff: '' },
};

function withGhost() {
  const store = new SqliteStore(':memory:');
  const lines: string[] = [];
  const answers: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'ghost-cli-'));
  dirs.push(dir);
  let ids = 0;
  const base: Omit<GhostOptions, 'args'> = {
    store,
    print: (l) => void lines.push(l),
    now: () => 1_710_000_000_000,
    user: 'armand',
    newId: () => `g${++ids}`,
    dir,
    projects: [{ id: 'ghost', repoPath: '/repo', noEffect: true }, { id: 'live', repoPath: '/repo', noEffect: false }],
    humanPr: async (_repo, n) => PRS[n] ?? Promise.reject(new Error(`no PR #${n}`)),
    environment: async ({ ticketId, mergeSha, memory }) => (ticketId === 'REL-3' ? Promise.reject(new Error('fetch refused')) : { start: `parent-of-${mergeSha}`, ...(memory ? { knowledge: 'kb1' } : {}) }),
    ask: async () => answers.shift() ?? '',
  };
  const ghost = (args: string[]) => runGhost({ ...base, args });
  return { store, lines, answers, ghost, dir };
}

describe('factory ghost start (ORC-231)', () => {
  it('criterion 4: refuses a replay without its threshold, written before it starts', async () => {
    const { store, lines, ghost } = withGhost();
    expect(await ghost(['start', 'ghost', '--tickets', 'REL-1=12'])).toBe(1);
    expect(lines.join('\n')).toContain('--threshold');
    expect(await store.ghostReplays()).toEqual([]);
    expect(await ghost(['start', 'ghost', '--threshold', 'high', '--tickets', 'REL-1=12'])).toBe(1);
    expect(await store.ghostReplays()).toEqual([]);
  });

  it('writes the replay with its threshold, then the environment of each ticket at the parent of its merge commit', async () => {
    const { store, lines, ghost } = withGhost();
    expect(await ghost(['start', 'ghost', '--threshold', '60%', '--tickets', 'REL-1=12,REL-2=34'])).toBe(0);
    expect(await store.ghostReplay('g1')).toMatchObject({ projectId: 'ghost', threshold: 0.6, memory: true, tickets: ['REL-1', 'REL-2'], startedAt: 1_710_000_000_000, startedBy: 'armand' });
    expect(await store.ghostTickets('g1')).toEqual([
      expect.objectContaining({ ticketId: 'REL-1', mergeSha: 'merge12', start: 'parent-of-merge12', knowledge: 'kb1', env: 'unchecked', outcome: 'no_pr', humanPr: { number: 12, url: 'https://github.test/pr/12', author: 'lilian' } }),
      expect.objectContaining({ ticketId: 'REL-2', start: 'parent-of-merge34' }),
    ]);
    expect(lines.join('\n')).toContain('threshold 60%');
    expect(lines.join('\n')).toContain('ORC-208');
  });

  it('criterion 4: the threshold of a started replay cannot change, not even by starting it again', async () => {
    const { store, ghost } = withGhost();
    await ghost(['start', 'ghost', '--threshold', '0.6', '--tickets', 'REL-1=12', '--id', 'pilot']);
    expect(await ghost(['start', 'ghost', '--threshold', '0.1', '--tickets', 'REL-1=12', '--id', 'pilot'])).toBe(1);
    expect((await store.ghostReplay('pilot'))!.threshold).toBe(0.6);
  });

  it('a replay runs on a project without effects only, and on merged PRs only', async () => {
    const { store, lines, ghost } = withGhost();
    expect(await ghost(['start', 'live', '--threshold', '0.6', '--tickets', 'REL-1=12'])).toBe(1);
    expect(lines.at(-1)).toContain('effects');
    expect(await ghost(['start', 'ghost', '--threshold', '0.6', '--tickets', 'REL-1=56'])).toBe(1);
    expect(lines.at(-1)).toContain('#56 is not merged');
    expect(await store.ghostReplays()).toEqual([]);
  });

  it('an environment that cannot be rebuilt: the ticket is counted apart, with why', async () => {
    const { store, ghost } = withGhost();
    expect(await ghost(['start', 'ghost', '--threshold', '0.6', '--tickets', 'REL-3=12'])).toBe(0);
    expect(await store.ghostTickets('g1')).toEqual([expect.objectContaining({ ticketId: 'REL-3', env: 'failed', envReason: 'fetch refused' })]);
  });

  it('memory off: no knowledge base given', async () => {
    const { store, ghost } = withGhost();
    await ghost(['start', 'ghost', '--threshold', '0.6', '--tickets', 'REL-1=12', '--memory', 'off']);
    expect(await store.ghostReplay('g1')).toMatchObject({ memory: false });
    expect((await store.ghostTickets('g1'))[0]).not.toHaveProperty('knowledge');
  });
});

describe('factory ghost collect, judge and report (ORC-231)', () => {
  /** A replay of REL-1 and REL-2, both run on the ghost project: each with a run's cost, its spec's assumptions and its kept PR. */
  async function replayed() {
    const g = withGhost();
    await g.ghost(['start', 'ghost', '--threshold', '0.5', '--tickets', 'REL-1=12,REL-2=34']);
    for (const id of ['REL-1', 'REL-2']) {
      const spec = { job: 'spec', version: 1, at: 0, spec: { assumed: ['a', 'Unasked: b'] } };
      await g.store.putTicket({ ...newTicketState('ghost', id, 'Export CSV', 'dev', 0), spec });
      await g.store.putRun({ id: `run-${id}`, projectId: 'ghost', ticketId: id, job: 'dev', queue: 'dev', status: 'success', claudeSessionId: 's', startedAt: 0, costUsd: 0.75, turns: 3, lastText: '', token: 't', cwd: '/w' } as RunRecord);
      const path = join(g.dir, `${id}.json`);
      writeFileSync(path, JSON.stringify({ kind: 'publish', pr: { title: `${id} Export CSV`, body: 'factory body', branch: `factory/${id.toLowerCase()}`, sha: 'abc', diff: `diff --git a/y-${id}` } }));
      await g.store.putArtifact({ id: `kept:${id}`, ticketId: id, attemptId: `run-${id}`, kind: KEPT_PR, path, sha256: 'x', createdAt: 1 });
    }
    expect(await g.ghost(['collect', 'g1'])).toBe(0);
    return g;
  }

  it('collects what each ticket ran to: its kept PR, its cost and the assumptions written in its spec', async () => {
    const { store } = await replayed();
    expect(await store.ghostTickets('g1')).toEqual([
      expect.objectContaining({ ticketId: 'REL-1', outcome: 'pr', factoryPr: 'kept:REL-1', costUsd: 0.75, assumptions: 2 }),
      expect.objectContaining({ ticketId: 'REL-2', outcome: 'pr', factoryPr: 'kept:REL-2', costUsd: 0.75, assumptions: 2 }),
    ]);
  });

  it('criterion 5: the judge sees each pair blind, as PR A and PR B, and grades both on the fixed grid', async () => {
    const { store, lines, answers, ghost } = await replayed();
    lines.length = 0;
    answers.push('1', '3', '2', '2');
    expect(await ghost(['judge', 'g1'])).toBe(0);
    const screen = lines.join('\n');
    expect(screen).toContain('PR A');
    expect(screen).toContain('PR B');
    expect(screen).toContain('1 mergeable as is · 2 mergeable after edits · 3 to reject');
    // Nothing tells the factory's from the human's: no side, no branch, no description, no author.
    for (const tell of ['factory', 'human', 'lilian', 'factory body']) expect(screen.toLowerCase()).not.toContain(tell);
    expect(screen).toContain('diff --git a/');
    const judgments = await store.ghostJudgments('g1');
    expect(judgments).toHaveLength(4);
    expect(new Set(judgments.map((j) => `${j.ticketId}:${j.side}`))).toEqual(new Set(['REL-1:factory', 'REL-1:human', 'REL-2:factory', 'REL-2:human']));
    // Graded again: nothing left to judge.
    lines.length = 0;
    expect(await ghost(['judge', 'g1'])).toBe(0);
    expect(lines.join('\n')).toContain('Nothing left to judge');
  });

  it('an answer off the grid is asked again', async () => {
    const { store, answers, ghost } = await replayed();
    answers.push('5', 'yes', '1', '1', '1', '1');
    await ghost(['judge', 'g1']);
    expect((await store.ghostJudgments('g1')).map((j) => j.grade)).toEqual(['as_is', 'as_is', 'as_is', 'as_is']);
  });

  it('reports ticket by ticket, with the cost and the verdict against the threshold', async () => {
    const { lines, answers, ghost } = await replayed();
    answers.push('1', '1', '1', '1');
    await ghost(['judge', 'g1']);
    lines.length = 0;
    expect(await ghost(['report', 'g1'])).toBe(0);
    const report = lines.join('\n');
    expect(report).toContain('REL-1');
    expect(report).toContain('threshold 50%');
    expect(report).toContain('Total cost: $1.50');
    expect(report).toContain('Verdict: met');
    expect(report).toContain('Environment failures (out of the comparison): none');
  });

  it('prints its usage for an unknown command', async () => {
    const { lines, ghost } = withGhost();
    expect(await ghost(['nope'])).toBe(1);
    expect(lines).toEqual([GHOST_USAGE]);
  });
});
