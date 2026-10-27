import type { JobSpec, Rule, Workflow } from '../config/workflow-schema.js';
import { evalCondition } from './conditions.js';
import type { Decision, Effect } from './decision.js';
import { reduce } from './reduce.js';
import type { EventType, FactoryEvent, InputKind, Taint, TicketState, VerifyFailure } from './types.js';

type StartRun = Extract<Effect, { kind: 'start_run' }>;

const STOP_MESSAGE = 'Arrêté. Répondez dans ce fil ou posez le label agent:reprendre pour relancer.';
const STOPPED = 'Arrêté à la demande';

/** Paths a run started from an untrusted event must not write; enforced by the runner's sandbox (ORC-151). */
export const SENSITIVE_PATHS: readonly string[] = ['.github/**', '.factory/**', '.claude/**', 'CODEOWNERS', '.env*'];

export function taintedKnowledge(job: string): string {
  return `Je ne lance pas ${job} : ce job écrit dans la base de connaissances, et l'événement vient d'une source non fiable.`;
}

const BUILT_IN = new Set<EventType>([
  'control.pause', 'control.resume', 'control.stop', 'run.finished', 'verify.passed', 'verify.failed', 'debounce.fired', 'pr.opened',
  'effect.done', 'effect.failed',
]);

function empty(): Decision {
  return { events: [], effects: [], timers: [], trace: [] };
}

function stop(out: Decision): Decision {
  out.events.push({ type: 'work.cancelled' }, { type: 'ticket.blocked', reason: STOPPED });
  out.effects.push({ kind: 'stop_run' }, { kind: 'activity', type: 'response', body: STOP_MESSAGE });
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
 * red-CI count resets; by a machine event (a timer, red CI itself), it does not, or a timer armed before
 * the block would undo it.
 */
function unblock(out: Decision, event: FactoryEvent, ticket: TicketState): void {
  out.events.push({ type: 'ticket.unblocked' });
  if (HUMAN_RELAUNCH.has(event.type)) resetRedCi(out, ticket);
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
  const feedback = input === 'feedback' ? (ticket?.pendingFeedback ?? []) : [];
  return feedback.some((f) => f.taint === 'untrusted') ? 'untrusted' : 'trusted';
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

function ruleMatches(rule: Rule, event: FactoryEvent, ticket: TicketState | undefined, activeJob: string | undefined): boolean {
  if (event.type === 'status.changed') {
    if (rule.from && rule.from !== event.payload.from) return false;
    if (rule.to && rule.to !== event.payload.to) return false;
  }
  // Rules under label.changed see additions only, as under label.added before the rename.
  if (event.type === 'label.changed' && event.payload.change !== 'added') return false;
  if (rule.label !== undefined && (event.type !== 'label.changed' || event.payload.label !== rule.label)) return false;
  if (rule.say !== undefined && (event.type !== 'command' || event.payload.name !== rule.say)) return false;
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
    item: { author: event.payload.author, body: event.payload.body, at: event.at, source: 'session', taint: event.taint },
  });
}

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
    out.timers.push({ kind: 'debounce', job: job.name, ms: rule.debounceMs });
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

/** Pure: the same state, event and workflow always give the same decision. */
export function decide(state: TicketState | undefined, event: FactoryEvent, workflow: Workflow): Decision {
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
      out.events.push({ type: 'ticket.patched', patch: { verifyAttempts: 0 } });
      return success(out, job, event.payload.runId);
    }
    case 'verify.failed': {
      const used = ticket?.verifyAttempts ?? 0;
      const { failures, job } = event.payload;
      if (used + 1 < workflow.limits.verifyAttempts) {
        out.events.push({ type: 'ticket.patched', patch: { verifyAttempts: used + 1 } });
        const spec = workflow.jobs[job];
        if (spec) startRun(out, event, ticket, spec, { input: 'verify_failures', inputText: JSON.stringify(failures), resume: true });
        return out;
      }
      const reason = `Vérifications toujours en échec après ${workflow.limits.verifyAttempts} tentatives.`;
      return block(out, reason, `${reason}\n${formatFailuresShort(failures)}\nRépondez dans ce fil pour relancer.`);
    }
    case 'debounce.fired': {
      const job = workflow.jobs[event.payload.job];
      if (!job) return out;
      if (ticket?.blocked && !refusal(event, ticket, job)) unblock(out, event, ticket);
      startRun(out, event, ticket, job, { input: job.input });
      return out;
    }
    case 'effect.done':
      return out;
    case 'effect.failed': {
      // `settle` is a step of the shell, not an effect of the workflow: its failure is only logged.
      const { kind, error, eventId } = event.payload;
      if (kind === 'settle' || !ticket) return out;
      // Nothing left to block: a delivered ticket, or one a human stopped (its reason stays).
      if (ticket.logical === 'done' || ticket.prState === 'MERGED' || (ticket.blocked && ticket.blockReason === STOPPED)) {
        out.trace.push(`effect.failed ignored: ticket ${ticket.logical === 'done' || ticket.prState === 'MERGED' ? 'delivered' : 'stopped'}`);
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
    case 'pr.checks_passed':
      // Green CI ends the red-CI loop: its count starts over (ORC-270). The rules of pr.checks_passed still apply.
      // A ticket blocked by the red-CI bound is no longer blocked for a reason that holds: the block is lifted.
      resetRedCi(out, ticket);
      if (ticket?.blocked && ticket.blockReason?.startsWith(RED_CI_BLOCKED)) out.events.push({ type: 'ticket.unblocked' });
      break;
    case 'pr.opened': {
      // A new PR (another number) reopens a delivered ticket; the same PR seen again leaves it as it is.
      const reopens = event.payload.number !== ticket?.prNumber;
      // Another PR is another red-CI loop: the count of the previous one does not carry over (ORC-270).
      if (reopens) resetRedCi(out, ticket);
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
        out.trace.push('built-in session.prompted (question session)');
        const ask = workflow.jobs['ask'];
        if (ask) startRun(out, event, ticket, ask, { input: 'thread', inputText: event.payload.body, linearSessionId: event.payload.linearSessionId });
        return out;
      }
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
  if (event.type === 'pr.checks_failed' && rule.run) return fixRedCi(out, rule, event, ticket, workflow);
  return applyRule(out, rule, event, ticket, workflow);
}
