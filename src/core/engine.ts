import type { JobSpec, Rule, Workflow } from '../config/workflow-schema.js';
import { allowed, DEFAULT_MATRIX, refusalMessage, type AuthzAction, type AuthzMatrix, type Channel } from './authz.js';
import { evalCondition } from './conditions.js';
import { deadLetterReason, liftDeadLetterBlock, REPAIR_LABELS, repairedEvent } from './dead-letter.js';
import type { Decision, Effect } from './decision.js';
import { reduce } from './reduce.js';
import type { EventPayloads, EventType, FactoryEvent, FeedbackItem, InputKind, Taint, TicketState, VerifyFailure } from './types.js';

type StartRun = Extract<Effect, { kind: 'start_run' }>;

const RELAUNCH = 'Répondez dans ce fil ou posez le label agent:reprendre pour relancer.';
const STOP_MESSAGE = `Arrêté. ${RELAUNCH}`;
const STOPPED = 'Arrêté à la demande';

/** Paths a run started from an untrusted event must not write; enforced by the runner's sandbox (ORC-151). */
export const SENSITIVE_PATHS: readonly string[] = ['.github/**', '.factory/**', '.claude/**', 'CODEOWNERS', '.env*'];

/** The refusal of a knowledge job (I12): its event is untrusted, or what it would read at its launch is (ORC-274). */
export function taintedKnowledge(job: string, source: 'event' | 'read' = 'event'): string {
  const what = source === 'event' ? "l'événement vient" : "des retours qu'il lirait (fil ou commentaires de review) viennent";
  return `Je ne lance pas ${job} : ce job écrit dans la base de connaissances, et ${what} d'une source non fiable.`;
}

const BUILT_IN = new Set<EventType>([
  'control.pause', 'control.resume', 'control.stop', 'run.finished', 'verify.passed', 'verify.failed', 'timer.fired', 'pr.opened',
  'effect.done', 'effect.failed', 'dead_letter.added',
]);

function empty(): Decision {
  return { events: [], effects: [], timers: [], trace: [] };
}

/** The ticket's work stops and it is blocked for `reason` until a human relaunches it; `body` tells the session. */
function stop(out: Decision, reason = STOPPED, body = STOP_MESSAGE): Decision {
  out.events.push({ type: 'work.cancelled' }, { type: 'ticket.blocked', reason });
  out.effects.push({ kind: 'stop_run' }, { kind: 'activity', type: 'response', body });
  return out;
}

function success(out: Decision, job: JobSpec, runId: string): Decision {
  if (job.onSuccess.move) out.effects.push({ kind: 'move', to: job.onSuccess.move });
  if (job.onSuccess.post) out.effects.push({ kind: 'post_output', style: job.onSuccess.post, runId });
  return out;
}

function block(out: Decision, reason: string, body: string): Decision {
  out.events.push({ type: 'ticket.blocked', reason });
  out.effects.push({ kind: 'activity', type: 'elicitation', body });
  return out;
}

/** Prefix of the block reason of the red-CI bound: a green CI lifts that block (ORC-270). */
const RED_CI_BLOCKED = 'CI toujours en échec après ';

/** Events a human sends: unblocking the ticket, they give the red-CI loop its whole bound back (ORC-270). */
const HUMAN_RELAUNCH = new Set<EventType>(['session.prompted', 'label.changed', 'status.changed', 'ticket.delegated']);

/** The red-CI loop starts over with its whole bound (ORC-270); nothing is recorded when its count is already 0. */
function resetRedCi(out: Decision, ticket: TicketState | undefined): void {
  if ((ticket?.ciFixAttempts ?? 0) > 0) out.events.push({ type: 'ticket.patched', patch: { ciFixAttempts: 0 } });
}

/**
 * Work starts again on a blocked ticket. Relaunched by a human (a reply, a label, a status change), the
 * red-CI count and the « Boucle » guard reset; by a machine event (a timer, red CI itself), it does not, or a timer armed before
 * the block would undo it.
 */
function unblock(out: Decision, event: FactoryEvent, ticket: TicketState): void {
  out.events.push({ type: 'ticket.unblocked' });
  if (!HUMAN_RELAUNCH.has(event.type)) return;
  resetRedCi(out, ticket);
  // The « Boucle » guard starts over too (ORC-187); `null`, not undefined, survives the JSON of the journal.
  if (ticket.repeatedFailure) out.events.push({ type: 'ticket.patched', patch: { repeatedFailure: null } });
}

/** A Linear session that carries questions (read-only answers), not the ticket's dev conversation. */
export function isQuestionSession(ticket: TicketState | undefined, sessionId: string | undefined): boolean {
  if (!ticket || !sessionId) return false;
  if (!ticket.delegated) return true;
  if (ticket.questionSessionIds.includes(sessionId)) return true;
  return !!ticket.linearSessionId && sessionId !== ticket.linearSessionId;
}

/**
 * The strongest taint of what a run reads: its event, and the ticket's pending feedback when the run
 * consumes it, even if a trusted event (a timer, a label) starts it (I12). An item without taint was
 * written before ORC-269, when no source marked an event untrusted: it stays trusted, as `upcast` reads
 * a version 1 event, so that replaying the journal gives the same decisions.
 */
function runTaint(event: FactoryEvent, ticket: TicketState | undefined, input: InputKind | undefined): Taint {
  if (event.taint === 'untrusted') return 'untrusted';
  return input === 'feedback' && anyUntrusted(ticket?.pendingFeedback ?? []) ? 'untrusted' : 'trusted';
}

function anyUntrusted(items: readonly FeedbackItem[]): boolean {
  return items.some((f) => f.taint === 'untrusted');
}

/**
 * The sensitive paths of a run at its launch (I12, ORC-274): when its start was decided with them, or
 * when what the launch reads is untrusted. A launch reads the feedback when it starts, not when
 * `decide` started it: a job kept pending or queued meanwhile reads the replies that came in since.
 * `Orchestrator.launch` applies it to every start (a `start_run`, the pending job by `settle`, the queue).
 */
export function sensitivePathsAtLaunch(decided: readonly string[] | undefined, read: readonly FeedbackItem[]): readonly string[] | undefined {
  return decided?.length || anyUntrusted(read) ? SENSITIVE_PATHS : undefined;
}

/**
 * Why a dev-queue job may not run on the ticket at all: its PR is merged (I8 b), or it is not delegated.
 * `decide` and `Orchestrator.startRun` (for the starts `decide` does not see) both apply it.
 */
export function refusesDevWork(ticket: TicketState | undefined, job: JobSpec): 'undelegated' | 'merged' | undefined {
  if (job.queue !== 'dev' || !ticket) return undefined;
  if (ticket.prState === 'MERGED') return 'merged';
  return ticket.delegated ? undefined : 'undelegated';
}

/** Why `job` must not start: the ticket's PR is merged (I8 b), or untrusted content would write the knowledge base (I12). */
function refusal(event: FactoryEvent, ticket: TicketState | undefined, job: JobSpec, taint = runTaint(event, ticket, job.input)): 'merged' | 'taint' | undefined {
  if (refusesDevWork(ticket, job) === 'merged') return 'merged';
  return job.workspace === 'knowledge' && taint === 'untrusted' ? 'taint' : undefined;
}

/**
 * Starts `job`, unless the ticket is delivered (traced only) or untrusted content would write the knowledge
 * base (the refusal is explained). Every `start_run` of `decide` goes through here, so both rules apply
 * whatever branch starts the run.
 */
function startRun(out: Decision, event: FactoryEvent, ticket: TicketState | undefined, job: JobSpec, run: Omit<StartRun, 'kind' | 'job'>): void {
  const taint = runTaint(event, ticket, run.input ?? job.input);
  const refused = refusal(event, ticket, job, taint);
  if (refused === 'merged') {
    out.trace.push(`merged: refused ${job.name}`);
    return;
  }
  if (refused === 'taint') {
    out.trace.push(`taint: refused ${job.name}`);
    out.effects.push({ kind: 'activity', type: 'response', body: taintedKnowledge(job.name), linearSessionId: run.linearSessionId });
    return;
  }
  const effect: StartRun = { kind: 'start_run', job: job.name, ...run };
  out.effects.push(taint === 'untrusted' ? { ...effect, sensitivePaths: SENSITIVE_PATHS } : effect);
}

/** Non-delegated tickets only ever get question-queue work. */
function ruleAllowed(rule: Rule, event: FactoryEvent, ticket: TicketState | undefined, workflow: Workflow): boolean {
  if (!rule.run || !ticket || ticket.delegated || event.type === 'ticket.delegated') return true;
  return workflow.jobs[rule.run]?.queue === 'questions';
}

export function formatFailuresShort(failures: VerifyFailure[]): string {
  return failures.map((f) => `- \`${f.command}\` (code ${f.exitCode ?? 'timeout'})`).join('\n');
}

/** What a rule asks of the event itself (status moved, label, command), its `when` on the ticket left out. */
function eventMatches(rule: Rule, event: FactoryEvent): boolean {
  if (event.type === 'status.changed') {
    if (rule.from && rule.from !== event.payload.from) return false;
    if (rule.to && rule.to !== event.payload.to) return false;
  }
  // Rules under label.changed see additions only, as under label.added before the rename.
  if (event.type === 'label.changed' && event.payload.change !== 'added') return false;
  if (rule.label !== undefined && (event.type !== 'label.changed' || event.payload.label !== rule.label)) return false;
  return rule.say === undefined || (event.type === 'command' && event.payload.name === rule.say);
}

function ruleMatches(rule: Rule, event: FactoryEvent, ticket: TicketState | undefined, activeJob: string | undefined): boolean {
  if (!eventMatches(rule, event)) return false;
  if (rule.when) {
    return evalCondition(rule.when, {
      state: ticket?.logical ?? 'todo',
      blocked: ticket?.blocked ?? false,
      job: activeJob,
    });
  }
  return true;
}

/** Records a reply in the ticket's dev session: it waits in pendingFeedback for the next run that consumes it (I6). */
function appendFeedback(out: Decision, event: FactoryEvent<'session.prompted'>): void {
  out.events.push({
    type: 'feedback.appended',
    item: { author: event.payload.author, authorId: event.actor, body: event.payload.body, at: event.at, source: 'session', taint: event.taint },
  });
}

/** Prefix of the trace of a refused action (ORC-186): the orchestrator logs it. */
export const AUTHZ_REFUSED = 'authz: refused ';

/**
 * Checks the matrix on the event's signed actor and the roles journaled with it (ORC-186). A refusal is
 * traced and answered where the human acted: in the session of the event when it has one, else in a
 * comment on the ticket; both go through the outbox, keyed by their effect id (ORC-162). An event with
 * neither a signed actor nor a session (a delegation or a move the reconciliation found, a change by an
 * integration) names no human to answer: its refusal is only traced, and logged. An event without
 * resolved roles (the factory's own, or journaled before ORC-186) is not checked.
 */
function authorize(out: Decision, event: FactoryEvent, ticket: TicketState | undefined, action: AuthzAction, channel: Channel, matrix: AuthzMatrix): boolean {
  if (event.roles === undefined) return true;
  const verdict = allowed({ action, channel }, event.actor, ticket, matrix, event.roles);
  if (verdict.ok) return true;
  out.trace.push(`${AUTHZ_REFUSED}${action} to ${event.actor ?? 'an unsigned actor'} (${verdict.reason}, roles: ${event.roles.join(', ') || 'none'})`);
  const body = refusalMessage(action, matrix, verdict.reason);
  const sessionId = (event.payload as { linearSessionId?: string }).linearSessionId;
  if (sessionId) out.effects.push({ kind: 'activity', type: 'response', body, linearSessionId: sessionId });
  else if (event.actor) out.effects.push({ kind: 'comment', body });
  return false;
}

/**
 * Whether `decide` may check the matrix on `event` under `workflow` (ORC-186): the orchestrator resolves
 * the actor's roles, and journals them, only then, so that an event the matrix never checks (a label
 * taken off, a move no `run` rule answers) does not wait on Linear or GitHub. It may say yes for an
 * event `decide` ends up not checking (a rule's `when` is not read here), never the other way round:
 * an event without roles is not checked.
 */
export function mayCheck(event: FactoryEvent, workflow: Workflow): boolean {
  if (!HUMAN_EVENTS.has(event.type)) return false;
  if (event.type !== 'label.changed' && event.type !== 'status.changed') return true;
  // A move to Done may merge (ORC-148): its actor is always checked.
  if (event.type === 'status.changed' && event.payload.to === 'done') return true;
  return (workflow.on[event.type] ?? []).some((r) => !!r.run && eventMatches(r, event));
}

/** The events a human sends that the matrix may check (`mayCheck`): a cheap filter before any read. */
export const HUMAN_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'ticket.delegated', 'session.mentioned', 'command', 'session.prompted', 'label.changed', 'status.changed',
]);

/** A human acting on a run, by a rule (a label, a status change): relaunching it when the ticket is blocked, triggering it otherwise. */
const ruleAction = (ticket: TicketState | undefined): AuthzAction => (ticket?.blocked ? 'relaunch_blocked' : 'trigger');

function applyRule(out: Decision, rule: Rule, event: FactoryEvent, ticket: TicketState | undefined, workflow: Workflow): Decision {
  const job = rule.run ? workflow.jobs[rule.run]! : undefined;
  if (job && !refusal(event, ticket, job) && ticket?.blocked) unblock(out, event, ticket);
  if (rule.move) out.effects.push({ kind: 'move', to: rule.move });
  if (rule.labels) out.effects.push({ kind: 'labels', add: rule.labels.add, remove: rule.labels.remove });
  if (rule.comment) out.effects.push({ kind: 'comment', body: rule.comment });
  if (rule.do === 'stop') stop(out);
  if (rule.do === 'cleanup') out.effects.push({ kind: 'cleanup' });
  if (rule.do === 'propose_delegate') {
    out.effects.push({
      kind: 'activity',
      type: 'response',
      body: 'Pour que je développe ce ticket, déléguez-le moi (champ « Agent » du ticket).',
    });
  }
  if (!job) return out;
  if (rule.debounceMs && rule.debounceMs > 0 && !refusal(event, ticket, job)) {
    out.timers.push({ kind: 'debounce', slot: job.name, ms: rule.debounceMs, payload: { job: job.name } });
  } else {
    const threaded = event.type === 'session.mentioned' || event.type === 'command';
    startRun(out, event, ticket, job, {
      input: job.input,
      inputText: threaded ? event.payload.body : undefined,
      linearSessionId: threaded ? event.payload.linearSessionId : undefined,
    });
  }
  return out;
}

/**
 * A rule that answers red CI with a run, bounded by `limits.ciFixAttempts` (I5, ORC-270): each run it
 * starts is counted, and once the count reaches the bound the next red CI blocks the ticket instead of
 * applying the rule. A green CI, another PR or a human relaunch (`unblock`) resets the count. A run the rule would
 * not start anyway (merged PR, I8 b) is neither counted nor blocked.
 */
function fixRedCi(out: Decision, rule: Rule, event: FactoryEvent<'pr.checks_failed'>, ticket: TicketState | undefined, workflow: Workflow): Decision {
  const job = workflow.jobs[rule.run!]!;
  if (refusal(event, ticket, job)) return applyRule(out, rule, event, ticket, workflow);
  const used = ticket?.ciFixAttempts ?? 0;
  const bound = workflow.limits.ciFixAttempts;
  if (used < bound) {
    applyRule(out, rule, event, ticket, workflow);
    out.events.push({ type: 'ticket.patched', patch: { ciFixAttempts: used + 1 } });
    return out;
  }
  out.trace.push(`red CI: ${job.name} bound ${bound} reached`);
  // Already blocked (by a rule without !blocked): the ticket keeps its reason and gets no second notice.
  if (ticket?.blocked) return out;
  const reason = `${RED_CI_BLOCKED}${bound} tentatives de ${job.name}.`;
  const failures = event.payload.failures.map((f) => `- \`${f}\``);
  return block(out, reason, [reason, ...failures, 'Répondez dans ce fil pour relancer.'].join('\n'));
}

/**
 * The failed check seen again (ORC-187): same job, same failed commands and exit codes, same worktree content.
 * The output is left out, as it carries times and paths. Without a fingerprint of the worktree, nothing is tracked.
 */
function repeatedFailure(ticket: TicketState | undefined, payload: EventPayloads['verify.failed']): { signature: string; count: number } | undefined {
  if (!payload.tree) return undefined;
  const signature = `${payload.job}|${payload.tree}|${payload.failures.map((f) => `${f.command}:${f.exitCode}`).join(',')}`;
  const previous = ticket?.repeatedFailure;
  return { signature, count: previous?.signature === signature ? previous.count + 1 : 1 };
}

/**
 * The pseudo-ticket that carries a project's reconciliation timer (ORC-185): timers live per ticket, keyed by the
 * ticket alone, so each project has its own (`_reconcile.<project>`) and their keys never collide.
 */
export const reconcileTicket = (projectId: string): string => `_reconcile.${projectId}`;
export const isReconcileTicket = (ticketId: string | undefined): boolean => !!ticketId?.startsWith('_reconcile.');
/** The reconciliation's cadence (ORC-185): a safety net behind the webhooks. */
export const RECONCILE_MS = 5 * 60_000;

/** The ticket goes back to Human Review (ORC-148): nothing merged, `reason` answered in the ticket. */
function backToReview(out: Decision, reason: string): Decision {
  out.trace.push(`not merged: ${reason}`);
  // The commit under review stays the one shown: a head pushed since is never taken as reviewed.
  out.effects.push({ kind: 'move', to: 'human_review', keepReviewSha: true }, { kind: 'comment', body: `${reason} Le ticket repasse en Human Review.` });
  return out;
}

/**
 * A human moved the ticket of an open PR to Done (ORC-148): the factory merges, on the commit shown in Human Review,
 * only if the signed actor may merge (matrix, `done_merge`); the merge effect then checks the forge itself (head
 * still that commit, its checks green), as only the forge knows them for that commit. Otherwise nothing is merged and
 * the ticket goes back to Human Review with the reason. A move with no resolved actor never merges: the matrix
 * lets an unchecked event through, a merge must not.
 */
function doneMerge(out: Decision, event: FactoryEvent<'status.changed'>, state: TicketState, matrix: AuthzMatrix): Decision {
  // No signed actor (Linear's GitHub integration after a merge on GitHub, the reconciliation): no human decision.
  if (event.roles === undefined || !event.actor) {
    out.trace.push('done: no signed actor, no merge');
    return out;
  }
  if (!authorize(out, event, state, 'done_merge', 'linear', matrix)) {
    out.effects.push({ kind: 'move', to: 'human_review', keepReviewSha: true });
    return out;
  }
  if (!state.reviewSha) {
    return backToReview(out, "Je ne merge pas : aucun commit relu n'est enregistré pour ce ticket ; répondez dans le fil pour que l'agent repasse par la vérification.");
  }
  out.trace.push(`done: merge PR #${state.prNumber} on ${state.reviewSha}`);
  out.effects.push({ kind: 'merge', sha: state.reviewSha });
  return out;
}

const FENCED = 'fenced: ';

export function isFenced(d: Decision): boolean {
  return d.trace[0]?.startsWith(FENCED) ?? false;
}

/** A result whose attempt is no longer active: the dev run or the verification it reports on was replaced or stopped. */
function staleAttempt(state: TicketState | undefined, event: FactoryEvent, workflow: Workflow): string | undefined {
  if (event.type === 'verify.passed' || event.type === 'verify.failed') {
    const { runId } = event.payload;
    return runId === state?.verifyingRunId ? undefined : `${event.type} for run ${runId}, awaited ${state?.verifyingRunId ?? 'none'}`;
  }
  if (event.type === 'run.finished' && workflow.jobs[event.payload.job]?.queue === 'dev') {
    const { runId } = event.payload;
    return runId === state?.activeRunId ? undefined : `run.finished for run ${runId}, active ${state?.activeRunId ?? 'none'}`;
  }
  return undefined;
}

/**
 * The end of the dev run in flight when the PR was merged: traced, never acted on (I8 b). Its verification
 * cannot follow: pr.merged cancels the one awaited, so a later verify.* is fenced as stale.
 */
function afterMerge(state: TicketState | undefined, event: FactoryEvent, workflow: Workflow): string | undefined {
  if (state?.prState !== 'MERGED' || event.type !== 'run.finished') return undefined;
  return workflow.jobs[event.payload.job]?.queue === 'dev' ? `merged: ignored run.finished for run ${event.payload.runId}` : undefined;
}

/** Delivered (`done`, PR merged) or stopped by a human (its reason stays): a failure blocks it no more. */
function settledTicket(ticket: TicketState): string | undefined {
  if (ticket.logical === 'done' || ticket.prState === 'MERGED') return 'delivered';
  return ticket.blocked && ticket.blockReason === STOPPED ? 'stopped' : undefined;
}

/**
 * A dead-lettered event repaired by `factory run repair` (ORC-175). The block of that event is lifted
 * first (`reduce` does the same), then a `replay` decides the event again on the unblocked ticket; a
 * `force` records its facts (by `reduce`) without its decision, a `skip` drops it.
 */
function repair(state: TicketState | undefined, event: FactoryEvent<'dead_letter.repaired'>, workflow: Workflow): Decision {
  const { eventId, action, by } = event.payload;
  const base = liftDeadLetterBlock(state, eventId);
  const lifted = base !== state;
  const repaired = repairedEvent(event);
  const out = action === 'replay' && repaired ? decide(base, repaired, workflow) : empty();
  // Pushed, not put first: the trace of a replayed event keeps its fence first (`isFenced`).
  out.trace.push(`built-in dead_letter.repaired: ${action} ${eventId}`);
  if (lifted) out.effects.push({ kind: 'activity', type: 'response', body: `Événement ${eventId} réparé par ${by} (${REPAIR_LABELS[action]}) : le ticket est débloqué.` });
  return out;
}

/** Events that trigger the agent (ORC-186): a delegation, a mention, a command. */
const TRIGGERS = new Set<EventType>(['ticket.delegated', 'session.mentioned', 'command']);

/**
 * Pure: the same state, event, workflow and matrix always give the same decision. The authorization
 * `matrix` (ORC-186) is the default one until the `factory/default` preset declares it (ORC-187).
 */
export function decide(state: TicketState | undefined, event: FactoryEvent, workflow: Workflow, matrix: AuthzMatrix = DEFAULT_MATRIX): Decision {
  const out = decideEvent(state, event, workflow, matrix);
  // A dead notice or label means the tracker is down: nothing more is written to it (no loop, ORC-150).
  const trackerDown = event.type === 'effect.failed' && (event.payload.kind === 'activity' || event.payload.kind === 'labels');
  if (!trackerDown) blockedLabel(out, state, event);
  return out;
}

/** Label put next to the status while the factory waits for a human (ORC-170). */
export const BLOCKED_LABEL = 'Bloqué';

/**
 * The label follows the ticket's blocked flag from before the event to after the decision, however it
 * changed: a block or unblock decided here, or a lift made by `reduce` itself (a repair, a cancellation).
 */
function blockedLabel(out: Decision, state: TicketState | undefined, event: FactoryEvent): void {
  if (!state) return;
  const after = out.events.reduce<TicketState | undefined>((t, e) => reduce(t, e), reduce(state, event));
  const label = blockedLabelChange(state.blocked, after?.blocked ?? false);
  if (label) out.effects.push(label);
}

/** The `labels` effect that keeps the label in step with a change of the blocked flag, if it changed. */
export function blockedLabelChange(before: boolean, after: boolean): Extract<Decision['effects'][number], { kind: 'labels' }> | undefined {
  if (before === after) return undefined;
  return after ? { kind: 'labels', add: [BLOCKED_LABEL], remove: [] } : { kind: 'labels', add: [], remove: [BLOCKED_LABEL] };
}

function decideEvent(state: TicketState | undefined, event: FactoryEvent, workflow: Workflow, matrix: AuthzMatrix): Decision {
  if (event.type === 'dead_letter.repaired') return repair(state, event, workflow);
  const out = empty();
  const fence = staleAttempt(state, event, workflow);
  if (fence) {
    out.trace.push(`${FENCED}${fence}`);
    return out;
  }
  const merged = afterMerge(state, event, workflow);
  if (merged) {
    out.trace.push(merged);
    return out;
  }
  // Rules read the ticket as it is once the event's own facts are recorded (new status, delegation…).
  const ticket = reduce(state, event);
  if (BUILT_IN.has(event.type)) out.trace.push(`built-in ${event.type}`);
  if (event.type === 'status.changed' && event.payload.cancelled) {
    // A ticket cancelled by a human (ORC-170): its work stops, and nothing waits for an answer (`reduce`
    // drops the block and the pending replies). A ticket the factory does not work on has nothing to stop.
    if (!state?.delegated) {
      out.trace.push('status.changed: ticket cancelled, not delegated: nothing to stop');
      return out;
    }
    out.trace.push('status.changed: ticket cancelled, work cancelled');
    out.events.push({ type: 'work.cancelled' });
    out.effects.push({ kind: 'stop_run' });
    return out;
  }
  // A Done from Human Review only: during dev or the AI review it is no review decision, and the rules apply as before.
  const reviewed = state?.delegated && state.logical === 'human_review' && state.prNumber !== undefined && state.prState === 'OPEN';
  if (event.type === 'status.changed' && event.payload.to === 'done' && reviewed) {
    return doneMerge(out, event, state, matrix);
  }
  if (TRIGGERS.has(event.type)) {
    // The event's facts stay recorded (Linear did delegate, the session exists): only the factory's answer is refused.
    if (!authorize(out, event, ticket, 'trigger', 'linear', matrix)) return out;
    // The run's initiator, and its requester: who delegated it, as Linear signed it and the matrix allowed it.
    // Only a checked delegation names one: a row journaled before ORC-186 replays as it was decided.
    if (event.type === 'ticket.delegated' && event.roles !== undefined && event.actor && ticket && ticket.initiatorId !== event.actor) {
      out.events.push({ type: 'ticket.patched', patch: { initiatorId: event.actor } });
    }
  }
  switch (event.type) {
    case 'control.pause':
      out.effects.push({ kind: 'set_paused', paused: true });
      return out;
    case 'control.resume':
      out.effects.push({ kind: 'set_paused', paused: false });
      return out;
    case 'control.stop':
      return stop(out);
    case 'run.finished': {
      const { outcome, job: jobName, runId } = event.payload;
      const job = workflow.jobs[jobName];
      if (!job || outcome === 'stopped') return out;
      if (outcome === 'success' && ticket?.blocked && job.queue === 'dev') return out;
      if (outcome === 'success') {
        if (job.verify.length === 0) return success(out, job, runId);
        out.events.push({ type: 'verify.started', runId });
        out.effects.push({ kind: 'run_verify', runId, job: jobName });
        return out;
      }
      if (job.queue === 'questions') {
        out.effects.push({ kind: 'activity', type: 'error', body: "Je n'ai pas pu terminer (échec ou plafond atteint).", runId });
        return out;
      }
      const reason =
        outcome === 'limit'
          ? `Le run ${jobName} a atteint un plafond (tours, durée ou budget).`
          : `Le run ${jobName} a échoué.`;
      return block(out, reason, `${reason} Répondez dans ce fil pour que je reprenne.`);
    }
    case 'verify.passed': {
      const job = workflow.jobs[event.payload.job];
      if (!job) return out;
      out.events.push({ type: 'ticket.patched', patch: { verifyAttempts: 0, ...(ticket?.repeatedFailure ? { repeatedFailure: null } : {}) } });
      return success(out, job, event.payload.runId);
    }
    case 'verify.failed': {
      const used = ticket?.verifyAttempts ?? 0;
      const { failures, job } = event.payload;
      const repeated = repeatedFailure(ticket, event.payload);
      if (repeated && repeated.count >= (workflow.limits.repeatedFailures ?? Infinity)) {
        out.events.push({ type: 'ticket.patched', patch: { repeatedFailure: repeated } });
        const reason = `Boucle : même échec ${repeated.count} fois de suite, sans changement du code.`;
        return block(out, reason, `${reason}\n${formatFailuresShort(failures)}\nRépondez dans ce fil pour relancer.`);
      }
      if (used + 1 < workflow.limits.verifyAttempts) {
        out.events.push({ type: 'ticket.patched', patch: { verifyAttempts: used + 1, ...(repeated ? { repeatedFailure: repeated } : {}) } });
        const spec = workflow.jobs[job];
        if (spec) startRun(out, event, ticket, spec, { input: 'verify_failures', inputText: JSON.stringify(failures), resume: true });
        return out;
      }
      const reason = `Vérifications toujours en échec après ${workflow.limits.verifyAttempts} tentatives.`;
      return block(out, reason, `${reason}\n${formatFailuresShort(failures)}\nRépondez dans ce fil pour relancer.`);
    }
    case 'timer.fired': {
      const fired = event.payload;
      if (fired.kind === 'reconcile') {
        // The project's reconciliation (ORC-185): it runs, and the next one is armed, so the cadence lives in the store.
        out.effects.push({ kind: 'reconcile' });
        out.timers.push({ kind: 'reconcile', payload: {}, slot: 'reconcile', ms: RECONCILE_MS });
        return out;
      }
      if (fired.kind !== 'debounce') {
        // Armed by no rule yet: the clarify reminder and block are ORC-210's, the usage-limit wait ORC-215's.
        out.trace.push(`timer.fired ${fired.kind}: no rule decides it yet`);
        return out;
      }
      const job = workflow.jobs[fired.payload.job];
      if (!job) return out;
      if (ticket?.blocked && !refusal(event, ticket, job)) unblock(out, event, ticket);
      startRun(out, event, ticket, job, { input: job.input });
      return out;
    }
    case 'effect.done':
      // A replay that found its effect already made (ORC-162): nothing to decide, but it stays visible.
      if (event.payload.deduplicated) out.trace.push(`effect ${event.payload.effectId} deduplicated${event.payload.ref ? ` (${event.payload.ref})` : ''}`);
      return out;
    case 'dead_letter.added': {
      // An event without a ticket, or a ticket the factory does not track: the dead letter waits for its repair.
      if (!ticket) return out;
      const settled = settledTicket(ticket);
      if (settled) {
        out.trace.push(`dead_letter.added ignored: ticket ${settled}`);
        return out;
      }
      const reason = deadLetterReason(event.payload);
      // Already blocked (another dead letter, a failed effect, the red-CI bound…): that reason stays, so that
      // repairing this event does not lift a block that is not its own. The event is still announced.
      if (ticket.blocked) out.trace.push(`dead_letter.added: ticket already blocked (${ticket.blockReason ?? 'no reason'}), reason kept`);
      else out.events.push({ type: 'ticket.blocked', reason });
      out.effects.push({ kind: 'activity', type: 'error', body: `${reason} Un mainteneur peut le réparer : \`factory run repair ${ticket.ticketId}\`.` });
      return out;
    }
    case 'effect.failed': {
      // `settle` is a step of the shell, not an effect of the workflow: its failure is only logged.
      const { kind, error, eventId } = event.payload;
      if (kind === 'settle' || !ticket) return out;
      // Nothing left to block: a delivered ticket, or one a human stopped (its reason stays).
      const settled = settledTicket(ticket);
      if (settled) {
        out.trace.push(`effect.failed ignored: ticket ${settled}`);
        return out;
      }
      // The error notice of a block died: the ticket stays blocked for the reason the notice carried.
      if (eventId.startsWith('effect:') && ticket.blocked) {
        out.trace.push('effect.failed ignored: the notice of a block, which keeps its reason');
        return out;
      }
      const reason = `Erreur : ${error}`;
      out.events.push({ type: 'ticket.blocked', reason });
      // The error notice of a failed effect is not noticed again when it fails too: the tracker may be what fails.
      if (!eventId.startsWith('effect:')) out.effects.push({ kind: 'activity', type: 'error', body: reason });
      return out;
    }
    case 'pr.merged':
      // Delivered: the dev run in flight stops, and nothing pending, queued or debounced starts after the merge.
      // Before the rule's effects, so its cleanup and learn run come after the stop.
      out.trace.push('built-in pr.merged: work cancelled');
      out.events.push({ type: 'work.cancelled' });
      out.effects.push({ kind: 'stop_run' });
      break;
    case 'pr.closed': {
      // Closed without merge (ORC-134): the run is cancelled as by a stop, then the rules apply. The close
      // of another PR than the ticket's, of one already closed or merged, or of a done ticket cancels nothing.
      const n = event.payload.number;
      if (!ticket || ticket.prNumber !== n || ticket.prState === 'MERGED' || ticket.prState === 'CLOSED' || ticket.logical === 'done') {
        out.trace.push(`pr.closed: PR #${n} is not the open PR of a ticket at work, nothing cancelled`);
        break;
      }
      out.trace.push('built-in pr.closed: work cancelled');
      out.events.push({ type: 'ticket.patched', patch: { prState: 'CLOSED' } });
      stop(out, `PR #${n} fermée sans merge`, `La PR #${n} a été fermée sans merge : j'arrête le travail sur ce ticket. ${RELAUNCH}`);
      break;
    }
    case 'pr.merge_refused':
      return backToReview(out, `Je n'ai pas mergé la PR #${event.payload.number} : ${event.payload.reason}.`);
    case 'pr.reviewed':
    case 'pr.conflicted':
      // In the inbox, but no reaction yet (ORC-190 for reviews, ORC-146 for conflicts): no rule applies to them.
      out.trace.push(`${event.type}: no reaction yet`);
      return out;
    case 'default_branch.pushed':
    case 'ci.run_completed':
      // Facts for the measures (ORC-278): a revert of the ticket's PR, a CI run's duration. Nothing to decide.
      out.trace.push(`${event.type}: recorded for the measures`);
      return out;
    case 'pr.checks_passed':
      // Green CI ends the red-CI loop: its count starts over (ORC-270). The rules of pr.checks_passed still apply.
      // A ticket blocked by the red-CI bound is no longer blocked for a reason that holds: the block is lifted.
      resetRedCi(out, ticket);
      if (ticket?.blocked && ticket.blockReason?.startsWith(RED_CI_BLOCKED)) out.events.push({ type: 'ticket.unblocked' });
      break;
    case 'pr.opened': {
      // A new PR (another number) reopens a delivered ticket; the same PR seen again leaves it as it is,
      // unless it was closed: reopened, it is open again (ORC-134).
      const other = event.payload.number !== ticket?.prNumber;
      const reopens = other || ticket?.prState === 'CLOSED';
      // Another PR is another red-CI loop: the count of the previous one does not carry over (ORC-270).
      if (other) resetRedCi(out, ticket);
      out.events.push({
        type: 'ticket.patched',
        patch: { prNumber: event.payload.number, prUrl: event.payload.url, ...(reopens ? { prState: 'OPEN' as const } : {}) },
      });
      out.effects.push({ kind: 'link_pr', url: event.payload.url });
      return out;
    }
    case 'session.stopped': {
      const sessionId = event.payload.linearSessionId;
      if (isQuestionSession(ticket, sessionId)) {
        out.trace.push('built-in session.stopped (question session)');
        out.effects.push(
          { kind: 'stop_run', linearSessionId: sessionId },
          { kind: 'activity', type: 'response', body: 'Arrêté.', linearSessionId: sessionId },
        );
        return out;
      }
      break;
    }
    case 'session.prompted':
      if (isQuestionSession(ticket, event.payload.linearSessionId)) {
        // Only who may answer the agent may ask the answering agent a question.
        if (!authorize(out, event, ticket, 'answer_clarify', 'linear_session', matrix)) return out;
        out.trace.push('built-in session.prompted (question session)');
        const ask = workflow.jobs['ask'];
        if (ask) startRun(out, event, ticket, ask, { input: 'thread', inputText: event.payload.body, linearSessionId: event.payload.linearSessionId });
        return out;
      }
      // In the dev session, a reply relaunches a blocked ticket, or answers the agent; a refused one is not kept.
      if (!authorize(out, event, ticket, ticket?.blocked ? 'relaunch_blocked' : 'answer_clarify', 'linear_session', matrix)) return out;
      // A reply in the dev session is kept whether a rule matches or not (I6).
      if (ticket) appendFeedback(out, event);
      break;
    default:
      break;
  }
  const activeJob = ticket?.activeJob;
  const rules = workflow.on[event.type] ?? [];
  const index = rules.findIndex((r) => ruleAllowed(r, event, ticket, workflow) && ruleMatches(r, event, ticket, activeJob));
  if (index < 0) {
    out.trace.push(`no rule for ${event.type}`);
    return out;
  }
  out.trace.push(`on.${event.type}[${index}]`);
  const rule = rules[index]!;
  // A label or a status change that starts a run (relaunch, rework, review) is a human action on the run.
  if (rule.run && (event.type === 'label.changed' || event.type === 'status.changed') && !authorize(out, event, ticket, ruleAction(ticket), 'linear', matrix)) {
    return out;
  }
  if (event.type === 'pr.checks_failed' && rule.run) return fixRedCi(out, rule, event, ticket, workflow);
  return applyRule(out, rule, event, ticket, workflow);
}
