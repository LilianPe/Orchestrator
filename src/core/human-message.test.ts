import { describe, expect, it } from 'vitest';
import { awaitsAgent, carriedAtLaunch, classifyMessage, forAgent } from './human-message.js';
import type { FeedbackItem } from './types.js';

describe('classifyMessage (ORC-180, ORC-336)', () => {
  it.each(['/status', '/stop', '  /STOP  ', '/status du ticket ?'])('%j is a command, whatever the model says', (body) => {
    expect(classifyMessage(body, 'instruction')).toBe('command');
    expect(classifyMessage(body)).toBe('command');
  });

  it.each([
    ['Le tri doit être décroissant', 'instruction'],
    ['Could you switch the sort?', 'instruction'],
    ['corrige le tri, ok ?', 'instruction'],
    ['boutons mal alignés', 'question'],
  ] as const)('%j: the model says %s, so it is', (body, verdict) => {
    expect(classifyMessage(body, verdict)).toBe(verdict);
  });

  describe('without a verdict, the fallback rule', () => {
    it.each(['et pour mobile ?', 'pourquoi?', 'change le titre ?', 'corrige https://a.b/c?d=1 ?'])('%j has a question mark: a question', (body) => {
      expect(classifyMessage(body)).toBe('question');
    });

    it.each(['Le tri doit être décroissant', 'please fix the sort', 'boutons mal alignés', 'regarde https://app/x?id=1', '/autre chose'])('%j has none outside a URL: an instruction', (body) => {
      expect(classifyMessage(body)).toBe('instruction');
    });
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
