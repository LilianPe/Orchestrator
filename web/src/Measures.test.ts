import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { costCell, Measures, reviewRoundsCell, runDuration, ticketDuration } from './Measures.js';
import type { MeasuredTicketView, RunMeasureView, TicketMeasuresView } from './types.js';

const tokens = { input: 1_000, output: 2_000, cacheRead: 30_000, cacheCreation: 4_000 };
const attempt = (patch: Partial<RunMeasureView> = {}): RunMeasureView => ({
  id: 'r1', job: 'dev', role: 'implementer', status: 'success', startedAt: 0, endedAt: 60_000, durationMs: 60_000, tokens, costUsd: 0, turns: 5, ...patch,
});
const measures = (patch: Partial<TicketMeasuresView> = {}): TicketMeasuresView => ({
  mergedAt: null, tokens, attempts: 1, attemptsWithoutTokens: 0, usageLimitShare: null, firstTry: null, reworks: [], revertedWithin14Days: null, ciCost: null, messages: [],
  startedAt: 0, leadTimeMs: null, workMs: 60_000, costUsd: 0, reviewRounds: { ai: 0, human: 0 }, runs: [attempt()], ...patch,
});
const ticket = (ticketId: string, m: TicketMeasuresView | null, patch: Partial<MeasuredTicketView> = {}): MeasuredTicketView => ({
  projectId: 'p', ticketId, title: `Title ${ticketId}`, logical: 'dev', blocked: false, blockCause: null, measures: m, ...patch,
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
    // Finished without a merge: nothing goes on.
    expect(ticketDuration(measures({ startedAt: 1_000 }), 43_000, 'done')).toEqual({ text: '—', title: expect.stringContaining('without a merge') });
  });

  it('reviewRoundsCell: AI and human rounds apart', () => {
    expect(reviewRoundsCell({ ai: 2, human: 1 })).toBe('2 AI · 1 human');
  });

  it('costCell: the tokens, marked when attempts are missing, dollars when none reported, ? when unreadable', () => {
    expect(costCell(measures()).text).toBe('37.0 k');
    expect(costCell(measures({ attemptsWithoutTokens: 1 })).text).toBe('≥ 37.0 k');
    expect(costCell(measures({ tokens: null, costUsd: 0.5 })).text).toBe('— ($0.50)');
    expect(costCell(null).text).toBe('?');
    expect(costCell(measures({ usageLimitShare: 0.42 })).text).toBe('37.0 k · 42%'); // As the Flow (ORC-194).
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

  it('sends to the Overview for the figures over all the tickets, which the factory computes (ORC-299)', () => {
    expect(page([])).toContain('href="#overview"');
  });

  it("shows the selected ticket's attempts, each with its step, role, duration, tokens and turns", () => {
    const runs = [attempt(), attempt({ id: 'r2', job: 'review', role: 'reviewer', status: 'running', startedAt: 90_000, endedAt: null, durationMs: null, tokens: null, turns: 0 })];
    const html = page([ticket('REL-1', measures({ runs }))], 'p/REL-1');
    expect(html).toContain('review');
    expect(html).toContain('reviewer');
    expect(html).toContain('10 s, running');
    expect(html).toContain('5 turns');
  });

  it("shows a blocked ticket's cause by the label the Flow gives it", () => {
    const html = page([ticket('REL-3', measures(), { blocked: true, blockCause: 'infra' })]);
    expect(html).toContain('blocked: Infrastructure failure');
  });

  it('marks a ticket whose measures could not be read, rather than showing zeros', () => {
    const html = page([ticket('REL-9', null)]);
    expect(html).toContain('REL-9');
    expect(html).toContain('could not be read');
  });
});
