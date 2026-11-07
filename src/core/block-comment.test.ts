import { describe, expect, it } from 'vitest';
import { composeBlockComment, type BlockFacts } from './block-comment.js';

const facts: BlockFacts = {
  step: 'verify',
  max: 3,
  reason: 'Checks still failing after 3 attempts.',
  tried: ['`npm test` (code 1)', '`npm run lint` (code 2)'],
  question: 'Redo as is (reply "yes") or with an instruction?',
};

describe('the standard blocking comment (ORC-196)', () => {
  it('always has the same form: step and attempt, reason, what was tried, question, state, reply', () => {
    const body = composeBlockComment(facts, { branch: 'factory/rel-1', sha: 'abcdef0123456789', ci: 'fail', tokens: 12_345, durationMs: 42 * 60_000 });
    expect(body).toBe(
      [
        "🔴 Blocked at step verify (attempt 3/3)",
        'Reason: Checks still failing after 3 attempts.',
        'What I tried:',
        '- `npm test` (code 1)',
        '- `npm run lint` (code 2)',
        'Question: Redo as is (reply "yes") or with an instruction?',
        'State: branch factory/rel-1 · last commit abcdef012345 · CI red · tokens 12345 · 42 min',
        'Reply on this ticket: I will resume as soon as you answer.',
      ].join('\n'),
    );
  });

  it('keeps its form when the state is unknown: it says so, it invents nothing', () => {
    expect(composeBlockComment(facts, {}).split('\n').at(-2)).toBe('State: branch none · last commit none · CI none · tokens unknown · unknown duration');
  });

  it('keeps the reason on one line, whatever error it quotes, and at most 5 tries', () => {
    const body = composeBlockComment({ ...facts, reason: 'Error: a\n  b', tried: ['1', '2', '3', '4', '5', '6'] }, {});
    expect(body).toContain('Reason: Error: a b\n');
    expect(body).toContain('- 5\n');
    expect(body).not.toContain('- 6');
  });

  it('does not promise to resume on a reply when only an action lifts the block', () => {
    const body = composeBlockComment({ ...facts, waits: true }, {});
    expect(body.split('\n').at(-1)).toBe('A reply is not enough here: I will resume once what is asked above is done.');
  });
});
