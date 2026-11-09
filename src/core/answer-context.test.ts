import { describe, expect, it } from 'vitest';
import { formatLinked, formatRunState, formatTranscript } from './answer-context.js';
import { newTicketState, type TicketState } from './types.js';

const ticket = (patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState('p', 'REL-1', 'Export CSV', 'dev', 0), delegated: true, ...patch });
const line = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } });

describe('what the answer agent reads of the run (ORC-182)', () => {
  it('the state: the step at work, its attempts, the block, the PR', () => {
    expect(formatRunState(ticket({ activeJob: 'dev', verifyAttempts: 2, ciFixAttempts: 1, prUrl: 'https://gh/pr/3', prChecks: 'fail' }))).toBe(
      ['State: dev', 'Running: dev', 'Attempts: 2 failed checks in a row, 1 rounds of the review and CI loop, 0 rounds of human review', 'PR: https://gh/pr/3 (CI fail)'].join('\n'),
    );
    const blocked = formatRunState(ticket({ blocked: true, blockReason: 'The run dev failed.', waitingOn: { blockers: ['REL-2'], start: { job: 'dev' } as never } }));
    expect(blocked).toContain('Running: nothing');
    expect(blocked).toContain('Blocked: The run dev failed.');
    expect(blocked).toContain('Waiting for: REL-2 to be done');
    expect(formatRunState(ticket({ verifyingRunId: 'r1' }))).toContain('Running: verification');
  });

  it('the transcript: what the agent wrote and the tools it called, its end kept within the cap', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      line([{ type: 'text', text: 'Je lis le module.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/export.ts' } }]),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'secret du fichier' }] } }),
      line([{ type: 'text', text: 'Je choisis le point-virgule.' }]),
      'not json',
    ];
    const all = 'Je lis le module.\n[Read] src/export.ts\nJe choisis le point-virgule.';
    expect(formatTranscript(lines)).toBe(all);
    expect(formatTranscript(lines, 10)).toBe(`[… ${all.length - 10} earlier characters left out]\nt-virgule.`);
    expect(formatTranscript([JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })])).toBeUndefined();
  });

  it('the linked tickets: those it is blocked by, none when there are none', () => {
    expect(formatLinked([{ identifier: 'REL-2', stateName: 'Done' }])).toBe('- REL-2 (Done), blocks this ticket');
    expect(formatLinked([])).toBeUndefined();
    expect(formatLinked(undefined)).toBeUndefined();
  });
});
