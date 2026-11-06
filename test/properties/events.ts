import fc from 'fast-check';
import { REFREEZE, type FrozenTests } from '../../src/checks/freeze.js';
import type { Role } from '../../src/core/authz.js';
import {
  LOGICAL_STATES,
  TRUSTED,
  type EventPayloads,
  type EventType,
  type FactoryEvent,
  type IssueSnapshot,
  type PrPayload,
  type ShellEvent,
} from '../../src/core/types.js';

/**
 * Generator of event sequences for the property tests of `decide` (ORC-173).
 *
 * A sequence is one ticket's inbox as the orchestrator would see it: external events (`FactoryEvent`,
 * deduplicated by id) interleaved with the facts the orchestrator records around the effects it carries
 * out (`ShellEvent`: a run started, a pending job set…). Values are drawn from small pools so that run
 * ids, sessions and jobs collide often: a `run.finished` meets the active run, a stale one, or none.
 * Once built, the sequence is reordered (adjacent swaps, sometimes a full shuffle) and then gets
 * duplicates: copies of external events, same id, inserted anywhere after their original.
 */

export const PROJECT = 'p';
export const TICKET = 'REL-1';
export const DEV_SESSION = 's-dev';
const RUN_IDS = ['r1', 'r2', 'r3'] as const;
/** Every job of the standard pack, plus one the workflow does not know. */
const JOBS = ['dev', 'tests', 'dev-feedback', 'fix-ci', 'review', 'ask', 'learn', 'remember', 'unknown'] as const;
const DEV_JOBS = ['dev', 'tests', 'dev-feedback', 'fix-ci', 'review'] as const;
export const VERIFY_FAILURES = [{ command: 'fake:check', exitCode: 1, output: 'rouge' }];
/** Freezes the red check reads, or a `/refreeze` (ORC-131): they share a file, with another fingerprint. */
const FREEZES: readonly FrozenTests[] = [
  { sha: 'aaa', files: { 'a.test.ts': '1', 'vitest.config.ts': '1' } },
  { sha: 'bbb', files: { 'a.test.ts': '2', 'b.test.ts': '1' } },
];
const frozen = fc.constantFrom(undefined, ...FREEZES);

export type Entry = { kind: 'external'; event: FactoryEvent } | { kind: 'shell'; event: ShellEvent };

/** An external event before it gets its id, time and taint. */
type Draft = { [K in EventType]: { type: K; payload: EventPayloads[K] } }[EventType];
/** `signed`: the signed actor and the roles the orchestrator resolved for it (ORC-186); absent, the event is not checked. */
type Signed = { actor?: string; roles: readonly Role[] };
type DraftEntry = { kind: 'external'; draft: Draft; untrusted: boolean; signed?: Signed } | { kind: 'shell'; event: ShellEvent };

const session = fc.constantFrom(DEV_SESSION, 's-q1', 's-q2');
const author = fc.constantFrom('lilian', 'armand');
const body = fc.constantFrom('ok', 'boutons mal alignés', 'et pour mobile ?');
const runId = fc.constantFrom(...RUN_IDS);
const job = fc.constantFrom(...JOBS);
const logical = fc.constantFrom(...LOGICAL_STATES);
const issue: fc.Arbitrary<IssueSnapshot> = fc.record({ title: fc.constant('Titre'), logical, priority: fc.integer({ min: 0, max: 2 }) });
const pr: fc.Arbitrary<PrPayload> = fc.integer({ min: 1, max: 2 }).map((n) => ({ number: n, url: `https://forge/pr/${n}`, branch: 'agent/rel-1' }));
const empty = fc.constant({} as Record<string, never>);
/** The result of an outbox effect (ORC-150): of a decided event's effect, or of the error notice a dead effect posted. */
const effectResult = fc.record({
  effectId: fc.constantFrom('REL-1:1:1', 'REL-1:2:1'),
  kind: fc.constantFrom('comment', 'labels', 'start_run', 'activity', 'settle'),
  eventId: fc.constantFrom('ex-1', 'effect:REL-1:1:1'),
  attempts: fc.constantFrom(1, 8),
});
/** The event a dead letter is about (ORC-175): a creating one, a human's status change, a merge, a run's end. */
const DEAD_ID = 'dead-1';
const deadEvent = (type: EventType, payload: unknown): FactoryEvent =>
  ({ ...TRUSTED, id: DEAD_ID, type, at: 0, projectId: PROJECT, ticketId: TICKET, payload }) as FactoryEvent;
const deadLettered: fc.Arbitrary<FactoryEvent> = fc.constantFrom(
  deadEvent('ticket.delegated', { linearSessionId: DEV_SESSION, issue: { title: 'Titre', logical: 'todo', priority: 0 } }),
  deadEvent('status.changed', { from: 'dev', to: 'human_review' }),
  deadEvent('pr.merged', { number: 1, url: 'https://forge/pr/1', branch: 'agent/rel-1' }),
  deadEvent('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 0.5, turns: 3, lastText: 'fini' }),
);
const repair: fc.Arbitrary<EventPayloads['dead_letter.repaired']> = fc
  .record({ action: fc.constantFrom('replay' as const, 'skip' as const, 'force' as const), event: deadLettered })
  .map(({ action, event }) => ({ eventId: DEAD_ID, action, by: 'ops', event }));

/** The debounce of the feedback job firing: what a reply in the dev session arms. */
export const DEBOUNCE: EventPayloads['timer.fired'] = { kind: 'debounce', payload: { job: 'dev-feedback' } };

/**
 * A timer firing (ORC-161): mostly a debounce, sometimes a clarify reminder or block or a usage-limit
 * reset, which no rule decides yet (ORC-210, ORC-215).
 */
const timerFired: fc.Arbitrary<EventPayloads['timer.fired']> = fc.oneof(
  { arbitrary: fc.record({ job }).map((payload) => ({ kind: 'debounce' as const, payload })), weight: 3 },
  { arbitrary: fc.record({ linearSessionId: session }).map((payload) => ({ kind: 'clarify.remind' as const, payload })), weight: 1 },
  { arbitrary: fc.record({ linearSessionId: session }).map((payload) => ({ kind: 'clarify.expire' as const, payload })), weight: 1 },
  { arbitrary: fc.constant({ kind: 'usage.reset' as const, payload: {} }), weight: 1 },
);

/** One arbitrary per event type: adding an event type to `EventPayloads` fails to compile until it is generated here. */
const PAYLOADS: { [K in EventType]: fc.Arbitrary<EventPayloads[K]> } = {
  'ticket.delegated': fc.record({ linearSessionId: fc.option(session, { nil: undefined }), issue }),
  'ticket.undelegated': empty,
  'session.mentioned': fc.record({ linearSessionId: session, body, author, issue }),
  'session.prompted': fc.record({ linearSessionId: session, body, author, issue }),
  'ticket.commented': fc.record({ body, author }),
  'agent.asked': fc.record({ question: body, job: fc.constantFrom('dev', 'dev-feedback') }),
  'session.stopped': fc.record({ linearSessionId: fc.option(session, { nil: undefined }) }),
  'status.changed': fc.record({ from: fc.option(logical, { nil: null }), to: fc.option(logical, { nil: null }) }),
  'label.changed': fc.record({ label: fc.constantFrom('agent:reprendre', 'agent:stop', 'bug'), change: fc.constantFrom('added' as const, 'removed' as const) }),
  'push.human': fc.record({ branch: fc.constant('agent/rel-1'), sha: fc.constantFrom('aaa', 'bbb'), author }),
  command: fc
    .record({ name: fc.constantFrom('retiens', 'fais-le', 'autre', REFREEZE), body, linearSessionId: session, author, issue, frozen })
    .map(({ frozen: f, ...c }) => (f && c.name === REFREEZE ? { ...c, frozen: f } : c)),
  'pr.opened': pr,
  'pr.checks_passed': pr,
  'pr.checks_failed': pr.map((p) => ({ ...p, failures: ['test'] })),
  // With or without the merge and head commits (ORC-278): rows from before it, and the poller with `gh`, lack them.
  'pr.merged': fc.record({ pr, shas: fc.constantFrom({}, { headSha: 'aaa' }, { mergeSha: 'ccc', headSha: 'aaa' }) }).map(({ pr: p, shas }) => ({ ...p, ...shas })),
  'pr.closed': pr,
  'pr.reviewed': fc.record({ pr, kind: fc.constantFrom('review' as const, 'comment' as const), author, body }).map(({ pr: p, ...r }) => ({ ...p, ...r })),
  'pr.conflicted': pr.map((p) => ({ ...p, headSha: 'aaa', baseRef: 'main' })),
  'pr.merge_refused': pr.chain((p) => fc.constantFrom({ ...p, reason: 'la branche a reçu un push depuis la review', headMoved: true }, { ...p, reason: 'GitHub refuse le merge (conflit)', headMoved: false })),
  'publish.done': fc.record({ runId: fc.constant('r1'), job, sha: fc.constantFrom('aaa', 'bbb') }),
  'publish.refused': fc.record({ runId: fc.constant('r1'), job, sha: fc.constantFrom('aaa', 'bbb'), reason: fc.constant('la branche a bougé') }),
  // A push on the default branch that lands or reverts one of the ticket's PRs, and a CI run attempt (ORC-278).
  'default_branch.pushed': fc
    .record({ number: fc.integer({ min: 1, max: 2 }), relation: fc.constantFrom('merges' as const, 'reverts' as const), pushedAt: fc.option(fc.constant(5_000), { nil: undefined }) })
    .map(({ number, relation, pushedAt }) => ({
      branch: 'main',
      before: 'b0',
      after: 'b1',
      ...(pushedAt === undefined ? {} : { pushedAt }),
      commits: [{ sha: 'ddd', message: relation === 'merges' ? `Titre (#${number})` : `Revert "Titre"`, author: 'lilian', [relation]: number }],
    })),
  'ci.run_completed': fc
    .record({ number: fc.option(fc.integer({ min: 1, max: 2 }), { nil: undefined }), runId: fc.constantFrom(1, 2), attempt: fc.constantFrom(1, 2) })
    .map(({ number, runId, attempt }) => ({
      ...(number === undefined ? {} : { number }),
      branch: 'agent/rel-1',
      headSha: 'aaa',
      runId,
      attempt,
      workflow: 'ci',
      conclusion: 'success',
      startedAt: 1_000,
      completedAt: 61_000,
      durationMs: 60_000,
    })),
  'run.finished': fc.record({
    runId,
    job,
    outcome: fc.constantFrom('success' as const, 'failure' as const, 'stopped' as const, 'limit' as const),
    costUsd: fc.constantFrom(0, 0.5),
    turns: fc.constant(3),
    lastText: fc.constant('fini'),
  })
    // The closed outcome of ORC-289, absent on rows written before it; a blocked one carries its question.
    .chain((p) =>
      fc.constantFrom(undefined, 'succeeded', 'failed', 'noop', 'needs_input', 'timeout', 'spec_impossible', 'errored' as const).map((attempt) =>
        attempt === undefined
          ? p
          : {
              ...p,
              attempt,
              ...(attempt === 'needs_input' || attempt === 'spec_impossible'
                ? { output: { status: 'blocked' as const, summary: 's', question: 'pourquoi ?', ...(attempt === 'spec_impossible' ? { reason: attempt } : {}), tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] } }
                : {}),
            },
      ),
    ),
  'verify.passed': fc.record({ runId, job }),
  'verify.failed': fc.record({ runId, job, failures: fc.constant(VERIFY_FAILURES) }),
  'run.lost': fc.record({ runId, job, cause: fc.constantFrom('restart' as const, 'lease' as const) }),
  'verify.lost': fc.record({ runId, job }),
  'verify.errored': fc.record({ runId, job, error: fc.constant('engine down') }),
  'timer.fired': timerFired,
  'control.pause': empty,
  'control.resume': empty,
  'control.stop': empty,
  'effect.done': effectResult,
  'effect.failed': effectResult.map((r) => ({ ...r, error: 'Linear down' })),
  'dead_letter.added': deadLettered.map((e) => ({ eventId: e.id, eventType: e.type, error: 'boom', failures: 1 })),
  'dead_letter.repaired': repair,
};

const EVENT_TYPES = Object.keys(PAYLOADS) as EventType[];

function draftOf<K extends EventType>(type: K): fc.Arbitrary<Draft> {
  return (PAYLOADS[type] as fc.Arbitrary<EventPayloads[K]>).map((payload) => ({ type, payload }) as Draft);
}

const anyDraft: fc.Arbitrary<Draft> = fc.oneof(...EVENT_TYPES.map((t) => draftOf(t)));

/**
 * Who signed a human event and the roles resolved for them (ORC-186), one time in three: a member who
 * can write and merge (`u-dev`, who signs the opening delegation one time in four: the requester then),
 * a member without GitHub rights, a GitHub writer outside the team, someone with no role, or no actor
 * at all. The other events carry no roles, as those journaled before ORC-186, and keep exercising the
 * rest of `decide` unchecked.
 */
export const ACTORS: Readonly<Record<string, readonly Role[]>> = {
  'u-none': [],
  'u-dev': ['team_member', 'repo_writer', 'repo_merger'],
  'u-member': ['team_member'],
  'u-out': ['repo_writer'],
  'u-lead': ['team_member', 'maintainer'],
};
/** Events a human sends through Linear: the orchestrator may resolve roles for them (`mayCheck`). */
const HUMAN: ReadonlySet<EventType> = new Set<EventType>(['ticket.delegated', 'session.mentioned', 'command', 'session.prompted', 'ticket.commented', 'label.changed', 'status.changed']);
const signedBy: fc.Arbitrary<Signed | undefined> = fc.oneof(
  { arbitrary: fc.constant(undefined), weight: 6 },
  { arbitrary: fc.constantFrom(...Object.keys(ACTORS)).map((actor): Signed => ({ actor, roles: ACTORS[actor]! })), weight: 2 },
  { arbitrary: fc.constant<Signed>({ roles: [] }), weight: 1 },
);

/**
 * Events the factory produces itself (its runner, its checks, its timers, its UI): always trusted, as
 * their producers stamp them `TRUSTED`. Only events that carry content from outside can be untrusted.
 */
const FACTORY_PRODUCED: ReadonlySet<EventType> = new Set<EventType>([
  'run.finished', 'run.lost', 'verify.passed', 'verify.failed', 'verify.errored', 'verify.lost', 'timer.fired', 'control.pause', 'control.resume', 'control.stop',
  'effect.done', 'effect.failed', 'dead_letter.added', 'dead_letter.repaired',
]);

/** Events the GitHub ingestion always marks untrusted: what nobody in the factory verified (ORC-134). */
const ALWAYS_UNTRUSTED: ReadonlySet<EventType> = new Set<EventType>(['push.human', 'pr.reviewed']);

/** Events of the Linear ingestion: a trusted one carries the signed user's id, an untrusted one none (ORC-160). */
const FROM_LINEAR: ReadonlySet<EventType> = new Set<EventType>([
  'ticket.delegated', 'session.mentioned', 'session.prompted', 'session.stopped', 'command', 'status.changed', 'label.changed',
]);

/**
 * One time in five untrusted, when the event can be: enough to exercise the taint rules (I12) without
 * drowning the rest. Only single events and human messages draw their taint here; the scripted
 * fragments below (attempt, verify loop, red CI, forge reports) stay trusted.
 */
const external = (draft: fc.Arbitrary<Draft>): fc.Arbitrary<DraftEntry> =>
  fc.record({ draft, roll: fc.integer({ min: 0, max: 4 }), signed: signedBy }).map(({ draft: d, roll, signed }): DraftEntry => {
    const untrusted = ALWAYS_UNTRUSTED.has(d.type) || (roll === 0 && !FACTORY_PRODUCED.has(d.type));
    if (!signed || !HUMAN.has(d.type)) return { kind: 'external', draft: d, untrusted };
    // An untrusted event has no signed actor (ORC-160): its roles, resolved for nobody, are none.
    return { kind: 'external', draft: d, untrusted, signed: untrusted ? { roles: [] } : signed };
  });

const shell: fc.Arbitrary<ShellEvent> = fc.oneof(
  fc.record({
    type: fc.constant('run.started' as const),
    runId,
    job: fc.constantFrom(...DEV_JOBS, 'ask'),
  }).map((e): ShellEvent => ({ ...e, queue: e.job === 'ask' ? 'questions' : 'dev', claudeSessionId: 'claude-1' })),
  fc.constant<ShellEvent>({ type: 'run.cleared' }),
  fc.constant<ShellEvent>({ type: 'feedback.consumed' }),
  logical.map((to): ShellEvent => ({ type: 'status.recorded', to })),
  fc.constantFrom(...DEV_JOBS).map((j): ShellEvent => ({ type: 'pending.set', job: { job: j } })),
  fc.constant<ShellEvent>({ type: 'pending.cleared' }),
  fc.constant<ShellEvent>({ type: 'session.linked', linearSessionId: DEV_SESSION }),
);

/**
 * One dev attempt as the orchestrator drives it: the run starts, finishes, and its verification
 * reports. Repeated, it walks the verify loop up to its bound (I5); with another run id in between,
 * it leaves stale results behind (I11).
 */
const attempt: fc.Arbitrary<DraftEntry[]> = fc
  .record({
    runId,
    job: fc.constantFrom(...DEV_JOBS),
    outcome: fc.constantFrom('success' as const, 'success' as const, 'failure' as const, 'limit' as const),
    verdict: fc.constantFrom('verify.failed' as const, 'verify.failed' as const, 'verify.passed' as const),
    frozen,
  })
  .map(({ runId: id, job: j, outcome, verdict, frozen: f }): DraftEntry[] => {
    const finished: Draft = { type: 'run.finished', payload: { runId: id, job: j, outcome, costUsd: 0.5, turns: 3, lastText: 'fini' } };
    // The red check of the tests step reads a freeze with its verdict (ORC-131).
    const freeze = j === 'tests' && f ? { frozen: f } : {};
    const report: Draft =
      verdict === 'verify.passed'
        ? { type: 'verify.passed', payload: { runId: id, job: j, ...freeze } }
        : { type: 'verify.failed', payload: { runId: id, job: j, failures: VERIFY_FAILURES, ...freeze } };
    return [
      { kind: 'shell', event: { type: 'run.started', runId: id, job: j, queue: 'dev', claudeSessionId: 'claude-1' } },
      ...(j !== 'dev' ? [{ kind: 'shell' as const, event: { type: 'feedback.consumed' as const } }] : []),
      { kind: 'external', draft: finished, untrusted: false },
      { kind: 'external', draft: report, untrusted: false },
    ];
  });

/**
 * The verify loop walked to its bound or past it: successful runs whose checks fail, each resumed run
 * under the next run id, sometimes ending green. The single attempts above rarely chain that far.
 */
const verifyLoop: fc.Arbitrary<DraftEntry[]> = fc
  .record({ job: fc.constantFrom('dev' as const, 'dev-feedback' as const, 'fix-ci' as const), rounds: fc.integer({ min: 1, max: 4 }), green: fc.boolean() })
  .map(({ job: j, rounds, green }) =>
    Array.from({ length: rounds }, (_, i): DraftEntry[] => {
      const id = RUN_IDS[i % RUN_IDS.length]!;
      const last = i === rounds - 1;
      const report: Draft =
        last && green
          ? { type: 'verify.passed', payload: { runId: id, job: j } }
          : { type: 'verify.failed', payload: { runId: id, job: j, failures: VERIFY_FAILURES } };
      return [
        { kind: 'shell', event: { type: 'run.started', runId: id, job: j, queue: 'dev', claudeSessionId: 'claude-1' } },
        ...(i > 0 ? [{ kind: 'shell' as const, event: { type: 'feedback.consumed' as const } }] : []),
        { kind: 'external', draft: { type: 'run.finished', payload: { runId: id, job: j, outcome: 'success', costUsd: 0.5, turns: 3, lastText: 'fini' } }, untrusted: false },
        { kind: 'external', draft: report, untrusted: false },
      ];
    }).flat(),
  );

/** The PR goes to review, then the forge reports red CI several times in a row: the red-CI loop of I5. */
const redCi: fc.Arbitrary<DraftEntry[]> = fc
  .record({ to: fc.constantFrom('human_review' as const, 'ai_review' as const), reports: fc.integer({ min: 1, max: 5 }), pr })
  .map(({ to, reports, pr: p }): DraftEntry[] => [
    { kind: 'external', draft: { type: 'status.changed', payload: { from: 'dev', to } }, untrusted: false },
    ...Array.from({ length: reports }, (): DraftEntry => ({ kind: 'external', draft: { type: 'pr.checks_failed', payload: { ...p, failures: ['test'] } }, untrusted: false })),
  ]);

/** A reply in the dev session, then the debounce it armed fires: feedback relayed by the factory's own timer (I6, I12). */
const devReply: fc.Arbitrary<Draft> = PAYLOADS['session.prompted'].map((p) => ({ type: 'session.prompted', payload: { ...p, linearSessionId: DEV_SESSION } }));
const debouncedReply: fc.Arbitrary<DraftEntry[]> = external(devReply).map((reply): DraftEntry[] => [
  reply,
  { kind: 'external', draft: { type: 'timer.fired', payload: DEBOUNCE }, untrusted: false },
]);

/** A human talks to the factory: in the dev session, in a question session, through a label. */
const human: fc.Arbitrary<Draft> = fc.oneof(draftOf('session.prompted'), draftOf('session.mentioned'), draftOf('command'), draftOf('label.changed'));
const humanFragment: fc.Arbitrary<DraftEntry[]> = external(human).map((e) => [e]);

/** The forge reports on the PR: red CI, green CI, merge, close without merge (ORC-134). */
const forge: fc.Arbitrary<DraftEntry[]> = fc
  .oneof(draftOf('pr.checks_failed'), draftOf('pr.checks_failed'), draftOf('pr.checks_passed'), draftOf('pr.opened'), draftOf('pr.merged'), draftOf('pr.closed'))
  .map((d) => [{ kind: 'external', draft: d, untrusted: false }]);

const fragment: fc.Arbitrary<DraftEntry[]> = fc.oneof(
  { arbitrary: external(anyDraft).map((e) => [e]), weight: 6 },
  { arbitrary: shell.map((event): DraftEntry[] => [{ kind: 'shell', event }]), weight: 2 },
  { arbitrary: attempt, weight: 3 },
  { arbitrary: verifyLoop, weight: 2 },
  { arbitrary: redCi, weight: 1 },
  { arbitrary: debouncedReply, weight: 1 },
  { arbitrary: humanFragment, weight: 2 },
  { arbitrary: forge, weight: 2 },
);

/** Delegation first, most of the time: rules for a delegated ticket are the bulk of the workflow. */
const opening: fc.Arbitrary<DraftEntry[]> = fc.oneof(
  {
    arbitrary: fc.record({ l: fc.constantFrom('todo' as const, 'dev' as const), signed: fc.integer({ min: 0, max: 3 }) }).map(({ l, signed }): DraftEntry[] => [
      {
        kind: 'external',
        draft: { type: 'ticket.delegated', payload: { linearSessionId: DEV_SESSION, issue: { title: 'Titre', logical: l, priority: 0 } } },
        untrusted: false,
        ...(signed === 0 ? { signed: { actor: 'u-dev', roles: ACTORS['u-dev']! } } : {}),
      },
      { kind: 'shell', event: { type: 'session.linked', linearSessionId: DEV_SESSION } },
    ]),
    weight: 4,
  },
  { arbitrary: fc.constant<DraftEntry[]>([]), weight: 1 },
);

function stamp(drafts: DraftEntry[]): Entry[] {
  return drafts.map((d, i): Entry => {
    if (d.kind === 'shell') return d;
    const event = {
      id: `ev-${i}`,
      type: d.draft.type,
      at: 1_000 * (i + 1),
      projectId: PROJECT,
      ticketId: TICKET,
      ...TRUSTED,
      // As the ingestion stamps them (ORC-160): an untrusted event has no actor; a trusted Linear one has
      // its signed actor, and the roles resolved for it when the orchestrator checks the matrix (ORC-186).
      ...(d.untrusted ? { taint: 'untrusted' } : { ...(FROM_LINEAR.has(d.draft.type) ? { actor: 'user-lilian' } : {}), ...(d.signed?.actor ? { actor: d.signed.actor } : {}) }),
      ...(d.signed ? { roles: d.signed.roles } : {}),
      payload: d.draft.payload,
    } as FactoryEvent;
    return { kind: 'external', event };
  });
}

/** Swaps of adjacent entries, then, one time in eight, a full shuffle: events arrive out of order. */
function reorder(entries: Entry[], swaps: number[], shuffle: number[] | undefined): Entry[] {
  const out = [...entries];
  if (out.length < 2) return out;
  for (const s of swaps) {
    const i = s % (out.length - 1);
    [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
  }
  if (!shuffle) return out;
  // Fisher-Yates driven by the generated numbers, so fast-check can still shrink it.
  for (let i = out.length - 1; i > 0; i--) {
    const j = shuffle[i % shuffle.length]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Copies of external events (same id), each inserted at some position after its original. */
function duplicate(entries: Entry[], copies: { source: number; offset: number }[]): Entry[] {
  const out = [...entries];
  for (const { source, offset } of copies) {
    const externals = out.flatMap((e, i) => (e.kind === 'external' ? [i] : []));
    if (externals.length === 0) return out;
    const from = externals[source % externals.length]!;
    const at = from + 1 + (offset % (out.length - from));
    out.splice(at, 0, out[from]!);
  }
  return out;
}

export interface Sequences {
  /** Reordered, each external event once. */
  unique: Entry[];
  /** `unique` with duplicates of its external events inserted after their original. */
  withDuplicates: Entry[];
}

export const sequences: fc.Arbitrary<Sequences> = fc
  .record({
    opening,
    body: fc.array(fragment, { maxLength: 16 }),
    swaps: fc.array(fc.nat(), { maxLength: 6 }),
    // One in eight: `fc.option`'s `freq` would give the opposite (nil one time in `freq`).
    shuffle: fc.oneof(
      { withCrossShrink: true },
      { arbitrary: fc.constant(undefined), weight: 7 },
      { arbitrary: fc.array(fc.nat(), { minLength: 1, maxLength: 8 }), weight: 1 },
    ),
    copies: fc.array(fc.record({ source: fc.nat(), offset: fc.nat() }), { maxLength: 5 }),
  })
  .map(({ opening: head, body: fragments, swaps, shuffle, copies }) => {
    const unique = reorder(stamp([...head, ...fragments.flat()]), swaps, shuffle);
    return { unique, withDuplicates: duplicate(unique, copies) };
  });
