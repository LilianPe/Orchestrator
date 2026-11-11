import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_SECURITY_SOURCE, Security } from './Security.js';
import type { BlockParetoView, RunSecurityView, SecurityPeriodView } from './types.js';

const PERIOD: SecurityPeriodView = {
  since: 0,
  until: 7 * 24 * 60 * 60 * 1000,
  hosts: [{ host: 'evil.example', requests: 3, refused: 3 }, { host: 'registry.npmjs.org', requests: 2, refused: 0 }],
  rules: [{ rule: 'push', refusals: 2 }, { rule: 'force-push', refusals: 1 }],
  runs: [{ runId: 'run-loud-1234', projectId: 'p', ticketId: 'REL-2', requests: 4, refused: 3, refusals: 3 }],
  runsLeftOut: 0,
};
const BLOCKS: BlockParetoView = {
  since: 0,
  until: 1,
  total: 4,
  causes: [
    { cause: 'red', count: 3, share: 0.75, cumulative: 0.75 },
    { cause: 'limit', count: 1, share: 0.25, cumulative: 1 },
  ],
};
const RUN: RunSecurityView = {
  runId: 'run-loud-1234', projectId: 'p', ticketId: 'REL-2', at: 0,
  rules: [{ rule: 'push', refusals: 2 }, { rule: 'force-push', refusals: 1 }],
  refusals: [{ at: 0, tool: 'Bash', rule: 'push' }, { at: 1, tool: 'Bash', rule: 'force-push' }, { at: 2, tool: 'Bash', rule: 'push' }],
  hosts: [{ host: 'evil.example', requests: 3, refused: 3 }, { host: 'registry.npmjs.org', requests: 1, refused: 0 }],
  skipped: { egress: 0, refusals: 2 },
};

const page = (props: Partial<Parameters<typeof Security>[0]> = {}) =>
  renderToStaticMarkup(createElement(Security, { period: PERIOD, blocks: BLOCKS, onSelect: () => undefined, ...props }));
const rows = (html: string, title: string) => html.split(`>${title}<`)[1]!.split('</table>')[0]!.match(/<tr>.*?<\/tr>/g)!.slice(1);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the security page (ORC-300)', () => {
  it('shows the causes of the blocks of the period, most frequent first, with their share and running share', () => {
    const html = page();
    expect(rows(html, 'Block causes').map(text)).toEqual(['Red not verified 3 75% 75%', 'Limit reached 1 25% 100%']);
    expect(page({ blocks: { ...BLOCKS, total: 0, causes: [] } })).toContain('No ticket moved into Blocked over the period.');
  });

  it('counts the refusals per rule, the hosts and the runs of the period', () => {
    const html = page();
    expect(rows(html, 'Refusals per rule').map(text)).toEqual(['push 2', 'force-push 1']);
    expect(rows(html, 'Hosts contacted').map(text)).toEqual(['evil.example 3 3', 'registry.npmjs.org 2 0']);
    expect(rows(html, 'Runs').map(text)).toEqual(['REL-2 run-loud 4 3 3']);
    expect(page({ period: { ...PERIOD, hosts: [], rules: [], runs: [] } })).toContain('No security log over the period.');
    expect(page({ period: { ...PERIOD, runsLeftOut: 7 } })).toContain('7 runs less refused not listed.');
  });

  it('says when the run selected could not be read', () => {
    expect(page({ selected: RUN.runId, runFailed: true })).toContain('Reading the run failed.');
  });

  it("lists a run's refusals with their rule, counted per rule, and its hosts with those the proxy refused", () => {
    const html = page({ run: RUN, selected: RUN.runId });
    const run = text(html.split('<h2>Run ')[1]!.split('</section>')[0]!);
    expect(run).toContain('push 2');
    expect(run).toContain('force-push 1');
    expect(rows(html, 'Hosts contacted').map(text)).toEqual(['evil.example 3 3', 'registry.npmjs.org 1 0']);
    expect(run.match(/Bash/g)).toHaveLength(3);
    expect(run).toContain('2 log lines ignored (malformed or forged)');
  });

  it('says what has no source yet: the dependencies added', () => {
    expect(NO_SECURITY_SOURCE.map((n) => n.ticket)).toEqual(['ORC-165']);
    expect(page()).toContain('Dependencies added and refused');
  });
});
