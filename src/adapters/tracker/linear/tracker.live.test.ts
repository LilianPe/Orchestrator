import { describe } from 'vitest';
import { describeTrackerContract } from '../../../../test/contracts/tracker.contract.js';
import { LinearApi } from './api.js';
import { Q } from './queries.js';
import { LinearTracker } from './tracker.js';

const token = process.env['FACTORY_LIVE_LINEAR_TOKEN'];
const issue = process.env['FACTORY_LIVE_LINEAR_ISSUE'];
const delegated = process.env['FACTORY_LIVE_LINEAR_DELEGATED'];
const notDelegated = process.env['FACTORY_LIVE_LINEAR_NOT_DELEGATED'];

const api = new LinearApi(async () => token!);
let appUserId: Promise<string> | undefined;
// The token is the app's: its viewer is the user tickets are delegated to.
const viewer = () => (appUserId ??= api.gql<{ viewer: { id: string } }>(Q.viewer).then((r) => r.viewer.id));

// Read-only on purpose: the write cases would move, label and comment a real ticket.
describe.skipIf(!token || !issue)('LinearTracker against the live API', () => {
  describeTrackerContract('LinearTracker (live, read-only)', async () => ({
    tracker: new LinearTracker(api, await viewer()),
    issue: issue!,
    missing: `${issue!.split('-')[0]}-999999`,
    searchTerm: process.env['FACTORY_LIVE_LINEAR_SEARCH'],
    delegation: delegated && notDelegated ? { teamKey: delegated.split('-')[0]!, delegated, notDelegated } : undefined,
  }));
});
