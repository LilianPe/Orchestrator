import { describe, expect, it } from 'vitest';
import { buildPrompt, formatFeedback, formatVerifyFailures } from './prompt.js';

const issue = { identifier: 'REL-12', title: 'Export CSV', description: 'Exporter les audits.', url: 'https://linear.app/x/REL-12' };

describe('buildPrompt', () => {
  it('builds a dev prompt with branch', () => {
    expect(buildPrompt({ skill: 'factory:dev', issue, branch: 'factory/rel-12-export-csv', reviewRounds: 5 })).toBe(
      '/factory:dev\n\n## Ticket REL-12 — Export CSV\nURL : https://linear.app/x/REL-12\nBranche : factory/rel-12-export-csv\n\nExporter les audits.\n',
    );
  });

  it('adds review rounds, context and input sections', () => {
    const out = buildPrompt({
      skill: 'factory:review',
      issue: { ...issue, description: '' },
      promptContext: '<issue>…</issue>',
      input: { kind: 'feedback', text: '- **L** : x' },
      reviewRounds: 4,
    });
    expect(out).toContain('Rounds de review max : 4');
    expect(out).toContain('(pas de description)');
    expect(out).toContain('## Contexte Linear\n<issue>…</issue>');
    expect(out).toContain('## Retours à traiter\n- **L** : x');
  });

  it('renders the PR url after the branch line', () => {
    const out = buildPrompt({ skill: 'factory:review', issue, branch: 'b', prUrl: 'https://github.com/o/r/pull/3', reviewRounds: 2 });
    expect(out).toContain('Branche : b\nPR : https://github.com/o/r/pull/3\nRounds de review max : 2');
  });
});

describe('formatters', () => {
  it('formats feedback with UTC time', () => {
    expect(formatFeedback([{ author: 'Lilian', body: 'boutons', at: Date.UTC(2026, 9, 10, 14, 3), source: 'session' }])).toBe(
      '- **Lilian** (2026-10-10 14:03 UTC) : boutons',
    );
  });
  it('keeps the tail of long outputs', () => {
    const out = formatVerifyFailures([{ command: 'npm test', exitCode: 1, output: 'x'.repeat(9000) + 'END' }]);
    expect(out.startsWith('### `npm test` (code 1)\n```\n')).toBe(true);
    expect(out).toContain('END');
    expect(out.length).toBeLessThan(8100);
  });
});
