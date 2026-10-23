import type { JobSpec, Rule, Workflow } from '../config/workflow-schema.js';
import { evalCondition } from './conditions.js';
import type { Decision, Effect } from './decision.js';
import { reduce } from './reduce.js';
import type { EventType, FactoryEvent, TicketState, VerifyFailure } from './types.js';

type StartRun = Extract<Effect, { kind: 'start_run' }>;

const STOP_MESSAGE = 'Arrêté. Répondez dans ce fil ou posez le label agent:reprendre pour relancer.';

/** Paths a run started from an untrusted event must not write; enforced by the runner's sandbox (ORC-151). */
export const SENSITIVE_PATHS: readonly string[] = ['.github/**', '.factory/**', '.claude/**', 'CODEOWNERS', '.env*'];

export const TAINTED_KNOWLEDGE =
  "Je n'écris pas dans la base de connaissances à partir d'un contenu non fiable. Un humain peut relancer la demande lui-même.";

const BUILT_IN = new Set<EventType>([
  'control.pause', 'control.resume', 'control.stop', 'run.finished', 'verify.passed', 'verify.failed', 'debounce.fired', 'pr.opened',
]);

function empty(): Decision {
  return { events: [], effects: [], timers: [], trace: [] };
}

function stop(out: Decision): Decision {
  out.events.push({ type: 'work.cancelled' }, { type: 'ticket.blocked', reason: 'Arrêté à la demande' });
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

/** A Linear session that carries questions (read-only answers), not the ticket's dev conversation. */
export function isQuestionSession(ticket: TicketState | undefined, sessionId: string | undefined): boolean {
  if (!ticket || !sessionId) return false;
  if (!ticket.delegated) return true;
  if (ticket.questionSessionIds.includes(sessionId)) return true;
  return !!ticket.linearSessionId && sessionId !== ticket.linearSessionId;
}

/** A run started from untrusted content carries the paths it must not write. */
function guard(event: FactoryEvent, effect: StartRun): StartRun {
  return event.taint === 'untrusted' ? { ...effect, sensitivePaths: SENSITIVE_PATHS } : effect;
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
  if (rule.label !== undefined && (event.type !== 'label.changed' || event.payload.change !== 'added' || event.payload.label !== rule.label)) {
    return false;
  }
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

function applyRule(out: Decision, rule: Rule, event: FactoryEvent, ticket: TicketState | undefined, workflow: Workflow): Decision {
  if (event.type === 'session.prompted') {
    out.events.push({
      type: 'feedback.appended',
      item: { author: event.payload.author, body: event.payload.body, at: event.at, source: 'session' },
    });
  }
  const job = rule.run ? workflow.jobs[rule.run]! : undefined;
  const threaded = event.type === 'session.mentioned' || event.type === 'command';
  const linearSessionId = threaded ? event.payload.linearSessionId : undefined;
  const refused = job?.workspace === 'knowledge' && event.taint === 'untrusted';
  if (job && !refused && ticket?.blocked) out.events.push({ type: 'ticket.unblocked' });
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
  if (job && refused) {
    out.trace.push(`taint: refused ${job.name}`);
    out.effects.push({ kind: 'activity', type: 'response', body: TAINTED_KNOWLEDGE, linearSessionId });
  } else if (job && rule.debounceMs && rule.debounceMs > 0) {
    out.timers.push({ kind: 'debounce', job: job.name, ms: rule.debounceMs });
  } else if (job) {
    out.effects.push(guard(event, {
      kind: 'start_run',
      job: job.name,
      input: job.input,
      inputText: threaded ? event.payload.body : undefined,
      linearSessionId,
    }));
  }
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

/** Pure: the same state, event and workflow always give the same decision. */
export function decide(state: TicketState | undefined, event: FactoryEvent, workflow: Workflow): Decision {
  const out = empty();
  const fence = staleAttempt(state, event, workflow);
  if (fence) {
    out.trace.push(`${FENCED}${fence}`);
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
        out.effects.push({ kind: 'start_run', job, input: 'verify_failures', inputText: JSON.stringify(failures), resume: true });
        return out;
      }
      const reason = `Vérifications toujours en échec après ${workflow.limits.verifyAttempts} tentatives.`;
      return block(out, reason, `${reason}\n${formatFailuresShort(failures)}\nRépondez dans ce fil pour relancer.`);
    }
    case 'debounce.fired': {
      const job = workflow.jobs[event.payload.job];
      if (!job) return out;
      if (ticket?.blocked) out.events.push({ type: 'ticket.unblocked' });
      out.effects.push({ kind: 'start_run', job: job.name, input: job.input });
      return out;
    }
    case 'pr.opened':
      out.events.push({ type: 'ticket.patched', patch: { prNumber: event.payload.number, prUrl: event.payload.url } });
      out.effects.push({ kind: 'link_pr', url: event.payload.url });
      return out;
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
        if (!workflow.jobs['ask']) return out;
        out.effects.push(guard(event, { kind: 'start_run', job: 'ask', input: 'thread', inputText: event.payload.body, linearSessionId: event.payload.linearSessionId }));
        return out;
      }
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
  return applyRule(out, rules[index]!, event, ticket, workflow);
}
