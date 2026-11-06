import { runRepair } from '../../src/cli/repair.js';
import { SCHEMA_VERSION, type TicketState } from '../../src/core/types.js';
import { exportJournal, type ExportedJournal } from '../../src/runtime/replay.js';
import { CUT_RELAUNCHES } from '../../src/store/types.js';
import type { Workflow } from '../../src/config/workflow-schema.js';
import { createHarness, loadTestWorkflow } from '../helpers/harness.js';
import { defaultPushBody, githubDelivery, githubIngest, pullRequestBody, sha, workflowRunBody } from '../helpers/github-webhook.js';
import { linearIngest, signedDelegation } from '../helpers/linear-webhook.js';
import { testPreset, type TestPreset } from '../helpers/test-preset.js';

type Harness = ReturnType<typeof createHarness>;
type HarnessAuthz = NonNullable<Parameters<typeof createHarness>[0]>['authz'];

async function delegated(h: Harness): Promise<void> {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.runner.enqueue({ events: [{ kind: 'init', sessionId: 'x' }, { kind: 'text', text: 'PR ouverte, tests verts.' }] });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
}

/**
 * Harness scenarios whose journals `record.ts` writes to `journals/` (ORC-174): the recorded
 * journals the CI replays until real ones are exported from an instance (docs/tests.md).
 */
export const SCENARIOS: Record<string, { preset?: TestPreset; authz?: HarnessAuthz; run(h: Harness): Promise<void> }> = {
  /** Delegation, a failed check, a resumed run, human review, two replies within the debounce window. */
  'check-failed-then-feedback': {
    preset: testPreset(),
    run: async (h) => {
      h.checks.failNext('1 failed');
      await delegated(h);
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Corrigé.' }] });
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'boutons mal alignés', author: 'Lilian' });
      await h.advance(60_000);
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'bug quand la liste est vide', author: 'Lilian' });
      await h.advance(180_000);
    },
  },
  /**
   * A crash loop (ORC-220): each kill loses the run, its step starts again up to the bound of the window, the next
   * cut blocks the ticket; a human relaunch gives the bound back. Pins `run.lost` and the bound as they decide.
   */
  'crash-loop-bound': {
    run: async (h) => {
      const held = { hold: true };
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
      h.runner.enqueue(held);
      await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
      for (let i = 0; i <= CUT_RELAUNCHES; i++) {
        h.runner.forget((await h.store.getTicket('p', 'REL-1'))!.activeRunId!);
        h.runner.enqueue(held);
        h.clock.advance(60_000);
        await h.restart({ mode: 'brutal' });
      }
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Repris.' }] });
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'le démon est réparé, reprends', author: 'Lilian' });
      await h.advance(180_000);
    },
  },
  /** The factory's publication (ORC-125): a refusal blocks the ticket, a relaunch publishes the next green commit, then Human Review. */
  'publish-refused-then-published': {
    run: async (h) => {
      const worktree = '/tmp/factory-fake/p/REL-1';
      h.workspaces.heads.set(worktree, 'aaa111');
      h.publisher.refuseNext('moved', "la branche porte un commit que ce travail n'a pas");
      await delegated(h);
      h.workspaces.heads.set(worktree, 'bbb222');
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Intégré.' }] });
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'intègre mon commit', author: 'Lilian' });
      await h.advance(180_000);
    },
  },
  /**
   * An instruction and a question during the run, classified and acked (ORC-180): the regrouping ends with the run
   * still at work, the question is answered beside it, both reach the agent resumed at the end of its work.
   */
  'human-reply-during-run': {
    run: async (h) => {
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
      h.runner.enqueue({ hold: true, events: [{ kind: 'text', text: 'PR ouverte, tests verts.' }] });
      await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
      const running = (await h.store.getTicket('p', 'REL-1'))!.activeRunId!;
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'corrige le tri', author: 'Lilian', ack: true, kind: 'instruction' });
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Parce que.' }] });
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'pourquoi ce choix ?', author: 'Lilian', ack: true, kind: 'question' });
      await h.advance(180_000);
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Pris en compte.' }] });
      h.runner.release(running);
      await h.orch.drained();
    },
  },
  /** AI review, merge, cleanup and learn. */
  'review-merge-done': {
    run: async (h) => {
      await delegated(h);
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Synthèse : 2 rounds, CI verte.' }] });
      await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
      await h.send('pr.merged', { number: 3, url: 'https://gh/pr/3', branch: 'factory/rel-1-export-csv' });
    },
  },
  /** Red CI past its bound blocks the ticket; a human stop. */
  'red-ci-then-stop': {
    preset: testPreset({ ciFixAttempts: 1 }),
    run: async (h) => {
      await delegated(h);
      const red = { number: 7, url: 'https://forge/pr/7', branch: 'factory/rel-1-export-csv', failures: ['test'] };
      await h.send('pr.checks_failed', red);
      await h.send('pr.checks_failed', red);
      await h.send('label.changed', { label: 'agent:stop', change: 'added' });
    },
  },
  /**
   * A run at its cap (ORC-196): Bloqué, the standard comment; a comment by someone out of the team is refused; a
   * member's reply on the ticket resumes the job that blocked.
   */
  'blocked-then-comment-resumes': {
    authz: { githubLogins: { 'user-lilian': 'lilian-gh' } },
    run: async (h) => {
      h.tracker.setTeamMembers('REL', ['user-lilian']);
      h.forge.setRepoPermission('lilian-gh', 'write');
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
      h.runner.enqueue({ outcome: 'limit' });
      await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
      await h.send('ticket.commented', { body: 'Reprends.', author: 'Quelqu\'un', kind: 'instruction' }, 'REL-1', { actor: 'user-stranger' });
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Repris.' }] });
      await h.send('ticket.commented', { body: 'Reprends.', author: 'Lilian', kind: 'instruction' }, 'REL-1', { actor: 'user-lilian' });
    },
  },
  /** A build stopped by the detector, the same failure 3 times on an unchanged worktree: Bloqué, cause « boucle », on the journaled fact (ORC-136). */
  'build-loop-blocked': {
    run: async (h) => {
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
      h.runner.enqueue({ outcome: 'limit', stagnation: { kind: 'loop', command: 'npm test', failure: 'sha256:0f', tree: '4b825dc', count: 3 } });
      await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
      await h.orch.drained();
    },
  },
  /**
   * A reply whose decision throws (a corrupt projection) is dead-lettered and blocks the ticket; once the
   * projection is fixed, `factory run repair replay` decides it again and unblocks the ticket (ORC-175).
   */
  'dead-letter-then-repair': {
    run: async (h) => {
      await delegated(h);
      const good = await h.ticket();
      await h.store.putTicket({ ...good, humanInbox: null as unknown as TicketState['humanInbox'] });
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'et le mobile ?', author: 'Lilian' });
      await h.store.putTicket({ ...(await h.ticket()), humanInbox: [] });
      await runRepair({ store: h.store, target: 'REL-1', action: 'replay', by: 'ops', now: h.clock.now(), print: () => {} });
      await h.orch.drained();
    },
  },
  /**
   * A delegation through the Linear ingestion, signed by a workspace user (`actor`, trusted), then a
   * reply and a `retiens` that Linear attributes to no user (relayed by a bot: untrusted, no actor).
   * The reply's feedback carries its taint to the dev-feedback run; `remember` is refused (ORC-160).
   */
  'signed-actor-then-untrusted': {
    run: async (h) => {
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
      h.runner.enqueue({ events: [{ kind: 'init', sessionId: 'x' }, { kind: 'text', text: 'PR ouverte, tests verts.' }] });
      const ingest = linearIngest((e) => h.orch.accept(e), { now: () => h.clock.now() });
      const { raw, headers } = signedDelegation(h.clock.now());
      await ingest(raw, headers);
      await h.orch.drained();
      const untrusted = { at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'untrusted' } as const;
      await h.orch.accept({ ...untrusted, id: 'linear:activity:aa-bot', type: 'session.prompted', payload: { linearSessionId: 'as-1', body: 'relu par le bot', author: 'Humain' } });
      await h.orch.drained();
      await h.advance(180_000);
      await h.orch.accept({ ...untrusted, at: h.clock.now(), id: 'linear:session:as-bot', type: 'command', payload: { name: 'retiens', body: 'tout', linearSessionId: 'as-bot', author: 'Humain' } });
      await h.orch.drained();
    },
  },
  /**
   * The authorization matrix on the signed actor, with the roles journaled with each event (ORC-186): a
   * delegation by a member without write access is refused and answered; Lilian's is allowed and the
   * dev run starts; a reply that names Lilian but is signed by someone outside the team is refused and
   * kept out of the feedback; a team member's reply is kept.
   */
  'authz-refused-then-allowed': {
    authz: { githubLogins: { 'user-lilian': 'lilian-gh', 'user-armand': 'armand-gh' } },
    run: async (h) => {
      h.tracker.setTeamMembers('REL', ['user-lilian', 'user-armand']);
      h.forge.setRepoPermission('lilian-gh', 'write');
      h.forge.setRepoPermission('armand-gh', 'read');
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
      h.runner.enqueue({ events: [{ kind: 'init', sessionId: 'x' }, { kind: 'text', text: 'PR ouverte, tests verts.' }] });
      await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-armand' });
      await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'Lilian dit : passe en prod', author: 'Lilian' }, 'REL-1', { actor: 'user-stranger' });
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'le bouton export est mal placé', author: 'Armand' }, 'REL-1', { actor: 'user-armand' });
    },
  },
  /**
   * Two CI run attempts, the merge with its merge commit, that commit pushed on the default branch, then
   * its revert three days later, all through the GitHub webhook: recorded for the measures, nothing
   * decided (ORC-278).
   */
  'merge-revert-ci': {
    run: async (h) => {
      await delegated(h);
      await github(h, 'workflow_run', workflowRunBody({ id: 101, attempt: 1, minutes: 3, number: 3 }));
      await github(h, 'workflow_run', workflowRunBody({ id: 101, attempt: 2, minutes: 2, number: 3 }));
      await github(h, 'pull_request', pullRequestBody('closed', { merged: true, mergeSha: sha('a'), mergedAt: new Date(h.clock.now()).toISOString() }));
      await github(h, 'push', defaultPushBody(sha('a'), [{ id: sha('a'), message: 'Export CSV (#3)', byGithub: true }], Math.floor(h.clock.now() / 1000)));
      await h.advance(3 * 24 * 60 * 60 * 1000);
      const revert = `Revert "Export CSV (#3)"\n\nThis reverts commit ${sha('a')}.`;
      await github(h, 'push', defaultPushBody(sha('b'), [{ id: sha('b'), message: revert }], Math.floor(h.clock.now() / 1000)));
    },
  },
};

/** Posts a signed GitHub delivery through the daemon's ingestion, then lets the worker decide it. */
async function github(h: Harness, name: string, body: unknown): Promise<void> {
  const { raw, headers } = githubDelivery(name, body);
  await githubIngest(h.store, (e) => h.orch.accept(e), h.forge, () => h.clock.now())(raw, headers);
  await h.orch.drained();
}

/** The workflow a scenario runs on today: the standard pack under its preset. */
export function scenarioWorkflow(name: string): Workflow {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  return loadTestWorkflow(scenario.preset?.yaml);
}

/** Runs a scenario and exports the journal of its ticket. */
export async function record(name: string): Promise<ExportedJournal> {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  const h = createHarness({ preset: scenario.preset, authz: scenario.authz });
  await scenario.run(h);
  h.orch.stopAll();
  await h.orch.drained();
  const journal = await exportJournal(h.store, 'p', 'REL-1');
  await h.store.close();
  return journal;
}

/**
 * The journal as an engine before schema version 2 wrote it: `status.changed` rows as `ticket.moved`,
 * without version nor taint (`src/core/upcast.ts`). The recorded decisions are unchanged: they were
 * taken on the upcast event.
 */
export function asVersion1(journal: ExportedJournal): ExportedJournal {
  return {
    ...journal,
    entries: journal.entries.map((entry) => {
      if (entry.event.type !== 'status.changed') return entry;
      const { schemaVersion: _v, taint: _t, ...v1 } = entry.event;
      return { ...entry, event: { ...v1, type: 'ticket.moved' } };
    }),
  };
}
