import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AGENT_QUESTION, STOPPED } from '../../src/core/block-cause.js';
import { Flow, formatDuration, formatTokens, plural, tokensCell } from './Flow.js';
import type { FlowView, WorkingRunView } from './types.js';

const EMPTY: FlowView = { needsYou: { blocked: [], humanReview: [], gates: [] }, working: [], queued: [], done: [], others: [] };
const base = { projectId: 'p', ticketId: 'REL-1', title: 'Export' };
const running: WorkingRunView = {
  ...base, runId: 'r1', step: 'dev-feedback', verifying: false, stoppable: true, durationMs: 65_000, measured: true, tokens: { input: 1_000, output: 2_000, cacheRead: 30_000, cacheCreation: 4_000 }, attemptsWithoutTokens: 0, usageLimitShare: null, costUsd: 0.5,
};
const page = (flow: Partial<FlowView>, elapsedMs = 0) =>
  renderToStaticMarkup(createElement(Flow, { flow: { ...EMPTY, ...flow }, elapsedMs, onSelect: () => undefined, onStop: () => undefined }));

describe('formats', () => {
  it('formatDuration', () => {
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(65_000)).toBe('1 min 05 s');
    expect(formatDuration(3_900_000)).toBe('1 h 05 min');
  });

  it('formatTokens', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(37_000)).toBe('37.0 k');
    expect(formatTokens(1_234_000)).toBe('1.2 M');
    // Rounded before the unit is chosen (ORC-332).
    expect(formatTokens(999_949)).toBe('999.9 k');
    expect(formatTokens(999_950)).toBe('1.0 M');
  });

  it('plural: one, then more (ORC-332)', () => {
    expect(plural(1, 'turn')).toBe('1 turn');
    expect(plural(0, 'turn')).toBe('0 turns');
    expect(plural(3, 'turn')).toBe('3 turns');
    expect(tokensCell({ ...running, attemptsWithoutTokens: 1 }).title).toMatch(/^1 finished attempt without a measurement\. /);
    expect(tokensCell({ ...running, attemptsWithoutTokens: 2 }).title).toMatch(/^2 finished attempts without a measurement\. /);
  });

  it('tokensCell: the measure, marked when attempts are missing from it, and the cost in dollars when none reported (ORC-216)', () => {
    expect(tokensCell(running).text).toBe('37.0 k');
    expect(tokensCell({ ...running, attemptsWithoutTokens: 2 }).text).toBe('≥ 37.0 k');
    expect(tokensCell({ ...running, tokens: null }).text).toBe('— ($0.50)');
    expect(tokensCell({ ...running, tokens: null, costUsd: 0 }).text).toBe('—');
  });

  it("tokensCell: the share of the ticket's token budget, beside its tokens, when there is a cap (ORC-194)", () => {
    const cell = tokensCell({ ...running, usageLimitShare: 0.42 });
    expect(cell.text).toBe('37.0 k · 42%');
    expect(cell.title).toMatch(/ 42% of the ticket’s token budget\.$/);
    expect(tokensCell({ ...running, tokens: null, costUsd: 0, usageLimitShare: null }).text).toBe('—');
  });

  it('tokensCell: a read error is not a fact about the ticket', () => {
    const cell = tokensCell({ ...running, measured: false, tokens: null, attemptsWithoutTokens: 0 });
    expect(cell.text).toBe('?');
    expect(cell.title).toContain('could not be read');
  });
});

describe('Flow', () => {
  it('says so when nothing waits for a human', () => {
    expect(page({})).toContain('Nothing is waiting for a human');
  });

  it('shows a blocked ticket in Needs you under its cause, with its reason', () => {
    const html = page({ needsYou: { ...EMPTY.needsYou, blocked: [{ cause: 'red', tickets: [{ ...base, kind: 'red', reason: 'Red not verified after 2 attempts of tests.' }] }] } });
    expect(html).toContain('Red not verified</h3>');
    expect(html).toContain('REL-1');
    expect(html).toContain('Red not verified after 2 attempts of tests.');
    expect(html).not.toContain('Nothing is waiting for a human');
  });

  it('does not repeat a reason whose kind says no more than its cause (ORC-332)', () => {
    const html = page({ needsYou: { ...EMPTY.needsYou, blocked: [{ cause: 'stopped', tickets: [{ ...base, kind: 'stopped', reason: STOPPED }] }] } });
    expect(html.match(/Stopped on request/g)).toHaveLength(1);
    const asked = page({ needsYou: { ...EMPTY.needsYou, blocked: [{ cause: 'question', tickets: [{ ...base, kind: 'asked', reason: AGENT_QUESTION }] }] } });
    expect(asked.match(/Question asked by the agent/g)).toHaveLength(1);
  });

  it('hides or shows a reason by the typed kind the server sends, whatever the reason says (ORC-345, criterion 3)', () => {
    const html = page({ needsYou: { ...EMPTY.needsYou, blocked: [
      // Written before ORC-331, or reworded since: the kind still says it restates its cause.
      { cause: 'stopped', tickets: [{ ...base, kind: 'stopped', reason: 'Arrêté à la demande' }] },
      // The label of a cause as the reason of a block of another kind is shown: the kind decides, not the sentence.
      { cause: 'question', tickets: [{ ...base, ticketId: 'REL-2', kind: 'question', reason: AGENT_QUESTION }] },
      { cause: 'infra', tickets: [{ ...base, ticketId: 'REL-3', kind: 'infra', reason: STOPPED }] },
    ] } });
    expect(html).toContain(`${STOPPED}</h3>`);
    expect(html).not.toContain('Arrêté');
    expect(html.match(/Question asked by the agent/g)).toHaveLength(2);
    expect(html.match(/Stopped on request/g)).toHaveLength(2);
  });

  it('says on the page, not only on hover, that a running run counts when it ends', () => {
    expect(page({ working: [{ ...running, tokens: null, costUsd: 0 }] })).toContain('A run in progress counts when it ends');
    expect(page({})).not.toContain('A run in progress counts when it ends');
  });

  it('shows the PRs in Human Review with their link, and the gates', () => {
    const html = page({ needsYou: { ...EMPTY.needsYou, humanReview: [{ ...base, prUrl: 'https://gh/pr/1' }], gates: [{ ...base, ticketId: 'REL-2' }] } });
    expect(html).toContain('PRs in Human Review');
    expect(html).toContain('href="https://gh/pr/1"');
    expect(html).toContain('Merge gate');
    expect(html).toContain('REL-2');
  });

  it('shows a running run in Working with its step, its duration ticking and its tokens, and Stop', () => {
    const html = page({ working: [running] }, 10_000);
    expect(html).toContain('dev-feedback');
    expect(html).toContain('1 min 15 s');
    expect(html).toContain('37.0 k');
    expect(html).toContain('>Stop</button>');
  });

  it('offers no Stop where the Tickets table offered none, and names a verification', () => {
    const html = page({ working: [{ ...running, stoppable: false, verifying: true }] });
    expect(html).not.toContain('>Stop</button>');
    expect(html).toContain('verification');
  });

  it('shows the queue, the finished tickets and the other tickets', () => {
    const html = page({
      queued: [{ ticketId: 'REL-4', job: 'fix-ci' }],
      done: [{ ...base, ticketId: 'REL-5', prUrl: 'https://gh/pr/5' }],
      others: [{ ...base, ticketId: 'REL-6' }],
    });
    expect(html).toContain('REL-4');
    expect(html).toContain('fix-ci');
    expect(html).toContain('REL-5');
    expect(html).toContain('href="https://gh/pr/5"');
    expect(html).toContain('REL-6');
  });

  it('escapes what a ticket says: its title and reason are data', () => {
    const html = page({ needsYou: { ...EMPTY.needsYou, blocked: [{ cause: 'other', tickets: [{ ...base, title: '<img src=x>', kind: 'other', reason: '<script>x</script>' }] }] } });
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<script>');
  });
});
