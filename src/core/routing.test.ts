import { describe, expect, it } from 'vitest';
import { routeTicket } from './routing.js';

describe('routeTicket (ORC-291)', () => {
  it('a team with one repo keeps it, whatever the labels', () => {
    expect(routeTicket(['api'], ['repo:web'])).toEqual({ projectId: 'api' });
  });
  it('a team with several repos takes the one its repo: label names, case aside', () => {
    expect(routeTicket(['web', 'api'], ['bug', 'Repo:API'])).toEqual({ projectId: 'api' });
  });
  it('without a label naming one of them, the first repo gets the ticket with the list to choose from', () => {
    expect(routeTicket(['web', 'api'], ['repo:other'])).toEqual({ projectId: 'web', repos: ['web', 'api'] });
  });
});
