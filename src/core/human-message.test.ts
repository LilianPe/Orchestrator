import { describe, expect, it } from 'vitest';
import { awaitsAgent, carriedAtLaunch, classifyMessage, forAgent } from './human-message.js';
import type { FeedbackItem } from './types.js';

describe('classifyMessage (ORC-180): deterministic rules, no model', () => {
  it.each(['/status', '/stop', '  /STOP  ', '/status du ticket ?'])('%j is a command', (body) => {
    expect(classifyMessage(body)).toBe('command');
  });

  it.each(['et pour mobile ?', 'pourquoi?', 'change le titre ?', 'corrige https://a.b/c?d=1'])('%j has a question mark: a question', (body) => {
    expect(classifyMessage(body)).toBe('question');
  });

  it.each([
    'arrête',
    'Arrête de toucher au CSS',
    'change le titre',
    'reprends',
    'corrige le bug du tri',
    'Ajoute un test',
    'enlève ce log',
    "n'oublie pas le mobile",
    'il faut garder le format',
    'merci de renommer ce champ',
    'stp corrige le bug',
    'please fix the sort',
  ])('%j asks for an action: an instruction', (body) => {
    expect(classifyMessage(body)).toBe('instruction');
  });

  it.each(['boutons mal alignés', 'ok', 'bug quand la liste est vide', 'changement de plan', '', '   ', '/autre chose'])('%j stays ambiguous: a question', (body) => {
    expect(classifyMessage(body)).toBe('question');
  });
});

describe('the human inbox at a hand-over (ORC-180)', () => {
  const item = (patch: Partial<FeedbackItem>): FeedbackItem => ({ author: 'L', body: 'b', at: 1, source: 'session', ...patch });

  it('leaves out a command, already answered, and keeps a message of before ORC-180', () => {
    const old = item({ body: 'old' });
    const asked = item({ kind: 'question' });
    expect(forAgent([old, asked, item({ kind: 'command' })])).toEqual([old, asked]);
  });

  it('a question of a thread waits for the next agent, a message of the dev session asks for one', () => {
    expect(awaitsAgent([item({ kind: 'question', source: 'thread' }), item({ kind: 'command' })])).toBe(false);
    expect(awaitsAgent([item({ kind: 'question' })])).toBe(true);
    expect(awaitsAgent([item({ kind: 'instruction' })])).toBe(true);
    // Written before ORC-180: decided as it was, the debounce alone relays it.
    expect(awaitsAgent([item({})])).toBe(false);
  });

  it('a launch that does not read the feedback by itself carries the classified messages, then the rest with them', () => {
    expect(carriedAtLaunch([item({ kind: 'command' })])).toEqual([]);
    expect(carriedAtLaunch([item({})])).toEqual([]);
    const old = item({ body: 'old' });
    const asked = item({ kind: 'question', source: 'thread' });
    expect(carriedAtLaunch([old, asked, item({ kind: 'command' })])).toEqual([old, asked]);
  });
});
