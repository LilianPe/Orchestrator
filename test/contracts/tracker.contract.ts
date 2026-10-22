import { describe, expect, it } from 'vitest';
import type { Tracker } from '../../src/adapters/tracker/types.js';
import { caseFor } from './gaps.js';

/** What the implementation under test arranged for the suite. Docs: docs/ports/tracker.md. */
export interface TrackerSubject {
  tracker: Tracker;
  /** An existing issue. */
  issue: string;
  /** An identifier of the same team that does not exist. */
  missing: string;
  /** A word of the issue's title that `search` finds; absent, the search case is skipped. */
  searchTerm?: string;
  /** Two state names of the issue's team; required by the write cases. */
  states?: [string, string];
  /** Write cases run only when true: never against a shared workspace. */
  writable: boolean;
  /** A team with one issue delegated to the app and one not; absent, the delegation case is skipped. */
  delegation?: { teamKey: string; delegated: string; notDelegated: string };
}

export type TrackerGap = 'moveTo-unknown-state';

export function describeTrackerContract(name: string, make: () => TrackerSubject | Promise<TrackerSubject>, gaps?: TrackerGap[]): void {
  const writable = async (skip: () => void) => {
    const s = await make();
    if (!s.writable || !s.states) skip();
    return s as TrackerSubject & { states: [string, string] };
  };

  describe(`Tracker contract: ${name}`, () => {
    it('getIssue returns the issue, its team being the identifier prefix', async () => {
      const s = await make();
      const issue = await s.tracker.getIssue(s.issue);
      expect(issue.identifier).toBe(s.issue);
      expect(issue.teamKey).toBe(s.issue.split('-')[0]);
      expect(issue.stateName).not.toBe('');
      expect(Array.isArray(issue.labels)).toBe(true);
    });

    it('getIssue returns a snapshot the caller may mutate', async () => {
      const s = await make();
      const first = await s.tracker.getIssue(s.issue);
      const labels = [...first.labels];
      first.labels.push('mutated-by-caller');
      first.stateName = 'mutated-by-caller';
      const again = await s.tracker.getIssue(s.issue);
      expect(again.labels).toEqual(labels);
      expect(again.stateName).not.toBe('mutated-by-caller');
    });

    it('rejects every call on an unknown issue', async () => {
      const s = await make();
      const state = (await s.tracker.getIssue(s.issue)).stateName;
      await expect(s.tracker.getIssue(s.missing)).rejects.toThrow();
      await expect(s.tracker.moveTo(s.missing, state)).rejects.toThrow();
      await expect(s.tracker.setLabels(s.missing, ['x'], [])).rejects.toThrow();
      await expect(s.tracker.comment(s.missing, 'x')).rejects.toThrow();
      await expect(s.tracker.ensureSession(s.missing)).rejects.toThrow();
    });

    it('search finds the issue by a word of its title', async (ctx) => {
      const s = await make();
      if (!s.searchTerm) ctx.skip();
      const hits = await s.tracker.search(s.searchTerm!);
      expect(hits.map((h) => h.identifier)).toContain(s.issue);
      const hit = hits.find((h) => h.identifier === s.issue)!;
      expect(hit.url).not.toBe('');
      expect(hit.stateName).not.toBe('');
    });

    it('listDelegated lists the team issues delegated to the app, and only them', async (ctx) => {
      const s = await make();
      if (!s.delegation) ctx.skip();
      const { teamKey, delegated, notDelegated } = s.delegation!;
      const ids = (await s.tracker.listDelegated(teamKey)).map((i) => i.identifier);
      expect(ids).toContain(delegated);
      expect(ids).not.toContain(notDelegated);
    });

    it('moveTo sets the state and replaying it changes nothing', async (ctx) => {
      const s = await writable(() => ctx.skip());
      const [a, b] = s.states;
      await s.tracker.moveTo(s.issue, a);
      await s.tracker.moveTo(s.issue, b);
      await s.tracker.moveTo(s.issue, b);
      expect((await s.tracker.getIssue(s.issue)).stateName).toBe(b);
    });

    caseFor(gaps, 'moveTo-unknown-state')('moveTo rejects a state the team does not have and keeps the state', async (ctx) => {
      const s = await writable(() => ctx.skip());
      await s.tracker.moveTo(s.issue, s.states[0]);
      await expect(s.tracker.moveTo(s.issue, 'No Such State 189')).rejects.toThrow();
      expect((await s.tracker.getIssue(s.issue)).stateName).toBe(s.states[0]);
    });

    it('setLabels writes the final set: replayable, unknown labels created, absent removals ignored', async (ctx) => {
      const s = await writable(() => ctx.skip());
      const before = (await s.tracker.getIssue(s.issue)).labels;
      await s.tracker.setLabels(s.issue, ['contract-a', 'contract-b'], []);
      await s.tracker.setLabels(s.issue, ['contract-c'], ['contract-a', 'contract-never-set']);
      await s.tracker.setLabels(s.issue, ['contract-c'], ['contract-a', 'contract-never-set']);
      const labels = (await s.tracker.getIssue(s.issue)).labels;
      expect([...labels].sort()).toEqual([...new Set([...before, 'contract-b', 'contract-c'])].sort());
    });

    it('comment, ensureSession, activity and addExternalUrl resolve on an existing issue', async (ctx) => {
      const s = await writable(() => ctx.skip());
      await s.tracker.comment(s.issue, 'Commentaire de la suite de conformité.');
      const session = await s.tracker.ensureSession(s.issue);
      expect(session).toEqual(expect.any(String));
      expect(session).not.toBe('');
      for (const type of ['thought', 'response', 'elicitation', 'error'] as const) await s.tracker.activity(session, { type, body: type });
      await s.tracker.activity(session, { type: 'action', action: 'Lecture', parameter: 'README.md', result: 'ok', ephemeral: true });
      await s.tracker.addExternalUrl(session, 'Pull request', 'https://github.test/pr/1');
    });
  });
}
