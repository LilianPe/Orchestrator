import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KEPT_PR } from '../store/types.js';
import { newTicketState } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import type { RunRecord } from '../store/types.js';
import { GHOST_USAGE, runGhost, type GhostOptions, type HumanPr } from './ghost.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PRS: Record<number, HumanPr> = {
  12: { number: 12, url: 'https://github.test/pr/12', author: 'lilian', mergeSha: 'merge12', commits: ['one', 'two'] },
  34: { number: 34, url: 'https://github.test/pr/34', author: 'lilian', mergeSha: 'merge34', commits: ['only'] },
  56: { number: 56, url: 'https://github.test/pr/56', author: 'lilian', commits: [] },
};
/** When the runs and the kept PRs of the tests are dated: the replay's start, which `now` gives. */
const NOW = 1_710_000_000_000;

function withGhost(o: { sandboxes?: boolean } = {}) {
  const store = new SqliteStore(':memory:');
  const lines: string[] = [];
  const answers: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'ghost-cli-'));
  dirs.push(dir);
  let ids = 0;
  const environments: { ticketId: string; prCommits: readonly string[] }[] = [];
  const base: Omit<GhostOptions, 'args'> = {
    store,
    print: (l) => void lines.push(l),
    now: () => NOW,
    user: 'armand',
    newId: () => `g${++ids}`,
    dir,
    projects: [{ id: 'ghost', repoPath: '/repo', fantome: true }, { id: 'live', repoPath: '/repo', fantome: false }],
    // What the daemon last said of its runs (ORC-376): with sandboxes, unless a test says otherwise.
    sandboxes: async () => ('sandboxes' in o ? o.sandboxes : true),
    humanPr: async (_repo, n) => PRS[n] ?? Promise.reject(new Error(`no PR #${n}`)),
    humanDiff: async (_repo, n) => `diff --git a/x${n}`,
    environment: async ({ ticketId, mergeSha, prCommits, memory }) => {
      environments.push({ ticketId, prCommits });
      if (ticketId === 'REL-3') throw new Error('fetch refused');
      return { start: `parent-of-${mergeSha}`, ...(memory ? { knowledge: 'kb1' } : {}) };
    },
    ask: async () => answers.shift() ?? '',
  };
  const ghost = (args: string[]) => runGhost({ ...base, args });
  return { store, lines, answers, ghost, dir, environments };
}

describe('factory ghost start (ORC-231)', () => {
  it('criterion 4: refuses a replay without its threshold, written before it starts', async () => {
    const { store, lines, ghost } = withGhost();
    expect(await ghost(['start', 'ghost', '--tickets', 'REL-1=12'])).toBe(1);
    expect(lines.join('\n')).toContain('--threshold');
    expect(await store.ghostReplays()).toEqual([]);
    expect(await ghost(['start', 'ghost', '--threshold', 'high', '--as-is', '0.3', '--tickets', 'REL-1=12'])).toBe(1);
    expect(await store.ghostReplays()).toEqual([]);
  });

  it('ORC-385 criterion 1: refuses a replay without its as-is threshold, or with one above the mergeable threshold', async () => {
    const { store, lines, ghost, environments } = withGhost();
    expect(await ghost(['start', 'ghost', '--threshold', '0.6', '--tickets', 'REL-1=12'])).toBe(1);
    expect(lines.at(-1)).toContain('--as-is is required');
    expect(await ghost(['start', 'ghost', '--threshold', '0.6', '--as-is', 'some', '--tickets', 'REL-1=12'])).toBe(1);
    expect(lines.at(-1)).toContain('« some »');
    // The PRs mergeable as is are some of the mergeable ones: an as-is share above the mergeable one is a mistake, refused.
    expect(await ghost(['start', 'ghost', '--threshold', '0.3', '--as-is', '0.6', '--tickets', 'REL-1=12'])).toBe(1);
    expect(lines.at(-1)).toContain('above');
    expect(await store.ghostReplays()).toEqual([]);
    expect(environments).toEqual([]);
  });

  it('writes the replay with its threshold, then the environment of each ticket at the parent of its merge commit', async () => {
    const { store, lines, ghost, environments } = withGhost();
    expect(await ghost(['start', 'ghost', '--threshold', '60%', '--as-is', '30%', '--tickets', 'REL-1=12,REL-2=34'])).toBe(0);
    expect(await store.ghostReplay('g1')).toMatchObject({ projectId: 'ghost', threshold: 0.6, asIsThreshold: 0.3, memory: true, tickets: ['REL-1', 'REL-2'], startedAt: NOW, startedBy: 'armand' });
    expect(await store.ghostTickets('g1')).toEqual([
      expect.objectContaining({ ticketId: 'REL-1', mergeSha: 'merge12', start: 'parent-of-merge12', knowledge: 'kb1', env: 'unchecked', outcome: 'pending', humanPr: { number: 12, url: 'https://github.test/pr/12', author: 'lilian' } }),
      expect.objectContaining({ ticketId: 'REL-2', start: 'parent-of-merge34' }),
    ]);
    // The PR's commits go with it: a rebase merge starts before the first of them.
    expect(environments).toEqual([{ ticketId: 'REL-1', prCommits: ['one', 'two'] }, { ticketId: 'REL-2', prCommits: ['only'] }]);
    expect(lines.join('\n')).toContain('threshold 60% mergeable, of which 30% as is');
    expect(lines.join('\n')).toContain('ORC-208');
  });

  it('criterion 4, ORC-385 criterion 3: neither threshold of a started replay can change, not even by starting it again', async () => {
    const { store, ghost } = withGhost();
    await ghost(['start', 'ghost', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=12', '--id', 'pilot']);
    expect(await ghost(['start', 'ghost', '--threshold', '0.1', '--as-is', '0.3', '--tickets', 'REL-1=12', '--id', 'pilot'])).toBe(1);
    expect(await ghost(['start', 'ghost', '--threshold', '0.6', '--as-is', '0.1', '--tickets', 'REL-1=12', '--id', 'pilot'])).toBe(1);
    expect(await store.ghostReplay('pilot')).toMatchObject({ threshold: 0.6, asIsThreshold: 0.3 });
  });

  it('a replay runs on a project on the factory/fantome preset only, and on merged PRs only', async () => {
    const { store, lines, ghost } = withGhost();
    expect(await ghost(['start', 'live', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=12'])).toBe(1);
    expect(lines.at(-1)).toContain('factory/fantome');
    expect(await ghost(['start', 'ghost', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=56'])).toBe(1);
    expect(lines.at(-1)).toContain('#56 is not merged');
    expect(await store.ghostReplays()).toEqual([]);
  });

  it('ORC-376 criterion 2: a daemon without sandboxes, the replay is refused with the reason, before anything is written', async () => {
    const host = withGhost({ sandboxes: false });
    expect(await host.ghost(['start', 'ghost', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=12'])).toBe(1);
    expect(host.lines.at(-1)).toMatch(/no sandboxes.*could push by itself/);
    expect(await host.store.ghostReplays()).toEqual([]);
    expect(host.environments).toEqual([]);
    // No daemon has said yet: refused too, not run on a guess.
    const unknown = withGhost({ sandboxes: undefined });
    expect(await unknown.ghost(['start', 'ghost', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=12'])).toBe(1);
    expect(unknown.lines.at(-1)).toContain('sandboxes');
    expect(await unknown.store.ghostReplays()).toEqual([]);
  });

  it('ORC-376: a ticket replays once per project: another replay of it there is refused, before anything is written', async () => {
    const { store, lines, ghost } = withGhost();
    expect(await ghost(['start', 'ghost', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=12'])).toBe(0);
    expect(await ghost(['start', 'ghost', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-2=34,REL-1=12'])).toBe(1);
    expect(lines.at(-1)).toContain('REL-1: ghost replayed it already (g1)');
    expect((await store.ghostReplays()).map((r) => r.id)).toEqual(['g1']);
  });

  it('ORC-376: says that the daemon delegates each ticket rebuilt to the project', async () => {
    const { lines, ghost } = withGhost();
    expect(await ghost(['start', 'ghost', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=12'])).toBe(0);
    expect(lines.join('\n')).toContain('The daemon delegates each ticket rebuilt to ghost');
  });

  it('an environment that cannot be rebuilt: the ticket is counted apart, with why', async () => {
    const { store, ghost } = withGhost();
    expect(await ghost(['start', 'ghost', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-3=12'])).toBe(0);
    expect(await store.ghostTickets('g1')).toEqual([expect.objectContaining({ ticketId: 'REL-3', env: 'failed', envReason: 'fetch refused' })]);
  });

  it('memory off: no knowledge base given', async () => {
    const { store, ghost } = withGhost();
    await ghost(['start', 'ghost', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=12', '--memory', 'off']);
    expect(await store.ghostReplay('g1')).toMatchObject({ memory: false });
    expect((await store.ghostTickets('g1'))[0]).not.toHaveProperty('knowledge');
  });
});

describe('factory ghost collect, judge and report (ORC-231)', () => {
  /** A replay of REL-1 and REL-2, both run on the ghost project: each with a run's cost, its spec's assumptions and its kept PR. */
  async function replayed() {
    const g = withGhost();
    await g.ghost(['start', 'ghost', '--threshold', '0.5', '--as-is', '0.25', '--tickets', 'REL-1=12,REL-2=34']);
    for (const id of ['REL-1', 'REL-2']) {
      const spec = { job: 'spec', version: 1, at: 0, spec: { assumed: ['a', 'Unasked: b'] } };
      await g.store.putTicket({ ...newTicketState('ghost', id, 'Export CSV', 'dev', 0), spec });
      await g.store.putRun({ id: `run-${id}`, projectId: 'ghost', ticketId: id, job: 'dev', queue: 'dev', status: 'success', claudeSessionId: 's', startedAt: NOW, costUsd: 0.75, turns: 3, lastText: '', token: 't', cwd: '/w' } as RunRecord);
      const path = join(g.dir, `${id}.json`);
      writeFileSync(path, JSON.stringify({ kind: 'publish', pr: { title: `${id} Export CSV`, body: 'factory body', branch: `factory/${id.toLowerCase()}`, sha: 'abc', diff: `diff --git a/y-${id}` } }));
      await g.store.putArtifact({ id: `kept:${id}`, ticketId: id, attemptId: `run-${id}`, kind: KEPT_PR, path, sha256: 'x', createdAt: NOW });
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

  it('collects within the replay: a run or a kept PR from before it is not its own; a ticket not run yet stays pending', async () => {
    const g = withGhost();
    await g.store.putRun({ id: 'old', projectId: 'ghost', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'success', claudeSessionId: 's', startedAt: NOW - 1, costUsd: 9, turns: 1, lastText: '', token: 't', cwd: '/w' } as RunRecord);
    await g.store.putArtifact({ id: 'kept:old', ticketId: 'REL-1', kind: KEPT_PR, path: '/nowhere', sha256: 'x', createdAt: NOW - 1 });
    await g.ghost(['start', 'ghost', '--threshold', '0.5', '--as-is', '0.25', '--tickets', 'REL-1=12']);
    await g.ghost(['collect', 'g1']);
    expect(await g.store.ghostTickets('g1')).toEqual([expect.objectContaining({ ticketId: 'REL-1', outcome: 'pending', costUsd: 0 })]);
    expect((await g.store.ghostTickets('g1'))[0]).not.toHaveProperty('factoryPr');
  });

  it('a PR already graded stays the one graded when collected again', async () => {
    const { store, answers, ghost, dir } = await replayed();
    answers.push('1', '1', '1', '1');
    await ghost(['judge', 'g1', '--judge', 'armand']);
    const path = join(dir, 'newer.json');
    writeFileSync(path, '{}');
    await store.putArtifact({ id: 'kept:newer', ticketId: 'REL-1', kind: KEPT_PR, path, sha256: 'y', createdAt: NOW + 1 });
    await ghost(['collect', 'g1']);
    expect((await store.ghostTickets('g1'))[0]).toMatchObject({ ticketId: 'REL-1', factoryPr: 'kept:REL-1' });
  });

  it('a judge names their GitHub login: without it, nothing is shown', async () => {
    const { lines, ghost } = await replayed();
    lines.length = 0;
    expect(await ghost(['judge', 'g1'])).toBe(1);
    expect(lines.join('\n')).toContain('--judge');
    expect(lines.join('\n')).not.toContain('PR A');
  });

  it('criterion 5: the judge sees each pair blind, as PR A and PR B, and grades both on the fixed grid', async () => {
    const { store, lines, answers, ghost } = await replayed();
    lines.length = 0;
    answers.push('1', '3', '2', '2');
    expect(await ghost(['judge', 'g1', '--judge', 'armand'])).toBe(0);
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
    expect(await ghost(['judge', 'g1', '--judge', 'armand'])).toBe(0);
    expect(lines.join('\n')).toContain('Nothing left to judge');
  });

  it('an answer off the grid is asked again', async () => {
    const { store, answers, ghost } = await replayed();
    answers.push('5', 'yes', '1', '1', '1', '1');
    await ghost(['judge', 'g1', '--judge', 'armand']);
    expect((await store.ghostJudgments('g1')).map((j) => j.grade)).toEqual(['as_is', 'as_is', 'as_is', 'as_is']);
  });

  it('reports ticket by ticket, with the cost and the verdict against the threshold', async () => {
    const { lines, answers, ghost } = await replayed();
    answers.push('1', '1', '1', '1');
    await ghost(['judge', 'g1', '--judge', 'armand']);
    lines.length = 0;
    expect(await ghost(['report', 'g1'])).toBe(0);
    const report = lines.join('\n');
    expect(report).toContain('REL-1');
    expect(report).toContain('threshold 50% mergeable, of which 25% as is');
    // Both shares, each against its threshold.
    expect(report).toContain('Mergeable factory PRs: 2 of 2 compared (100%), threshold 50%.');
    expect(report).toContain('Mergeable as is: 2 of 2 compared (100%), threshold 25%.');
    expect(report).toContain('Total cost: $1.50');
    expect(report).toContain('Verdict: met');
    expect(report).toContain('Environment failures (out of the comparison): none');
  });

  it('ORC-385: a replay recorded with one threshold is still listed and reported, its as-is threshold not set', async () => {
    const { store, lines, ghost } = withGhost();
    await store.putGhostReplay({ id: 'old', projectId: 'ghost', threshold: 0.6, memory: true, seed: 's', tickets: [], startedAt: NOW, startedBy: 'armand' });
    expect(await ghost(['list'])).toBe(0);
    expect(lines.at(-1)).toContain('threshold 60% mergeable, as is not set');
    lines.length = 0;
    expect(await ghost(['report', 'old'])).toBe(0);
    const report = lines.join('\n');
    expect(report).toContain('threshold 60% mergeable, as is not set');
    expect(report).toContain('Mergeable as is: 0 of 0 compared (0%), threshold not set.');
  });

  it('prints its usage for an unknown command', async () => {
    const { lines, ghost } = withGhost();
    expect(await ghost(['nope'])).toBe(1);
    expect(lines).toEqual([GHOST_USAGE]);
  });
});
