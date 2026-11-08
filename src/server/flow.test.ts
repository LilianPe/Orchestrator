import { describe, expect, it } from 'vitest';
import { newTicketState, type TicketState } from '../core/types.js';
import type { QueueItem, RunRecord } from '../store/types.js';
import { buildFlow, type FlowInput } from './flow.js';

const NOW = 100 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const ticket = (ticketId: string, patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState('p', ticketId, `Titre ${ticketId}`, 'dev', NOW), ...patch });
const run = (id: string, ticketId: string, patch: Partial<RunRecord> = {}): RunRecord => ({
  id, projectId: 'p', ticketId, job: 'dev', queue: 'dev', status: 'running', claudeSessionId: 'c', startedAt: NOW - 5000, costUsd: 0, turns: 0, lastText: '', token: 'SECRET-RUN-TOKEN', cwd: '/w', ...patch,
});
const queued = (ticketId: string, patch: Partial<QueueItem> = {}): QueueItem => ({ projectId: 'p', ticketId, job: 'dev', queue: 'dev', priority: 0, enqueuedAt: 1, ...patch });
const flow = (input: Partial<FlowInput>) => buildFlow({ now: NOW, tickets: [], running: [], verifying: [], queue: [], measures: new Map(), ...input });

describe('buildFlow (ORC-297)', () => {
  describe('Needs you', () => {
    it('groups the blocked tickets by cause, oldest wait first, each with its reason', () => {
      const f = flow({
        tickets: [
          ticket('A', { blocked: true, blockKind: 'asked', blockReason: 'Question asked by the agent', updatedAt: 30 }),
          ticket('B', { blocked: true, blockKind: 'limit', blockReason: 'The run dev reached a limit (turns, duration or budget).', updatedAt: 20 }),
          ticket('C', { blocked: true, blockKind: 'question', blockReason: "Waiting for an answer to the agent's question.", updatedAt: 10 }),
          ticket('D', { blocked: false }),
        ],
      });
      expect(f.needsYou.blocked.map((g) => [g.cause, g.tickets.map((t) => t.ticketId)])).toEqual([
        ['question', ['C', 'A']],
        ['limit', ['B']],
      ]);
      expect(f.needsYou.blocked[1]!.tickets[0]).toMatchObject({ title: 'Titre B', kind: 'limit', reason: 'The run dev reached a limit (turns, duration or budget).' });
    });

    it('classes a block by its typed kind, never by its reason (ORC-345, criterion 3)', () => {
      const f = flow({
        tickets: [
          ticket('A', { blocked: true, blockKind: 'ci_bound', blockReason: 'Stopped on request', updatedAt: 30 }),
          ticket('B', { blocked: true, blockKind: 'stopped', blockReason: 'Halted by a human, reworded.', updatedAt: 20 }),
          ticket('C', { blocked: true, blockKind: 'stuck', blockReason: 'Loop: a sentence of another cause.', updatedAt: 10 }),
        ],
      });
      expect(f.needsYou.blocked).toEqual([
        { cause: 'infra', tickets: [expect.objectContaining({ ticketId: 'C', kind: 'stuck' })] },
        { cause: 'limit', tickets: [expect.objectContaining({ ticketId: 'A', kind: 'ci_bound', reason: 'Stopped on request' })] },
        { cause: 'stopped', tickets: [expect.objectContaining({ ticketId: 'B', kind: 'stopped' })] },
      ]);
    });

    it('keeps a block without a known cause in sight, with its raw reason', () => {
      const f = flow({ tickets: [ticket('A', { blocked: true, blockReason: 'Nouvelle raison.' }), ticket('B', { blocked: true })] });
      expect(f.needsYou.blocked).toEqual([{ cause: 'other', tickets: [expect.objectContaining({ ticketId: 'A', kind: 'other', reason: 'Nouvelle raison.' }), expect.objectContaining({ ticketId: 'B', kind: 'other', reason: '' })] }]);
    });

    it('lists the PRs in Human Review, and the merge gate of a workflow that still declares `ready`', () => {
      const f = flow({
        tickets: [
          ticket('A', { logical: 'human_review', prUrl: 'https://gh/pr/1', updatedAt: 20 }),
          ticket('B', { logical: 'human_review', updatedAt: 10 }),
          ticket('C', { logical: 'ready', prUrl: 'https://gh/pr/3' }),
        ],
      });
      expect(f.needsYou.humanReview.map((t) => t.ticketId)).toEqual(['B', 'A']);
      expect(f.needsYou.humanReview[1]!.prUrl).toBe('https://gh/pr/1');
      expect(f.needsYou.gates).toEqual([expect.objectContaining({ ticketId: 'C', prUrl: 'https://gh/pr/3' })]);
    });

    it('shows a blocked ticket once, under its block, wherever it is in the workflow', () => {
      const f = flow({ tickets: [ticket('A', { logical: 'human_review', blocked: true, blockReason: 'Stopped on request' }), ticket('B', { logical: 'done', blocked: true, blockReason: 'Stopped on request' })] });
      expect(f.needsYou.humanReview).toEqual([]);
      expect(f.done).toEqual([]);
      expect(f.needsYou.blocked[0]!.tickets.map((t) => t.ticketId)).toEqual(['A', 'B']);
    });

    it('keeps a PR in Needs you during a question run: the agent answers, it does not work on the PR', () => {
      const f = flow({
        tickets: [ticket('A', { logical: 'human_review' }), ticket('B', { logical: 'ready' })],
        running: [run('r1', 'A', { job: 'ask', queue: 'questions' }), run('r2', 'B', { job: 'ask', queue: 'questions' })],
      });
      expect(f.needsYou.humanReview.map((t) => t.ticketId)).toEqual(['A']);
      expect(f.needsYou.gates.map((t) => t.ticketId)).toEqual(['B']);
      expect(f.working.map((w) => w.ticketId)).toEqual(['A', 'B']);
      expect(f.others).toEqual([]);
    });

    it('does not ask a human for a PR whose agent job waits for a slot; a queued question leaves it there', () => {
      const f = flow({
        tickets: [ticket('A', { logical: 'human_review' }), ticket('B', { logical: 'human_review' })],
        queue: [queued('A', { job: 'fix-ci' }), queued('B', { job: 'ask', queue: 'questions' })],
      });
      expect(f.needsYou.humanReview.map((t) => t.ticketId)).toEqual(['B']);
      expect(f.queued.map((q) => q.ticketId)).toEqual(['A', 'B']);
      expect(f.others).toEqual([]);
    });

    it('does not ask a human for a PR the agent is still working on', () => {
      const f = flow({
        tickets: [ticket('A', { logical: 'human_review', activeRunId: 'r1' }), ticket('B', { logical: 'human_review', verifyingRunId: 'r2' })],
        running: [run('r1', 'A', { job: 'fix-ci' })],
        verifying: [run('r2', 'B', { status: 'success' })],
      });
      expect(f.needsYou.humanReview).toEqual([]);
      expect(f.working.map((w) => w.ticketId)).toEqual(['A', 'B']);
    });
  });

  describe('Working', () => {
    it('gives each running run its step, its duration and the tokens measured for its ticket', () => {
      const tokens = { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 };
      const f = flow({
        tickets: [ticket('A', { activeRunId: 'r1', costUsd: 0.5 })],
        running: [run('r1', 'A', { job: 'dev-feedback' })],
        measures: new Map([['p/A', { tokens, attemptsWithoutTokens: 0 }]]),
      });
      expect(f.working).toEqual([
        { projectId: 'p', ticketId: 'A', title: 'Titre A', runId: 'r1', step: 'dev-feedback', verifying: false, stoppable: true, durationMs: 5000, measured: true, tokens, attemptsWithoutTokens: 0, costUsd: 0.5 },
      ]);
    });

    it('counts apart the finished attempts that reported no usage', () => {
      const f = flow({
        tickets: [ticket('A', { activeRunId: 'r1' })],
        running: [run('r1', 'A')],
        measures: new Map([['p/A', { tokens: null, attemptsWithoutTokens: 3 }]]),
      });
      expect(f.working[0]).toMatchObject({ tokens: null, attemptsWithoutTokens: 3 });
    });

    it('serves no tokens when the measures of the ticket could not be read', () => {
      const f = flow({ tickets: [ticket('A', { activeRunId: 'r1', costUsd: 0.5 })], running: [run('r1', 'A')] });
      expect(f.working[0]).toMatchObject({ measured: false, tokens: null, attemptsWithoutTokens: 0, costUsd: 0.5 });
    });

    it('offers Stop on the ticket\'s active run only, as the Tickets table did: not on a question run', () => {
      const f = flow({
        tickets: [ticket('A', { activeRunId: 'r1' })],
        running: [run('r1', 'A'), run('r2', 'A', { job: 'ask', queue: 'questions', startedAt: NOW - 1000 })],
      });
      expect(f.working.map((w) => [w.runId, w.stoppable])).toEqual([['r1', true], ['r2', false]]);
    });

    it('keeps a run in sight while its checks run', () => {
      const f = flow({ tickets: [ticket('A', { verifyingRunId: 'r1' })], verifying: [run('r1', 'A', { status: 'success', endedAt: NOW - 1000 })] });
      expect(f.working[0]).toMatchObject({ runId: 'r1', step: 'dev', verifying: true, stoppable: false, durationMs: 5000 });
    });

    it('longest running first', () => {
      const f = flow({ tickets: [ticket('A'), ticket('B')], running: [run('r2', 'B', { startedAt: NOW - 10 }), run('r1', 'A', { startedAt: NOW - 20 })] });
      expect(f.working.map((w) => w.runId)).toEqual(['r1', 'r2']);
    });

    it('lists what waits for a slot, without what the queue item carries', () => {
      const f = flow({ tickets: [ticket('A')], queue: [queued('A', { job: 'fix-ci', inputText: 'contenu du ticket' })] });
      expect(f.queued).toEqual([{ ticketId: 'A', job: 'fix-ci' }]);
      expect(JSON.stringify(f)).not.toContain('contenu du ticket');
    });
  });

  describe('Done', () => {
    it('lists the recently finished tickets, latest first, for a week', () => {
      const f = flow({
        tickets: [
          ticket('OLD', { logical: 'done', updatedAt: NOW - 8 * DAY }),
          ticket('A', { logical: 'done', updatedAt: NOW - 2 * DAY, prUrl: 'https://gh/pr/1' }),
          ticket('B', { logical: 'done', updatedAt: NOW - DAY }),
        ],
      });
      expect(f.done.map((t) => t.ticketId)).toEqual(['B', 'A']);
      expect(f.done[1]).toEqual({ projectId: 'p', ticketId: 'A', title: 'Titre A', prUrl: 'https://gh/pr/1' });
    });

    it('stops at 20', () => {
      const f = flow({ tickets: Array.from({ length: 25 }, (_, i) => ticket(`T${i}`, { logical: 'done', updatedAt: NOW - i })) });
      expect(f.done).toHaveLength(20);
      expect(f.done[0]!.ticketId).toBe('T0');
    });
  });

  it('keeps every unfinished ticket reachable: none disappears with the Tickets table', () => {
    const f = flow({
      tickets: [
        ticket('IDLE', { logical: 'ai_review' }),
        ticket('TODO', { logical: 'todo' }),
        ticket('QUEUED'),
        ticket('RUNNING', { activeRunId: 'r1' }),
        ticket('OLD', { logical: 'done', updatedAt: 0 }),
      ],
      queue: [queued('QUEUED')],
      running: [run('r1', 'RUNNING')],
    });
    expect(f.others.map((t) => t.ticketId)).toEqual(['IDLE', 'TODO']);
  });

  it('serves no run token, whatever the runs hold', () => {
    const f = flow({
      tickets: [ticket('A', { activeRunId: 'r1' }), ticket('B', { verifyingRunId: 'r2' })],
      running: [run('r1', 'A')],
      verifying: [run('r2', 'B', { status: 'success' })],
    });
    expect(f.working).toHaveLength(2);
    expect(JSON.stringify(f)).not.toContain('SECRET-RUN-TOKEN');
  });
});
