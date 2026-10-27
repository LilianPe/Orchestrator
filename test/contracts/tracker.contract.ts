import { expect } from 'vitest';
import type { ActivityInput, Tracker } from '../../src/adapters/tracker/types.js';
import { describeContract, subjectWith, type ContractOptions } from './cases.js';

/** What the implementation under test arranged for the suite. Docs: docs/ports/tracker.md. */
export interface TrackerSubject {
  tracker: Tracker;
  /** An existing issue. */
  issue: string;
  /** An identifier of the same team that does not exist. */
  missing: string;
  /** A word of the issue's title that `search` finds; absent, the search case is skipped. */
  searchTerm?: string;
  /** Two state names of the issue's team. The write cases run only when given: never against a shared workspace. */
  states?: [string, string];
  /** A team with one issue delegated to the app and one not; absent, the delegation case is skipped. */
  delegation?: { teamKey: string; delegated: string; notDelegated: string };
  /** Reads back what `comment`, `ensureSession`, `activity` and `addExternalUrl` wrote, which the port cannot; absent, the effects cases are skipped. */
  written?: {
    comments: (issue: string) => Promise<string[]>;
    /** The agent sessions open on the issue. */
    sessions: (issue: string) => Promise<string[]>;
    activities: (session: string) => Promise<ActivityInput[]>;
    externalUrls: (session: string) => Promise<{ label: string; url: string }[]>;
  };
}

export function describeTrackerContract(name: string, make: () => TrackerSubject | Promise<TrackerSubject>, options?: ContractOptions): void {
  describeContract(`Tracker contract: ${name}`, options, (it) => {

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

    it('getIssue rejects an unknown issue', async () => {
      const s = await make();
      await expect(s.tracker.getIssue(s.missing)).rejects.toThrow();
    });

    it('every write rejects an unknown issue', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'states');
      const state = (await s.tracker.getIssue(s.issue)).stateName;
      await expect(s.tracker.moveTo(s.missing, state)).rejects.toThrow();
      await expect(s.tracker.setLabels(s.missing, ['x'], [])).rejects.toThrow();
      await expect(s.tracker.comment(s.missing, 'x')).rejects.toThrow();
      await expect(s.tracker.ensureSession(s.missing)).rejects.toThrow();
    });

    it('search finds the issue by a word of its title', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'searchTerm');
      const hits = await s.tracker.search(s.searchTerm);
      expect(hits.map((h) => h.identifier)).toContain(s.issue);
      const hit = hits.find((h) => h.identifier === s.issue)!;
      expect(hit.url).not.toBe('');
      expect(hit.stateName).not.toBe('');
    });

    it('listDelegated lists the team issues delegated to the app, and only them', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'delegation');
      const { teamKey, delegated, notDelegated } = s.delegation;
      // An issue of another team, or one that does not exist, would never be listed: « only them » would check nothing.
      expect((await s.tracker.getIssue(notDelegated)).teamKey).toBe(teamKey);
      const listed = await s.tracker.listDelegated(teamKey);
      const ids = listed.map((i) => i.identifier);
      expect(ids).toContain(delegated);
      expect(ids).not.toContain(notDelegated);
      expect(listed.every((i) => i.teamKey === teamKey)).toBe(true);
    });

    it('moveTo sets the state and replaying it changes nothing', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'states');
      const [a, b] = s.states;
      await s.tracker.moveTo(s.issue, a);
      await s.tracker.moveTo(s.issue, b);
      await s.tracker.moveTo(s.issue, b);
      expect((await s.tracker.getIssue(s.issue)).stateName).toBe(b);
    });

    it('moveTo rejects a state the team does not have and keeps the state', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'states');
      await s.tracker.moveTo(s.issue, s.states[0]);
      await expect(s.tracker.moveTo(s.issue, 'No Such State 189')).rejects.toThrow();
      expect((await s.tracker.getIssue(s.issue)).stateName).toBe(s.states[0]);
    });

    it('setLabels writes the final set: replayable, unknown labels created, absent removals ignored', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'states');
      const before = (await s.tracker.getIssue(s.issue)).labels;
      await s.tracker.setLabels(s.issue, ['contract-a', 'contract-b'], []);
      await s.tracker.setLabels(s.issue, ['contract-c'], ['contract-a', 'contract-never-set']);
      await s.tracker.setLabels(s.issue, ['contract-c'], ['contract-a', 'contract-never-set']);
      const labels = (await s.tracker.getIssue(s.issue)).labels;
      expect([...labels].sort()).toEqual([...new Set([...before, 'contract-b', 'contract-c'])].sort());
    });

    it('comment, ensureSession, activity and addExternalUrl resolve on an existing issue', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'states');
      await s.tracker.comment(s.issue, 'Commentaire de la suite de conformité.');
      const session = await s.tracker.ensureSession(s.issue);
      expect(session).toEqual(expect.any(String));
      expect(session).not.toBe('');
      for (const type of ['thought', 'response', 'elicitation', 'error'] as const) await s.tracker.activity(session, { type, body: type });
      await s.tracker.activity(session, { type: 'action', action: 'Lecture', parameter: 'README.md', result: 'ok', ephemeral: true });
      await s.tracker.addExternalUrl(session, 'Pull request', 'https://github.test/pr/1');
    });

    it('ensureSession opens an agent session on the issue', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'states', 'written');
      const session = await s.tracker.ensureSession(s.issue);
      expect(await s.written.sessions(s.issue)).toContain(session);
    });

    it('comment, activity and addExternalUrl write their effect; replaying comment or activity writes it again', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'states', 'written');
      const body = 'Commentaire rejoué de la suite de conformité.';
      const before = (await s.written.comments(s.issue)).filter((c) => c === body).length;
      await s.tracker.comment(s.issue, body);
      await s.tracker.comment(s.issue, body);
      expect((await s.written.comments(s.issue)).filter((c) => c === body).length - before).toBe(2);

      const session = await s.tracker.ensureSession(s.issue);
      const activities: ActivityInput[] = [
        ...(['thought', 'response', 'elicitation', 'error'] as const).map((type) => ({ type, body: `Activité ${type}.` })),
        { type: 'action', action: 'Lecture', parameter: 'README.md', result: 'ok', ephemeral: true },
        { type: 'action', action: 'Écriture', parameter: 'src/a.ts' },
      ];
      for (const a of [...activities, activities[0]!]) await s.tracker.activity(session, a);
      expect((await s.written.activities(session)).slice(-7)).toEqual([...activities, activities[0]]);

      await s.tracker.addExternalUrl(session, 'Pull request', 'https://github.test/pr/1');
      expect(await s.written.externalUrls(session)).toContainEqual({ label: 'Pull request', url: 'https://github.test/pr/1' });
    });

  });
}
