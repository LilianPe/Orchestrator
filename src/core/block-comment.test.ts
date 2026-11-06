import { describe, expect, it } from 'vitest';
import { composeBlockComment, type BlockFacts } from './block-comment.js';

const facts: BlockFacts = {
  step: 'verify',
  attempt: 3,
  max: 3,
  reason: 'Vérifications toujours en échec après 3 tentatives.',
  tried: ['`npm test` (code 1)', '`npm run lint` (code 2)'],
  question: 'Faut-il reprendre tel quel (répondez « oui ») ou avec une consigne (écrivez-la) ?',
};

describe('the standard blocking comment (ORC-196)', () => {
  it('always has the same form: step and attempt, reason, what was tried, question, state, reply', () => {
    const body = composeBlockComment(facts, { branch: 'factory/rel-1', sha: 'abcdef0123456789', ci: 'fail', tokens: 12_345, durationMs: 42 * 60_000 });
    expect(body).toBe(
      [
        "🔴 Bloqué à l'étape verify (tentative 3/3)",
        'Raison : Vérifications toujours en échec après 3 tentatives.',
        "Ce que j'ai essayé :",
        '- `npm test` (code 1)',
        '- `npm run lint` (code 2)',
        'Question : Faut-il reprendre tel quel (répondez « oui ») ou avec une consigne (écrivez-la) ?',
        'État : branche factory/rel-1 · dernier commit abcdef012345 · CI rouge · tokens 12345 · 42 min',
        'Répondez dans ce ticket : je reprends dès votre réponse.',
      ].join('\n'),
    );
  });

  it('keeps its form when the state is unknown: it says so, it invents nothing', () => {
    expect(composeBlockComment(facts, {}).split('\n').at(-2)).toBe('État : branche aucune · dernier commit aucun · CI aucune · tokens inconnus · durée inconnue');
  });

  it('keeps the reason on one line, whatever error it quotes, and at most 5 tries', () => {
    const body = composeBlockComment({ ...facts, reason: 'Erreur : a\n  b', tried: ['1', '2', '3', '4', '5', '6'] }, {});
    expect(body).toContain('Raison : Erreur : a b\n');
    expect(body).toContain('- 5\n');
    expect(body).not.toContain('- 6');
  });

  it('does not promise to resume on a reply when only an action lifts the block', () => {
    const body = composeBlockComment({ ...facts, waits: true }, {});
    expect(body.split('\n').at(-1)).toBe('Une réponse ne suffit pas ici : je reprends une fois ce qui est demandé ci-dessus fait.');
  });
});
