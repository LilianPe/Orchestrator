import { describe, expect, it } from 'vitest';
import { resolveRoute, unroutedReason } from './routing.js';
import { newTicketState, type TicketState } from './types.js';

const t = (projectId: string, patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState(projectId, 'REL-1', 'T', 'todo', 0), ...patch });
const team = ['web', 'api'];

describe('resolveRoute (ORC-291)', () => {
  it('a team with one repo keeps it, whatever the labels', () => {
    expect(resolveRoute(['api'], [], ['repo:web'])).toEqual({ projectId: 'api' });
  });
  it('a team with several repos takes the one its repo: label names, case aside', () => {
    expect(resolveRoute(team, [], ['bug', 'Repo:API'])).toEqual({ projectId: 'api' });
  });
  it('without a label naming one of them, the first repo gets the ticket with the list to choose from', () => {
    expect(resolveRoute(team, [], ['repo:other'])).toEqual({ projectId: 'web', repos: ['web', 'api'] });
  });
  it('is sticky: a project that holds the ticket keeps it, whatever its labels now say', () => {
    expect(resolveRoute(team, [t('web', { delegated: true })], ['repo:api'])).toEqual({ projectId: 'web' });
    expect(resolveRoute(team, [t('web', { prNumber: 3 })], ['repo:api'])).toEqual({ projectId: 'web' });
  });
  it('a ticket waiting for its repo is routed again by its label; otherwise it stays where it waits', () => {
    const pending = t('api', { delegated: true, blocked: true, blockReason: unroutedReason(team) });
    expect(resolveRoute(team, [pending], ['repo:web'])).toEqual({ projectId: 'web' });
    expect(resolveRoute(team, [pending], [])).toEqual({ projectId: 'api', repos: team });
    expect(resolveRoute(team, [pending])).toEqual({ projectId: 'api' });
  });
  it('without labels to route by, a ticket no project knows goes nowhere', () => {
    expect(resolveRoute(team, [])).toBeUndefined();
    expect(resolveRoute(team, [t('api')])).toEqual({ projectId: 'api' });
  });
});
