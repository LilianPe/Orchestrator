import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Inspection } from './Inspection.js';
import type { FeedLine, WorkingRunView } from './types.js';

const run: WorkingRunView = {
  projectId: 'p', ticketId: 'REL-1', title: 'Export', runId: 'r1', step: 'build', verifying: false, stoppable: true, durationMs: 65_000, measured: true, tokens: null, attemptsWithoutTokens: 0, usageLimitShare: null, costUsd: 0,
};
const feed: FeedLine[] = [
  { kind: 'activity', runId: 'r1', action: 'Reading the code', parameter: 'step build', at: Date.UTC(2026, 10, 9, 9, 0, 0) },
  { kind: 'activity', runId: 'r0', action: 'Editing files', parameter: 'step build', at: Date.UTC(2026, 10, 9, 9, 0, 1) },
  { kind: 'event', id: 'e1', type: 'run.finished', at: Date.UTC(2026, 10, 9, 9, 0, 2) },
];
const page = (props: Partial<Parameters<typeof Inspection>[0]> = {}) =>
  renderToStaticMarkup(createElement(Inspection, { run, feed, onPause: () => undefined, onStop: () => undefined, onTakeOver: () => undefined, ...props }));

describe("a run's inspection (ORC-301)", () => {
  it("follows the run's live feed: its composed activities and the ticket's events, not another run's activities", () => {
    const html = page();
    expect(html).toContain('REL-1');
    expect(html).toContain('Reading the code');
    expect(html).toContain('step build');
    expect(html).toContain('run.finished');
    expect(html).not.toContain('Editing files');
  });

  it('says that the feed starts when the page was opened, when nothing came yet', () => {
    expect(page({ feed: [] })).toContain('Nothing received from this run since the page was opened.');
  });

  it('offers pause, stop and take over (ORC-234) on a run the agent is working', () => {
    const html = page();
    expect(html).toMatch(/<button[^>]*>Pause<\/button>/);
    expect(html).toMatch(/<button[^>]*>Stop<\/button>/);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Take over<\/button>/);
  });

  it('offers no pause, stop nor take over on a verification, which no agent runs', () => {
    const html = page({ run: { ...run, verifying: true, stoppable: false } });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Pause<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Stop<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Take over<\/button>/);
  });

  it('shows the answer to a refused action', () => {
    expect(page({ notice: 'run r1 is not running' })).toContain('run r1 is not running');
  });
});
