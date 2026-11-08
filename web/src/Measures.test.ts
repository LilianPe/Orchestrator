import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { costCell, Measures, NO_SOURCE, overview, reviewRoundsCell, runDuration, ticketDuration } from './Measures.js';
import type { MeasuredTicketView, RunMeasureView, TicketMeasuresView } from './types.js';

const tokens = { input: 1_000, output: 2_000, cacheRead: 30_000, cacheCreation: 4_000 };
const attempt = (patch: Partial<RunMeasureView> = {}): RunMeasureView => ({
  id: 'r1', job: 'dev', role: 'implementer', status: 'success', startedAt: 0, endedAt: 60_000, durationMs: 60_000, tokens, costUsd: 0, turns: 5, ...patch,
});
const measures = (patch: Partial<TicketMeasuresView> = {}): TicketMeasuresView => ({
  mergedAt: null, tokens, attempts: 1, attemptsWithoutTokens: 0, firstTry: null, reworks: [], revertedWithin14Days: null, ciCost: null, messages: [],
  startedAt: 0, leadTimeMs: null, workMs: 60_000, costUsd: 0, reviewRounds: { ai: 0, human: 0 }, runs: [attempt()], ...patch,
});
const ticket = (ticketId: string, m: TicketMeasuresView | null, patch: Partial<MeasuredTicketView> = {}): MeasuredTicketView => ({
  projectId: 'p', ticketId, title: `Title ${ticketId}`, logical: 'dev', blocked: false, measures: m, ...patch,
});

describe('the cells of the measures (ORC-223)', () => {
  it('runDuration: an ended attempt its duration, a running one its time so far, an attempt cut without an end none', () => {
    expect(runDuration(attempt(), 0)).toBe('1 min 00 s');
    expect(runDuration(attempt({ status: 'running', startedAt: 10_000, endedAt: null, durationMs: null }), 52_000)).toBe('42 s, running');
    expect(runDuration(attempt({ status: 'interrupted', endedAt: null, durationMs: null }), 52_000)).toBe('—');
  });

  it('ticketDuration: delegation to merge once merged, the time so far before, nothing without a start', () => {
    expect(ticketDuration(measures({ mergedAt: 3_900_000, leadTimeMs: 3_900_000 }), 9_999_999)).toEqual({ text: '1 h 05 min', title: expect.stringContaining('merge') });
    expect(ticketDuration(measures({ startedAt: 1_000 }), 43_000).text).toBe('42 s so far');
    expect(ticketDuration(measures({ startedAt: null }), 43_000).text).toBe('—');
  });

  it('reviewRoundsCell: AI and human rounds apart', () => {
    expect(reviewRoundsCell({ ai: 2, human: 1 })).toBe('2 AI · 1 human');
  });

  it('costCell: the tokens, marked when attempts are missing, dollars when none reported, ? when unreadable', () => {
    expect(costCell(measures()).text).toBe('37.0 k');
    expect(costCell(measures({ attemptsWithoutTokens: 1 })).text).toBe('≥ 37.0 k');
    expect(costCell(measures({ tokens: null, costUsd: 0.5 })).text).toBe('— ($0.50)');
    expect(costCell(null).text).toBe('?');
  });
});

describe('overview (ORC-223)', () => {
  const merged = (id: string, leadTimeMs: number, firstTry: boolean, t = tokens) =>
    ticket(id, measures({ mergedAt: leadTimeMs, leadTimeMs, firstTry, tokens: t }), { logical: 'done' });

  it('counts the merged tickets, their median lead time, tokens per merged ticket and how many were ready at the first try', () => {
    const o = overview([
      merged('A', 60_000, true),
      merged('B', 120_000, false, { input: 0, output: 0, cacheRead: 0, cacheCreation: 3_000 }),
      merged('C', 600_000, true),
      ticket('D', measures()),
    ]);
    expect(o).toMatchObject({ delivered: 3, medianLeadTimeMs: 120_000, firstTry: { yes: 2, of: 3 }, tokensPerMerged: { mean: (37_000 * 2 + 3_000) / 3, leftOut: 0 } });
  });

  it('leaves out of the tokens a merged ticket with none reported, and says how many; reads nothing from a ticket it could not measure', () => {
    const o = overview([merged('A', 60_000, true), ticket('B', measures({ mergedAt: 1, leadTimeMs: 1, firstTry: true, tokens: null }), { logical: 'done' }), ticket('X', null)]);
    expect(o).toMatchObject({ delivered: 2, tokensPerMerged: { mean: 37_000, leftOut: 1 }, unmeasured: 1 });
  });

  it('is empty without a merged ticket, never a zero that reads as a measure', () => {
    expect(overview([ticket('D', measures())])).toMatchObject({ delivered: 0, medianLeadTimeMs: null, firstTry: { yes: 0, of: 0 }, tokensPerMerged: { mean: null, leftOut: 0 } });
  });

  it('takes the median delays to the first sign of life and to the answer over the human messages, unanswered ones left out', () => {
    const msg = (signOfLifeMs: number | null, answerMs: number | null) => ({ eventId: 'e', type: 'session.mentioned', kind: 'question', at: 0, signOfLifeMs, answerMs });
    const o = overview([ticket('A', measures({ messages: [msg(2_000, 60_000), msg(4_000, null)] })), ticket('B', measures({ messages: [msg(30_000, 120_000)] }))]);
    expect(o).toMatchObject({ medianSignOfLifeMs: 4_000, medianAnswerMs: 90_000 });
    expect(overview([ticket('A', measures())])).toMatchObject({ medianSignOfLifeMs: null, medianAnswerMs: null });
  });
});

describe('Measures (ORC-223)', () => {
  const page = (tickets: MeasuredTicketView[], selected?: string) =>
    renderToStaticMarkup(createElement(Measures, { tickets, now: 100_000, selected, onSelect: () => undefined }));

  it('shows each ticket with its cost, duration and review rounds', () => {
    const html = page([ticket('REL-1', measures({ reviewRounds: { ai: 1, human: 2 }, workMs: 60_000 }))]);
    expect(html).toContain('REL-1');
    expect(html).toContain('37.0 k');
    expect(html).toContain('1 AI · 2 human');
    expect(html).toContain('1 min 40 s so far');
  });

  it('says plainly which measures have no source yet, and the ticket that brings each', () => {
    const html = page([]);
    for (const { label, ticket: id } of NO_SOURCE) {
      expect(html).toContain(label);
      expect(html).toContain(id);
    }
    expect(NO_SOURCE.map((n) => n.ticket)).toEqual(expect.arrayContaining(['ORC-216', 'ORC-190', 'ORC-230']));
  });

  it("shows the selected ticket's attempts, each with its step, role, duration, tokens and turns", () => {
    const runs = [attempt(), attempt({ id: 'r2', job: 'review', role: 'reviewer', status: 'running', startedAt: 90_000, endedAt: null, durationMs: null, tokens: null, turns: 0 })];
    const html = page([ticket('REL-1', measures({ runs }))], 'p/REL-1');
    expect(html).toContain('review');
    expect(html).toContain('reviewer');
    expect(html).toContain('10 s, running');
    expect(html).toContain('5 turns');
  });

  it('marks a ticket whose measures could not be read, rather than showing zeros', () => {
    const html = page([ticket('REL-9', null)]);
    expect(html).toContain('REL-9');
    expect(html).toContain('could not be read');
  });
});
