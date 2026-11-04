import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Flow, formatDuration, formatTokens, tokensCell } from './Flow.js';
import type { FlowView, WorkingRunView } from './types.js';

const EMPTY: FlowView = { needsYou: { blocked: [], humanReview: [], gates: [] }, working: [], queued: [], done: [], others: [] };
const base = { projectId: 'p', ticketId: 'REL-1', title: 'Export', updatedAt: 1 };
const running: WorkingRunView = {
  ...base, runId: 'r1', step: 'dev-feedback', verifying: false, stoppable: true, durationMs: 65_000, tokens: { input: 1_000, output: 2_000, cacheRead: 30_000, cacheCreation: 4_000 }, attemptsWithoutTokens: 0, costUsd: 0.5,
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
    expect(formatTokens(37_000)).toBe('37,0 k');
    expect(formatTokens(1_234_000)).toBe('1,2 M');
  });

  it('tokensCell: the measure, marked when attempts are missing from it, and the cost in dollars when none reported (ORC-216)', () => {
    expect(tokensCell(running).text).toBe('37,0 k');
    expect(tokensCell({ ...running, attemptsWithoutTokens: 2 }).text).toBe('≥ 37,0 k');
    expect(tokensCell({ ...running, tokens: null }).text).toBe('— (0,50 $)');
    expect(tokensCell({ ...running, tokens: null, costUsd: 0 }).text).toBe('—');
  });
});

describe('Flow', () => {
  it('says so when nothing waits for a human', () => {
    expect(page({})).toContain('Rien n’attend un humain');
  });

  it('shows a blocked ticket in Needs you under its cause, with its reason', () => {
    const html = page({ needsYou: { ...EMPTY.needsYou, blocked: [{ cause: 'red', tickets: [{ ...base, reason: 'Rouge non vérifié après 2 tentatives de tests.' }] }] } });
    expect(html).toContain('Rouge non vérifié</h3>');
    expect(html).toContain('REL-1');
    expect(html).toContain('Rouge non vérifié après 2 tentatives de tests.');
    expect(html).not.toContain('Rien n’attend un humain');
  });

  it('does not repeat a reason that only says what its cause says', () => {
    const html = page({ needsYou: { ...EMPTY.needsYou, blocked: [{ cause: 'stopped', tickets: [{ ...base, reason: 'Arrêté à la demande' }] }] } });
    expect(html.match(/Arrêté à la demande/g)).toHaveLength(1);
  });

  it('says on the page, not only on hover, that a running run counts when it ends', () => {
    expect(page({ working: [{ ...running, tokens: null, costUsd: 0 }] })).toContain('Un run en cours compte à sa fin');
    expect(page({})).not.toContain('Un run en cours compte à sa fin');
  });

  it('shows the PRs in Human Review with their link, and the gates', () => {
    const html = page({ needsYou: { ...EMPTY.needsYou, humanReview: [{ ...base, prUrl: 'https://gh/pr/1' }], gates: [{ ...base, ticketId: 'REL-2', gate: 'merge' }] } });
    expect(html).toContain('PR en Human Review');
    expect(html).toContain('href="https://gh/pr/1"');
    expect(html).toContain('Porte de merge');
    expect(html).toContain('REL-2');
  });

  it('shows a running run in Working with its step, its duration ticking and its tokens, and Stop', () => {
    const html = page({ working: [running] }, 10_000);
    expect(html).toContain('dev-feedback');
    expect(html).toContain('1 min 15 s');
    expect(html).toContain('37,0 k');
    expect(html).toContain('>Stop</button>');
  });

  it('offers no Stop where the Tickets table offered none, and names a verification', () => {
    const html = page({ working: [{ ...running, stoppable: false, verifying: true }] });
    expect(html).not.toContain('>Stop</button>');
    expect(html).toContain('vérification');
  });

  it('shows the queue, the finished tickets and the other tickets', () => {
    const html = page({
      queued: [{ projectId: 'p', ticketId: 'REL-4', title: 'En file', job: 'fix-ci' }],
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
    const html = page({ needsYou: { ...EMPTY.needsYou, blocked: [{ cause: 'other', tickets: [{ ...base, title: '<img src=x>', reason: '<script>x</script>' }] }] } });
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<script>');
  });
});
