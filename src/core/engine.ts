import { REFREEZE, type FrozenTests } from '../checks/freeze.js';
import type { JobSpec, Rule, Workflow } from '../config/workflow-schema.js';
import { allowed, DEFAULT_MATRIX, refusalMessage, type AuthzAction, type AuthzMatrix, type Channel } from './authz.js';
import { evalCondition } from './conditions.js';
import { deadLetterReason, heldMessage, isRefusedNotice, liftDeadLetterBlock, REPAIR_LABELS, repairedEvent } from './dead-letter.js';
import type { AgentOutput } from './agent-output.js';
import type { Decision, Effect } from './decision.js';
import { awaitsAgent, forAgent, STOP_COMMAND, STATUS_COMMAND } from './human-message.js';
import { PRODUCT_NAME } from '../product.js';
import { CUT_RELAUNCHES, CUT_WINDOW_MS } from '../store/types.js';
import { isOwnMoveEcho, reduce } from './reduce.js';
import { holds, isNoRepo, isUnrouted, unroutedReason } from './routing.js';
import type { EventPayloads, EventType, FactoryEvent, FeedbackItem, InputKind, MessageKind, RunOutcome, Taint, TicketState, VerifyFailure } from './types.js';

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
  'control.pause', 'control.resume', 'control.stop', 'run.finished', 'run.lost', 'verify.passed', 'verify.failed', 'verify.errored', 'verify.lost', 'publish.done', 'publish.refused', 'timer.fired', 'pr.opened',
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

/** The job's `on_success`, its `run` included (ORC-123: `tests` starts `dev`). */
function success(out: Decision, at: { event: FactoryEvent; ticket: TicketState | undefined; workflow: Workflow }, job: JobSpec, runId: string, output?: AgentOutput): Decision {
  if (job.onSuccess.move) out.effects.push({ kind: 'move', to: job.onSuccess.move });
  if (job.onSuccess.post) out.effects.push({ kind: 'post_output', style: job.onSuccess.post, runId, ...(output ? { output } : {}) });
  const next = job.onSuccess.run ? at.workflow.jobs[job.onSuccess.run] : undefined;
  if (next) startRun(out, at.event, at.ticket, next, { input: next.input });
  else handOver(out, at, job);
  return out;
}

/**
 * The step boundary with no step behind it (ORC-180): the factory's work ended, and messages wait for the agent. It
 * is resumed on them by the job the workflow answers a reply with, on the ticket as this end leaves it, once its
 * outputs are posted. The boundary with a step behind it carries them itself (`Orchestrator.launch`). Not on a job of
 * the questions queue, whose end is no step of the ticket; not behind a pending job, which the end of the run starts.
 */
function handOver(out: Decision, at: { event: FactoryEvent; ticket: TicketState | undefined; workflow: Workflow }, job: JobSpec): void {
  const { event, ticket, workflow } = at;
  if (job.queue !== 'dev' || !ticket?.delegated || ticket.blocked || ticket.pendingJob || !awaitsAgent(ticket.humanInbox)) return;
  const after = { ...ticket, logical: job.onSuccess.move ?? ticket.logical };
  const rule = (workflow.on['session.prompted'] ?? []).find((r) => r.run && ruleAllowed(r, event, after, workflow) && ruleMatches(r, event, after, undefined));
  const next = rule?.run ? workflow.jobs[rule.run] : undefined;
  if (!next) return;
  out.trace.push(`human inbox: handed over to ${next.name} at the end of ${job.name}`);
  startRun(out, event, after, next, { input: next.input });
}

/**
 * The `red` check found no red for the right reason (ORC-123). In measure mode the run goes on, and the decision's
 * trace says what the check would have blocked, a step outside the tests (`scope`) included: measuring never blocks.
 * In blocking mode, the job goes back with the verdict, `red.attempts` checks at most, then the ticket is blocked.
 * A check that could not run (`infra`) is no verdict: blocked in both modes, the agent never resumed for it.
 */
function redFailed(out: Decision, at: { event: FactoryEvent<'verify.failed'>; ticket: TicketState | undefined; workflow: Workflow }, job: JobSpec, red: NonNullable<JobSpec['red']>): Decision {
  const { red: cause = 'error', failures, runId } = at.event.payload;
  if (cause === 'infra') {
    const reason = `Le contrôle du rouge de ${job.name} n'a pas pu tourner : panne d'infrastructure, l'agent n'est pas en cause.`;
    return block(out, reason, `${reason}\n${failures[0]?.output ?? ''}\nRépondez dans ce fil pour que je reprenne.`);
  }
  if (red.mode === 'measure') {
    out.trace.push(`red: aurait bloqué (${cause}), mode mesure : le run continue`);
    freeze(out, at.ticket, at.event.payload.frozen);
    return success(out, at, job, runId);
  }
  const used = at.ticket?.redAttempts ?? 0;
  if (used + 1 < red.attempts) {
    out.events.push({ type: 'ticket.patched', patch: { redAttempts: used + 1 } });
    startRun(out, at.event, at.ticket, job, { input: 'verify_failures', inputText: JSON.stringify(failures), resume: true });
    return out;
  }
  const reason = `Rouge non vérifié après ${red.attempts} tentatives de ${job.name}.`;
  return block(out, reason, `${reason}\n${formatFailuresShort(failures)}\nRépondez dans ce fil pour relancer.`);
}

/**
 * Records the freeze read after `red` (ORC-131), once the run goes on to the build. A freeze already there keeps its
 * commit and fingerprints, the new files are added: only a maintainer's `/refreeze` takes a file out of the freeze (I3).
 */
function freeze(out: Decision, ticket: TicketState | undefined, frozen: FrozenTests | undefined): void {
  if (!frozen) return;
  const old = ticket?.frozenTests;
  out.events.push({ type: 'ticket.patched', patch: { frozenTests: old ? { sha: old.sha, files: { ...frozen.files, ...old.files } } : frozen } });
}

/** A run in the ticket's worktree goes through `factory/tests-gelés` once frozen (ORC-131), verify commands or not. */
export function goesThroughFreeze(ticket: TicketState | undefined, job: JobSpec): boolean {
  return !!ticket?.frozenTests && job.workspace === 'worktree';
}

/**
 * `/refreeze` (ORC-131): the freeze read at the branch's head before the decision replaces the old one, for a designated
 * maintainer only (ORC-186). Checked even on an event without resolved roles: a freeze never opens by default.
 */
function refreeze(out: Decision, event: FactoryEvent<'command'>, ticket: TicketState | undefined, matrix: AuthzMatrix): Decision {
  if (!authorize(out, { ...event, roles: event.roles ?? [] }, ticket, 'refreeze', 'linear', matrix)) return out;
  if (event.payload.kind) keepMessage(out, event, 'session', `${REFREEZE} ${event.payload.body}`);
  const { frozen, linearSessionId } = event.payload;
  const answer = (body: string) => out.effects.push({ kind: 'activity', type: 'response', body, linearSessionId });
  if (!frozen) {
    answer("Rien à regeler : ce ticket n'a pas de gel ou pas de branche de travail.");
    return out;
  }
  const count = Object.keys(frozen.files).length;
  out.trace.push(`refreeze by ${event.actor}: ${count} fichiers gelés à ${frozen.sha}`);
  out.events.push({ type: 'ticket.patched', patch: { frozenTests: frozen } });
  answer(`Regelé : ${count} fichiers, tels qu'au commit ${frozen.sha.slice(0, 12)}. La prochaine vérification part de ce gel.`);
  return out;
}

function block(out: Decision, reason: string, body: string): Decision {
  out.events.push({ type: 'ticket.blocked', reason });
  out.effects.push({ kind: 'activity', type: 'elicitation', body });
  return out;
}

/**
 * A dev run's end read through its closed outcome (ORC-289): the `RunOutcome` it decides as, or the block
 * it ends in. Without `attempt` (rows written before it), `outcome` decides as before. `errored` is the
 * infrastructure's: blocked, never handed back to the agent. A success without output stays a success
 * until the job is `structuredOutput` (ORC-191/ORC-192 make every agent submit).
 */
function attemptDecision(p: EventPayloads['run.finished'], job: JobSpec): RunOutcome | { reason: string; body: string } {
  const question = p.output?.question ?? '';
  switch (p.attempt) {
    case 'succeeded':
      return 'success';
    case 'failed':
      return p.outcome === 'success' && !job.structuredOutput ? 'success' : 'failure';
    case 'timeout':
      return 'limit';
    case 'errored': {
      const reason = `Le run ${job.name} s'est interrompu : panne d'infrastructure, l'agent n'est pas en cause.`;
      return { reason, body: `${reason} Répondez dans ce fil pour que je reprenne.` };
    }
    case 'needs_input':
      return { reason: "En attente d'une réponse à la question de l'agent.", body: `${question}\n\nRépondez dans ce fil pour que je reprenne.` };
    case 'spec_impossible':
      return {
        reason: "L'agent conteste le ticket : il ne peut pas le réaliser honnêtement tel qu'il est écrit.",
        body: `Je ne peux pas réaliser ce ticket tel qu'il est écrit : ${question}\n\nCorrigez le ticket ou répondez dans ce fil pour que je reprenne.`,
      };
    default:
      return p.outcome;
  }
}

/**
 * The block of an attempt the detector stopped (ORC-136), judged on the fact journaled with its end against the
 * bound of the frozen workflow. An event without the fact (rows written before it), or a version without the bound, is
 * no stagnation: the attempt's outcome decides, so a replay decides as it did.
 */
function stagnationBlock(p: EventPayloads['run.finished'], workflow: Workflow): { reason: string; body: string } | undefined {
  const seen = p.stagnation;
  if (!seen) return undefined;
  if (seen.kind === 'silent') {
    const reason = `Le run ${p.job} n'a rien écrit depuis ${Math.round(seen.silentMs / 60_000)} min : l'agent ne répond plus, son conteneur tourne encore.`;
    return { reason, body: `${reason} Répondez dans ce fil pour que je reprenne.` };
  }
  const bound = workflow.limits.repeatedFailures;
  if (bound === undefined || seen.count < bound) return undefined;
  const reason = `Boucle : même commande, même échec, ${seen.count} fois, sans changement du code.`;
  return { reason, body: `${reason}\n- \`${seen.command}\`\nRépondez dans ce fil pour relancer.` };
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
  // The red loop too (ORC-123).
  if (ticket.redAttempts) out.events.push({ type: 'ticket.patched', patch: { redAttempts: 0 } });
  // The lease's relaunch too (ORC-220), and the relaunches after a cut, which nothing else gives back.
  if (ticket.leaseRelaunches) out.events.push({ type: 'ticket.patched', patch: { leaseRelaunches: 0 } });
  if (ticket.cutRelaunches?.length) out.events.push({ type: 'ticket.patched', patch: { cutRelaunches: [] } });
}

/** The head of the reason of a ticket blocked by the bound: the Flux classes a block by the head of its reason (ORC-297). */
export const CUT_BOUND_REASON = /^Trop de relances après coupure : /;

/** The relaunches still in the window at the time of the event: never the clock, so that a replay decides the same. */
function recentCuts(ticket: TicketState, at: number): number[] {
  return (ticket.cutRelaunches ?? []).filter((t) => t > at - CUT_WINDOW_MS);
}

/** The bound of the relaunches after a cut is reached (ORC-220): no agent, and a human hears why. */
function blockOnCuts(out: Decision): Decision {
  const reason = `Trop de relances après coupure : ${CUT_RELAUNCHES} en ${CUT_WINDOW_MS / 60_000} min.`;
  return block(out, reason, `${reason} ${PRODUCT_NAME} ou son runner redémarre en boucle : vérifiez le démon, puis répondez dans ce fil pour que je reprenne.`);
}

/** How many relaunches an expired lease gets before the ticket is blocked (ORC-220). */
const LEASE_RELAUNCHES = 1;

/**
 * An attempt gone without a result (ORC-220). A dev step starts again from the ticket's session, unless nothing
 * should run on the ticket any more. An expired lease has its own bound of one, and every relaunch counts against
 * the bound of the window, a restart included: no fault of the attempt, but an agent launched all the same. A question
 * is not asked again by itself (ORC-277): its thread is told, once, by an effect.
 */
function attemptLost(out: Decision, event: FactoryEvent<'run.lost'>, ticket: TicketState | undefined, workflow: Workflow): Decision {
  const { job: jobName, runId, cause } = event.payload;
  const job = workflow.jobs[jobName];
  if (!job) return out;
  if (job.queue !== 'dev') {
    const why = cause === 'restart' ? `${PRODUCT_NAME} a redémarré pendant ma réponse.` : 'Le runner de ma réponse ne répond plus.';
    out.effects.push({ kind: 'activity', type: 'error', body: `${why} Reposez la question dans ce fil.`, runId });
    return out;
  }
  if (!ticket?.delegated || ticket.blocked || refusesDevWork(ticket, job)) {
    out.trace.push(`run.lost: ${jobName} not started again, nothing should run on the ticket`);
    return out;
  }
  const used = ticket.leaseRelaunches ?? 0;
  if (cause === 'lease' && used >= LEASE_RELAUNCHES) {
    const reason = `Le bail du run ${jobName} a expiré ${used + 1} fois : le runner ne répond plus.`;
    return block(out, reason, `${reason} Répondez dans ce fil pour que je reprenne.`);
  }
  const recent = recentCuts(ticket, event.at);
  if (recent.length >= CUT_RELAUNCHES) return blockOnCuts(out);
  out.events.push({ type: 'ticket.patched', patch: { ...(cause === 'lease' ? { leaseRelaunches: used + 1 } : {}), cutRelaunches: [...recent, event.at] } });
  startRun(out, event, ticket, job, { relaunchOf: runId });
  return out;
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
  return input === 'feedback' && anyUntrusted(ticket?.humanInbox ?? []) ? 'untrusted' : 'trusted';
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

/** A human message of a session, its class told or not. */
type HumanMessage = FactoryEvent<'session.prompted' | 'session.mentioned' | 'command'>;

/** Records a human message: it waits in humanInbox for the next run that consumes it (I6), its taint with it (I12). */
function keepMessage(out: Decision, event: HumanMessage, source: 'session' | 'thread', body = event.payload.body): void {
  const { author, kind } = event.payload;
  out.events.push({ type: 'feedback.appended', item: { author, authorId: event.actor, body, at: event.at, source, taint: event.taint, ...(kind ? { kind } : {}) } });
}

/**
 * Why the regrouping of classified messages ends without a run (ORC-180). Work in flight is not interrupted nor stacked
 * behind: its end is their step boundary. A block that came since waits for a reply: the messages before it answer nothing.
 */
function heldInbox(ticket: TicketState | undefined): string | undefined {
  if (ticket?.activeRunId || ticket?.verifyingRunId || ticket?.pendingJob) return 'held for the end of the work in flight';
  if (ticket?.blocked) return 'held by the block';
  return awaitsAgent(ticket?.humanInbox ?? []) ? undefined : 'nothing left to hand over';
}

/**
 * The regrouping of a message for the agent that implements (ORC-180), by the workflow's reply rule, whichever session it came
 * from: blocked, the rule relaunches at once (ORC-196's path); else it arms the debounce, and no rule leaves it for the next run.
 */
function regroup(out: Decision, event: FactoryEvent<'session.prompted' | 'session.mentioned'>, ticket: TicketState | undefined, workflow: Workflow): Decision {
  const rules = workflow.on['session.prompted'] ?? [];
  const index = rules.findIndex((r) => ruleAllowed(r, event, ticket, workflow) && ruleMatches(r, event, ticket, ticket?.activeJob));
  if (index < 0) {
    out.trace.push('no rule for session.prompted');
    return out;
  }
  out.trace.push(`on.session.prompted[${index}]`);
  return applyRule(out, rules[index]!, event, ticket, workflow);
}

/**
 * A reply classified at its arrival (ORC-180). Whatever its class, it enters the human inbox; the class only decides
 * whether an answer starts as well. Only the ticket's dev session relaunches a blocked ticket, and there a reply is a reply: no
 * answer of its own. On a ticket not delegated, the answer is the only reaction there can be. A refused one is not kept.
 */
function classifiedReply(out: Decision, event: FactoryEvent<'session.prompted'>, state: TicketState | undefined, ticket: TicketState | undefined, workflow: Workflow, matrix: AuthzMatrix): Decision {
  const { kind, body, linearSessionId } = event.payload;
  const thread = isQuestionSession(ticket, linearSessionId);
  const relaunches = !thread && !!ticket?.blocked;
  if (!authorize(out, event, ticket, relaunches ? 'relaunch_blocked' : 'answer_clarify', 'linear_session', matrix)) return out;
  const answerOnly = thread && (kind === 'question' || !ticket?.delegated);
  if (ticket) keepMessage(out, event, answerOnly ? 'thread' : 'session');
  const command = body.trim().toLowerCase().split(/\s+/, 1)[0];
  if (kind === 'command' && command === STOP_COMMAND) {
    const stopped = decideEvent(state, { ...event, type: 'session.stopped', payload: { linearSessionId } } as FactoryEvent<'session.stopped'>, workflow, matrix);
    stopped.events.unshift(...out.events);
    return stopped;
  }
  if (kind === 'command' && command === STATUS_COMMAND) {
    out.effects.push({ kind: 'activity', type: 'response', body: statusAnswer(ticket), linearSessionId });
    return out;
  }
  if (answerOnly || (kind === 'question' && !relaunches)) {
    out.trace.push(`session.prompted: ${kind}, answered`);
    const ask = workflow.jobs['ask'];
    if (ask) startRun(out, event, ticket, ask, { input: 'thread', inputText: body, linearSessionId });
  }
  if (answerOnly || (thread && ticket?.blocked)) return out;
  return regroup(out, event, ticket, workflow);
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
  if (!HUMAN_EVENTS.has(event.type) || (event.type === 'ticket.delegated' && event.payload.noRepo)) return false;
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
    const inbox = (event.type === 'session.prompted' || event.type === 'session.mentioned') && !!event.payload.kind;
    out.timers.push({ kind: 'debounce', slot: job.name, ms: rule.debounceMs, payload: { job: job.name, ...(inbox ? { inbox: true as const } : {}) } });
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

/**
 * No publication without a green `verify` on the same commit (I1, ORC-151): a commit since asks for its own. A workflow
 * none of whose jobs goes through it (a version frozen before) merges as it did, and never pushes: only such a job writes a `publish` (ORC-125).
 */
export function mayPublish(ticket: Pick<TicketState, 'verifiedSha'> | undefined, sha: string, workflow: Workflow): boolean {
  return !Object.values(workflow.jobs).some((j) => j.repoChecks) || ticket?.verifiedSha === sha;
}

/** The factory publishes what a job wrote and `verify` found green (ORC-125). The tests step comes before the code: its commit waits for `dev`'s. */
function publishes(job: JobSpec): boolean {
  return !!job.repoChecks && !job.red;
}

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
function doneMerge(out: Decision, event: FactoryEvent<'status.changed'>, state: TicketState, matrix: AuthzMatrix, workflow: Workflow): Decision {
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
    // Only the end of the factory's own work in Human Review records one (a review, a dev run): a reply, a refusal do not.
    return backToReview(out, "Je ne merge pas : aucun commit relu n'est enregistré pour ce ticket (l'usine n'en retient un qu'à la fin de son propre travail, une review IA ou un dev qui ramène le ticket en Human Review, et seulement si la tête de la PR est le commit sur lequel ce travail s'est terminé ; un renvoi en Human Review après un refus n'en retient pas). Passez le ticket en AI Review : la review IA le ramène en Human Review sur la tête de la PR, qui devient le commit relu.");
  }
  if (!mayPublish(state, state.reviewSha, workflow)) {
    return backThroughAiReview(out, event, state, workflow, `Je ne merge pas : le commit relu (${state.reviewSha.slice(0, 12)}) n'a pas de vérification verte, la dernière porte sur ${state.verifiedSha?.slice(0, 12) ?? 'aucun commit'}.`);
  }
  out.trace.push(`done: merge PR #${state.prNumber} on ${state.reviewSha}`);
  out.effects.push({ kind: 'merge', sha: state.reviewSha });
  return out;
}

/**
 * The factory's merge refused (ORC-148). For a push since the review, the new commits go through the AI review again:
 * the ticket moves to AI Review and the job of the workflow's `to: ai_review` rule starts here, as a move by the
 * factory emits no `status.changed`; its success shows the new head in Human Review, the commit the next Done merges.
 * Only the matching rule's `run` is applied. Any other refusal, a blocked ticket (it waits for a human) or a workflow with no AI
 * review goes back to Human Review, the reviewed commit kept. A refusal that arrives once a human moved the ticket on
 * from Done (an effect replayed late) is only answered: the ticket stays where the human put it. A PR known merged
 * meanwhile (on GitHub) is delivered: nothing is answered.
 */
function mergeRefused(out: Decision, event: FactoryEvent<'pr.merge_refused'>, ticket: TicketState | undefined, workflow: Workflow): Decision {
  const refused = `Je n'ai pas mergé la PR #${event.payload.number} : ${event.payload.reason}.`;
  if (ticket?.prState === 'MERGED') {
    // Merged on GitHub meanwhile: delivered, nothing to answer nor to move.
    out.trace.push(`not merged: ${event.payload.reason}, but the PR is merged`);
    return out;
  }
  if (ticket?.logical !== 'done') {
    out.trace.push(`not merged: ${event.payload.reason}, the ticket left where it is`);
    out.effects.push({ kind: 'comment', body: refused });
    return out;
  }
  return event.payload.headMoved ? backThroughAiReview(out, event, ticket, workflow, refused) : backToReview(out, refused);
}

/**
 * New commits go through the AI review again, whose `verify` finds them green or not, and which shows the head in Human
 * Review. A blocked ticket (it waits for a human) or a workflow with no AI review goes back to Human Review.
 */
function backThroughAiReview(out: Decision, event: FactoryEvent, ticket: TicketState, workflow: Workflow, refused: string): Decision {
  // The rule a human's move from Done to AI Review would apply, read on the ticket as it would then be.
  const moved: FactoryEvent<'status.changed'> = { ...event, type: 'status.changed', payload: { from: 'done', to: 'ai_review' } } as FactoryEvent<'status.changed'>;
  const inAiReview = { ...ticket, logical: 'ai_review' as const };
  // The first rule that matches, as `decideEvent` picks it: one with no run listed first starts no review.
  const run = (workflow.on['status.changed'] ?? []).find((r) => ruleAllowed(r, moved, inAiReview, workflow) && ruleMatches(r, moved, inAiReview, ticket.activeJob))?.run;
  const job = run && workflow.states.ai_review ? workflow.jobs[run] : undefined;
  if (!job || ticket.blocked) return backToReview(out, refused);
  out.trace.push(`not merged: ${refused}, back to the AI review`);
  out.effects.push({ kind: 'move', to: 'ai_review' }, { kind: 'comment', body: `${refused} Les nouveaux commits repassent par la review IA.` });
  startRun(out, event, ticket, job, { input: job.input });
  return out;
}

const FENCED = 'fenced: ';

export function isFenced(d: Decision): boolean {
  return d.trace[0]?.startsWith(FENCED) ?? false;
}

/** A result whose attempt is no longer active: the dev run or the verification it reports on was replaced or stopped. */
function staleAttempt(state: TicketState | undefined, event: FactoryEvent, workflow: Workflow): string | undefined {
  if (event.type === 'verify.passed' || event.type === 'verify.failed' || event.type === 'verify.errored' || event.type === 'verify.lost' || event.type === 'publish.done' || event.type === 'publish.refused') {
    const { runId } = event.payload;
    return runId === state?.verifyingRunId ? undefined : `${event.type} for run ${runId}, awaited ${state?.verifyingRunId ?? 'none'}`;
  }
  if ((event.type === 'run.finished' || event.type === 'run.lost') && workflow.jobs[event.payload.job]?.queue === 'dev') {
    const { runId } = event.payload;
    return runId === state?.activeRunId ? undefined : `${event.type} for run ${runId}, active ${state?.activeRunId ?? 'none'}`;
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

/** What the factory answers a trigger within 10 s (ORC-171), a comment rather than a reaction until ORC-140 decides. */
export const ACK_BODY = 'Bien reçu.';

/**
 * The ack of a trigger the webhook brought, first of its decision (ORC-171): a delegation gets the comment, and the
 * plan when it starts a run; any other trigger only the session's. An event already answered in its session (a
 * refusal, a run already active) gets no ack: nothing was taken. An event no webhook brought has no one waiting, and
 * a row journaled before ORC-171 asks for none: it replays as it was decided.
 */
function acknowledge(out: Decision, event: FactoryEvent, state: TicketState | undefined): void {
  const { ack, linearSessionId, kind, masked } = event.payload as { ack?: true; linearSessionId?: string; kind?: MessageKind; masked?: true };
  if (!ack || !linearSessionId) return;
  if (out.effects.some((e) => e.kind === 'activity' && e.linearSessionId === linearSessionId)) return;
  // A command of a reply is answered by what it does: `/stop` says so in the ticket's session, whichever one it came from.
  if (event.type === 'session.prompted' && kind === 'command') return;
  const delegation = event.type === 'ticket.delegated';
  const plan = delegation && out.effects.some((e) => e.kind === 'start_run');
  // A mention that asks a question keeps the ack of a trigger (ORC-171).
  const body = kind === 'instruction' || (event.type === 'session.prompted' && kind) ? messageAck(out, state) : ACK_BODY;
  out.effects.unshift({ kind: 'ack', body: masked ? `${body} ${MASKED_NOTICE}` : body, linearSessionId, ...(delegation ? { comment: true as const } : {}), ...(plan ? { plan: true as const } : {}) });
}

/** Said to whoever left a secret in a message: masked here, it stays in Linear (ORC-180). */
const MASKED_NOTICE = 'Votre message contenait un secret : il est masqué côté usine, mais reste visible dans Linear. Révoquez-le et supprimez-le du message.';

/** The sign of life of a message (ORC-180): what will come of it, as this decision has it. */
function messageAck(out: Decision, state: TicketState | undefined): string {
  if (out.events.some((e) => e.type === 'ticket.unblocked')) return 'Noté, je reprends.';
  if (out.effects.some((e) => e.kind === 'start_run' && e.input === 'thread')) return 'Noté, je regarde et je réponds ici.';
  if (state?.logical === 'done' || state?.prState === 'MERGED') return 'Noté, mais ce ticket est livré : aucune étape ne le reprendra.';
  return 'Noté, pris en compte à la prochaine étape.';
}

/** `/status` (ORC-180): the state of the ticket as the projection has it, with no model. */
function statusAnswer(ticket: TicketState | undefined): string {
  if (!ticket) return 'Je ne suis pas ce ticket.';
  const lines = [`État : ${ticket.logical}`];
  if (ticket.activeJob) lines.push(`En cours : ${ticket.activeJob}`);
  else if (ticket.verifyingRunId) lines.push('En cours : vérification');
  if (ticket.blocked) lines.push(`Bloqué : ${ticket.blockReason ?? 'sans raison enregistrée'}`);
  lines.push(`Messages en attente de l'agent : ${forAgent(ticket.humanInbox).length} message(s)`);
  return lines.join('\n');
}

/**
 * A delegation on a Linear team no project takes (ORC-171): blocked, whoever delegated (no repo, no role to check),
 * or asked again when already waiting: a wait for a repo with none to choose from (`awaitingRepo: []`). The free text and the session's elicitation are what any block uses today;
 * ORC-196 replaces them with its standard comment.
 */
function noRepoBlock(out: Decision, state: TicketState | undefined, event: FactoryEvent<'ticket.delegated'>, team: string): Decision {
  const reason = `Aucun dépôt connu pour l'équipe Linear ${team} : ajoutez-lui un projet dans la configuration, redémarrez, puis déléguez ce ticket de nouveau.`;
  if (!isNoRepo(state)) out.events.push({ type: 'ticket.blocked', reason }, { type: 'ticket.patched', patch: { awaitingRepo: [] } });
  out.effects.push({ kind: 'activity', type: 'elicitation', body: reason, ...(event.payload.linearSessionId ? { linearSessionId: event.payload.linearSessionId } : {}) });
  // A new ticket: `blockedLabel` sees no state before it and puts no label.
  if (!state) out.effects.push(blockedLabelChange(false, true)!);
  return out;
}

/**
 * Pure: the same state, event, workflow and matrix always give the same decision. The authorization
 * `matrix` (ORC-186) is the default one until the `factory/default` preset declares it (ORC-187).
 */
export function decide(state: TicketState | undefined, event: FactoryEvent, workflow: Workflow, matrix: AuthzMatrix = DEFAULT_MATRIX): Decision {
  const out = decideEvent(state, event, workflow, matrix);
  // A dead notice or label means the tracker is down: nothing more is written to it (no loop, ORC-150).
  const trackerDown = event.type === 'effect.failed' && (event.payload.kind === 'activity' || event.payload.kind === 'labels');
  // An undelegation that lifts a repo choice while the issue's ticket in its repo is blocked leaves the label (ORC-291).
  const keepLabel = event.type === 'ticket.undelegated' && event.payload.keepLabel;
  if (!trackerDown && !keepLabel) blockedLabel(out, state, event);
  // Come from a wait in another project: the label goes now, not at the pass that ends that wait.
  if ((event.payload as { waitedIn?: string }).waitedIn && !out.events.reduce<TicketState | undefined>((t, e) => reduce(t, e), reduce(state, event))?.blocked) {
    out.effects.push(blockedLabelChange(true, false)!);
  }
  acknowledge(out, event, state);
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

/** What a ticket waiting for its repo still handles as usual: the wait's own end, a question run's end, a dead letter. All else is fenced. */
const PAST_THE_WAIT = new Set<EventType>(['ticket.delegated', 'ticket.undelegated', 'run.finished', 'dead_letter.added']);

/** A ticket's wait for its repo is over: its block lifted, the field cleared. */
const END_OF_WAIT = [{ type: 'ticket.unblocked' }, { type: 'ticket.patched', patch: { awaitingRepo: null } }] as const;

/**
 * A ticket whose repo is to be chosen (ORC-291): an event that carries the choice (`repos`) or reaches a ticket
 * blocked for it. A delegation blocks it, whatever blocked it before: `repos` means no project holds it, and under
 * another reason it would hold this one. Already waiting, it is asked again; a mention, a command, a reply or a stop
 * is answered with the same question; anything else fenced decides nothing, so that no rule starts work in a repo
 * picked by default. `undefined`: the event is not such a one, a delegation without `repos` among them: its label
 * names this repo, where it was waiting.
 */
function unrouted(state: TicketState | undefined, event: FactoryEvent): Decision | undefined {
  const repos = (event.payload as { repos?: string[] }).repos;
  if (!repos && (!isUnrouted(state) || PAST_THE_WAIT.has(event.type))) return undefined;
  const out = empty();
  const choices = repos ?? state!.awaitingRepo!;
  const body = unroutedReason(choices);
  const sessionId = (event.payload as { linearSessionId?: string }).linearSessionId;
  if (event.type === 'ticket.delegated' && repos) {
    if (!isUnrouted(state)) out.events.push({ type: 'ticket.blocked', reason: body }, { type: 'ticket.patched', patch: { awaitingRepo: repos } });
    // In the session this delegation opened: the ticket keeps the first one it had.
    out.effects.push({ kind: 'activity', type: 'elicitation', body, ...(sessionId ? { linearSessionId: sessionId } : {}) });
    // A new ticket: `blockedLabel` sees no state before it and puts no label.
    if (!state) out.effects.push(blockedLabelChange(false, true)!);
    return out;
  }
  // Kept for the run that follows the choice (I6).
  if ((event.type === 'session.prompted' || event.type === 'session.mentioned' || event.type === 'command') && event.payload.kind) keepMessage(out, event, 'thread');
  // A team with no repo has no choice to ask for.
  if (sessionId && choices.length > 0 && ['session.mentioned', 'command', 'session.prompted', 'session.stopped'].includes(event.type)) {
    out.effects.push({ kind: 'activity', type: 'response', body, linearSessionId: sessionId });
  }
  out.trace.push(`${event.type}: repo to choose first`);
  return out;
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
  let ticket = reduce(state, event);
  // No ticket out of it (an issue deleted meanwhile, ORC-302): nothing to block or to ask.
  const waiting = ticket && unrouted(state, event);
  if (waiting) return waiting;
  // Before the wait's end below: delegated again, a team with still no repo has chosen nothing.
  if (event.type === 'ticket.delegated' && event.payload.noRepo) return noRepoBlock(out, state, event, event.payload.noRepo);
  if (event.type === 'ticket.delegated' && isUnrouted(ticket)) {
    // Its repo chosen by this delegation, whose session is the ticket's from now on.
    const { linearSessionId } = event.payload;
    for (const e of [...END_OF_WAIT, ...(linearSessionId ? [{ type: 'session.linked' as const, linearSessionId }] : [])]) {
      out.events.push(e);
      ticket = reduce(ticket, e);
    }
  }
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
  // The late webhook of the factory's own move decides nothing (ORC-148: the move to AI Review after a push must not
  // start a second review).
  if (isOwnMoveEcho(state, event)) {
    out.trace.push(`status.changed: already ${state?.logical}, the echo of the factory's own move`);
    return out;
  }
  // A Done from Human Review only: during dev or the AI review it is no review decision, and the rules apply as before.
  const reviewed = state?.delegated && state.logical === 'human_review' && state.prNumber !== undefined && state.prState === 'OPEN';
  if (event.type === 'status.changed' && event.payload.to === 'done' && reviewed) {
    return doneMerge(out, event, state, matrix, workflow);
  }
  if (event.type === 'command' && event.payload.name === REFREEZE) return refreeze(out, event, ticket, matrix);
  if (TRIGGERS.has(event.type)) {
    // The event's facts stay recorded (Linear did delegate, the session exists): only the factory's answer is refused.
    if (!authorize(out, event, ticket, 'trigger', 'linear', matrix)) return out;
    // One active run per ticket (ORC-171): a new delegation stacks no job behind it, and its initiator stays. A pending
    // job alone is no run: a crash can leave one behind. What no webhook brought since ORC-171
    // replays as it was decided; found by the reconciliation, the matrix refuses it above.
    if (event.type === 'ticket.delegated' && event.payload.ack && (state?.activeRunId || state?.verifyingRunId)) {
      out.trace.push('ticket.delegated: a run is active, none started');
      const sessionId = event.payload.linearSessionId;
      if (sessionId) out.effects.push({ kind: 'activity', type: 'response', body: "Un run est déjà en cours sur ce ticket : je n'en lance pas un second.", linearSessionId: sessionId });
      return out;
    }
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
      const { job: jobName, runId, output } = event.payload;
      const job = workflow.jobs[jobName];
      // An attempt that ended gives the lease's relaunch back (ORC-220): only two in a row block.
      if (ticket?.leaseRelaunches && job?.queue === 'dev') out.events.push({ type: 'ticket.patched', patch: { leaseRelaunches: 0 } });
      if (!job || event.payload.outcome === 'stopped') return out;
      const outcome = job.queue === 'dev' ? (stagnationBlock(event.payload, workflow) ?? attemptDecision(event.payload, job)) : event.payload.outcome;
      // Already blocked (the agent asked through `ask`, a human's stop…): it keeps its reason and gets no second notice.
      if (typeof outcome === 'object') return ticket?.blocked ? out : block(out, outcome.reason, outcome.body);
      // A run that ended well on a ticket already blocked (`ask`, then the end of its turn): no output is expected of it, its question stays.
      if (event.payload.outcome === 'success' && ticket?.blocked && job.queue === 'dev') return out;
      if (outcome === 'success') {
        if (job.verify.length === 0 && !job.repoChecks && !job.red && !goesThroughFreeze(ticket, job)) return success(out, { event, ticket, workflow }, job, runId, output);
        out.events.push({ type: 'verify.started', runId });
        out.effects.push({ kind: 'run_verify', runId, job: jobName, ...(output ? { output } : {}) });
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
    case 'run.lost':
      return attemptLost(out, event, ticket, workflow);
    case 'verify.lost': {
      const { runId, job, output } = event.payload;
      const recent = ticket ? recentCuts(ticket, event.at) : [];
      if (recent.length >= CUT_RELAUNCHES) {
        // Nothing runs it any more: the ticket must not wait for its verdict, or no later start would pass it.
        out.events.push({ type: 'work.cancelled' });
        return ticket?.blocked ? out : blockOnCuts(out);
      }
      out.events.push({ type: 'ticket.patched', patch: { cutRelaunches: [...recent, event.at] } });
      out.effects.push({ kind: 'run_verify', runId, job, ...(output ? { output } : {}) });
      return out;
    }
    case 'verify.passed': {
      const job = workflow.jobs[event.payload.job];
      if (!job) return out;
      // The commit found green goes out, and the job ends once it is out: until then the ticket stays held, and a stop fences the result. No sha: no commit to publish.
      const toPublish = publishes(job) ? event.payload.sha : undefined;
      const patch = { verifyAttempts: 0, ...(ticket?.repeatedFailure ? { repeatedFailure: null } : {}), ...(ticket?.redAttempts ? { redAttempts: 0 } : {}), ...(event.payload.sha ? { verifiedSha: event.payload.sha } : {}), ...(toPublish && job.onSuccess.move ? { owedMove: job.onSuccess.move } : {}) };
      out.events.push({ type: 'ticket.patched', patch });
      if (job.red) freeze(out, ticket, event.payload.frozen);
      if (toPublish) {
        const { runId, output } = event.payload;
        out.events.push({ type: 'verify.started', runId });
        out.effects.push({ kind: 'publish', runId, job: job.name, sha: toPublish, ...(output ? { output } : {}) });
        return out;
      }
      return success(out, { event, ticket, workflow }, job, event.payload.runId, event.payload.output);
    }
    case 'publish.done': {
      const job = workflow.jobs[event.payload.job];
      if (!job) return out;
      // Owed by an earlier job of the ticket, whose publication was refused: first, as the job's own would be.
      const owed = ticket?.owedMove;
      if (owed) {
        out.events.push({ type: 'ticket.patched', patch: { owedMove: null } });
        if (!job.onSuccess.move) out.effects.push({ kind: 'move', to: owed });
      }
      return success(out, { event, ticket, workflow }, job, event.payload.runId, event.payload.output);
    }
    case 'publish.refused': {
      const reason = `Publication refusée : ${event.payload.reason}`;
      return ticket?.blocked ? out : block(out, reason, `${reason}\nRépondez dans ce fil pour relancer.`);
    }
    case 'verify.failed': {
      const used = ticket?.verifyAttempts ?? 0;
      const { failures, job } = event.payload;
      const checked = workflow.jobs[job];
      if (checked?.red) return redFailed(out, { event, ticket, workflow }, checked, checked.red);
      if (checked?.verifyFailure === 'block') {
        const reason = `Vérifications en échec après ${job} : le commit n'est pas publiable, et ce job ne le corrige pas.`;
        return block(out, reason, `${reason}\n${formatFailuresShort(failures)}\nRépondez dans ce fil pour relancer.`);
      }
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
    case 'verify.errored': {
      // Not a failure of the work: no counter moves, and the agent gets nothing to fix. A human relaunch checks again.
      const reason = `La vérification de ${event.payload.job} n'a pas pu tourner : panne d'infrastructure, l'agent n'est pas en cause.`;
      return ticket?.blocked ? out : block(out, reason, `${reason}\n${event.payload.error}\nRépondez dans ce fil pour que je reprenne.`);
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
      const held = fired.payload.inbox ? heldInbox(ticket) : undefined;
      if (held) {
        out.trace.push(`timer.fired debounce: ${job.name} not started, ${held}`);
        return out;
      }
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
      const { refused } = event.payload;
      if (refused) {
        // The ticket holding it is not at fault: never blocked. A thought leaves its session as it is (a run, a question
        // waiting); the session the refused event came from gets its answer. No session is opened when that one can be told.
        const from = refused.linearSessionId;
        const body = heldMessage(event.payload, refused.projectId, ticket.projectId, ticket.ticketId);
        if (ticket.linearSessionId || !from) out.effects.push({ kind: 'activity', type: 'thought', body });
        if (from && from !== ticket.linearSessionId) out.effects.push({ kind: 'activity', type: 'response', body, linearSessionId: from });
        return out;
      }
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
      if (isRefusedNotice(eventId)) {
        out.trace.push('effect.failed ignored: the notice of a refused event, which blocks nothing');
        return out;
      }
      // Nothing more comes of it: no result will lift the hold `verify.passed` kept.
      if (kind === 'publish' && ticket.verifyingRunId) out.events.push({ type: 'work.cancelled' });
      // A Done whose merge died (ORC-148) is not delivered: the human hears it, the ticket back in Human Review. Once a
      // human took it out of Done meanwhile, the merge was given up: only answered, as a late refusal is.
      if (kind === 'merge' && ticket.prState !== 'MERGED') {
        const failed = `Je n'ai pas pu merger la PR #${ticket.prNumber} : ${error}.`;
        if (ticket.logical === 'done') return backToReview(out, failed);
        out.trace.push(`merge died, the ticket left Done (${ticket.logical}): answered only`);
        out.effects.push({ kind: 'comment', body: failed });
        return out;
      }
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
    case 'ticket.undelegated':
      // Its team got a repo, or delegated again with its `repo:` label the ticket went to its repo: here nothing waits any longer (ORC-171, ORC-291).
      if (isUnrouted(ticket)) out.events.push(...END_OF_WAIT);
      break;
    case 'label.changed': {
      // Routing is sticky (ORC-291): a ticket at work stays in its repo, whichever repo of the team a label added names.
      const { change, otherRepo } = event.payload;
      if (change === 'added' && otherRepo && ticket && holds(ticket)) {
        out.effects.push({ kind: 'comment', body: `Ce ticket reste sur le dépôt ${event.projectId} : le dépôt ne change pas en cours de route. Sans branche ni PR, arrêtez le travail, retirez la délégation, attendez 5 minutes que la réconciliation la voie, puis déléguez de nouveau. Sinon, ouvrez un nouveau ticket pour l'autre dépôt.` });
      }
      break;
    }
    case 'pr.merge_refused':
      return mergeRefused(out, event, ticket, workflow);
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
    case 'session.mentioned':
      // Kept, as any message (ORC-180). One that asks for an action never takes the question path of its rule.
      if (event.payload.kind && ticket) {
        const order = event.payload.kind === 'instruction' && ticket.delegated;
        keepMessage(out, event, order ? 'session' : 'thread');
        if (order) return ticket.blocked ? out : regroup(out, event, ticket, workflow);
      }
      break;
    case 'command':
      if (event.payload.kind && ticket) keepMessage(out, event, 'session', `${event.payload.name} ${event.payload.body}`.trim());
      break;
    case 'session.prompted':
      if (event.payload.kind) return classifiedReply(out, event, state, ticket, workflow, matrix);
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
      if (ticket) keepMessage(out, event, 'session');
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
