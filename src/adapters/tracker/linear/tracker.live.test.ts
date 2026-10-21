import { describe } from 'vitest';
import { describeTrackerContract } from '../../../../test/contracts/tracker.contract.js';
import { LinearApi } from './api.js';
import { LinearTracker } from './tracker.js';

const token = process.env['RELAIS_LIVE_LINEAR_TOKEN'];
const issue = process.env['RELAIS_LIVE_LINEAR_ISSUE'];

// Read-only on purpose: the write cases would move, label and comment a real ticket.
describe.skipIf(!token || !issue)('LinearTracker against the live API', () => {
  describeTrackerContract('LinearTracker (live, read-only)', () => ({
    tracker: new LinearTracker(new LinearApi(async () => token!), 'relais-contract'),
    issue: issue!,
    missing: `${issue!.split('-')[0]}-999999`,
    searchTerm: process.env['RELAIS_LIVE_LINEAR_SEARCH'],
    writable: false,
  }));
});
