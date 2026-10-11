import type { JobSpec, Rule, Workflow } from '../config/workflow-schema.js';
import type { Command } from './commands.js';
import { evalCondition } from './conditions.js';
import type { RelaisEvent, TicketState, VerifyFailure } from './types.js';

export interface DecideContext {
  workflow: Workflow;
  activeJob?: string;
}

const STOP_MESSAGE = 'Arrêté. Répondez dans ce fil ou posez le label agent:reprendre pour relancer.';

function stopCommands(): Command[] {
  return [
    { kind: 'stop_run' },
    { kind: 'block', reason: 'Arrêté à la demande' },
    { kind: 'activity', type: 'response', body: STOP_MESSAGE },
  ];
}

function successCommands(job: JobSpec, runId: string): Command[] {
  const out: Command[] = [];
  if (job.onSuccess.move) out.push({ kind: 'move', to: job.onSuccess.move });
  if (job.onSuccess.post) out.push({ kind: 'post_output', style: job.onSuccess.post, runId });
  return out;
}

/** A Linear session that carries questions (read-only answers), not the ticket's dev conversation. */
export function isQuestionSession(ticket: TicketState | undefined, sessionId: string | undefined): boolean {
  if (!ticket || !sessionId) return false;
  if (!ticket.delegated) return true;
  if (ticket.questionSessionIds.includes(sessionId)) return true;
  return !!ticket.linearSessionId && sessionId !== ticket.linearSessionId;
}

/** Non-delegated tickets only ever get question-queue work. */
function ruleAllowed(rule: Rule, event: RelaisEvent, ticket: TicketState | undefined, workflow: Workflow): boolean {
  if (!rule.run || !ticket || ticket.delegated || event.type === 'ticket.delegated') return true;
  return workflow.jobs[rule.run]?.queue === 'questions';
}

export function formatFailuresShort(failures: VerifyFailure[]): string {
  return failures.map((f) => `- \`${f.command}\` (code ${f.exitCode ?? 'timeout'})`).join('\n');
}

function ruleMatches(rule: Rule, event: RelaisEvent, ticket: TicketState | undefined, ctx: DecideContext): boolean {
  if (event.type === 'ticket.moved') {
    if (rule.from && rule.from !== event.payload.from) return false;
    if (rule.to && rule.to !== event.payload.to) return false;
  }
  if (rule.label !== undefined && (event.type !== 'label.added' || event.payload.label !== rule.label)) return false;
  if (rule.say !== undefined && (event.type !== 'command' || event.payload.name !== rule.say)) return false;
  if (rule.when) {
    return evalCondition(rule.when, {
      state: ticket?.logical ?? 'todo',
      blocked: ticket?.blocked ?? false,
      job: ctx.activeJob,
    });
  }
  return true;
}

function ruleCommands(rule: Rule, event: RelaisEvent, ticket: TicketState | undefined, ctx: DecideContext): Command[] {
  const out: Command[] = [];
  if (event.type === 'session.prompted') {
    out.push({
      kind: 'append_feedback',
      item: { author: event.payload.author, body: event.payload.body, at: event.at, source: 'session' },
    });
  }
  if (rule.run && ticket?.blocked) out.push({ kind: 'unblock' });
  if (rule.move) out.push({ kind: 'move', to: rule.move });
  if (rule.labels) out.push({ kind: 'labels', add: rule.labels.add, remove: rule.labels.remove });
  if (rule.comment) out.push({ kind: 'comment', body: rule.comment });
  if (rule.do === 'stop') out.push(...stopCommands());
  if (rule.do === 'cleanup') out.push({ kind: 'cleanup' });
  if (rule.do === 'propose_delegate') {
    out.push({
      kind: 'activity',
      type: 'response',
      body: 'Pour que je développe ce ticket, déléguez-le moi (champ « Agent » du ticket).',
    });
  }
  if (rule.run) {
    const job = ctx.workflow.jobs[rule.run]!;
    if (rule.debounceMs && rule.debounceMs > 0) {
      out.push({ kind: 'set_debounce', job: job.name, ms: rule.debounceMs });
    } else {
      const threaded = event.type === 'session.mentioned' || event.type === 'command';
      out.push({
        kind: 'start_run',
        job: job.name,
        input: job.input,
        inputText: threaded ? event.payload.body : undefined,
        linearSessionId: threaded ? event.payload.linearSessionId : undefined,
      });
    }
  }
  return out;
}

export function decide(event: RelaisEvent, ticket: TicketState | undefined, ctx: DecideContext): Command[] {
  const { workflow } = ctx;
  switch (event.type) {
    case 'control.pause':
      return [{ kind: 'set_paused', paused: true }];
    case 'control.resume':
      return [{ kind: 'set_paused', paused: false }];
    case 'control.stop':
      return stopCommands();
    case 'run.finished': {
      const { outcome, job: jobName, runId } = event.payload;
      const job = workflow.jobs[jobName];
      if (!job || outcome === 'stopped') return [];
      if (outcome === 'success' && ticket?.blocked && job.queue === 'dev') return [];
      if (outcome === 'success') return job.verify.length > 0 ? [{ kind: 'run_verify', runId, job: jobName }] : successCommands(job, runId);
      if (job.queue === 'questions') {
        return [{ kind: 'activity', type: 'error', body: "Je n'ai pas pu terminer (échec ou plafond atteint).", runId }];
      }
      const reason =
        outcome === 'limit'
          ? `Le run ${jobName} a atteint un plafond (tours, durée ou budget).`
          : `Le run ${jobName} a échoué.`;
      return [
        { kind: 'block', reason },
        { kind: 'activity', type: 'elicitation', body: `${reason} Répondez dans ce fil pour que je reprenne.` },
      ];
    }
    case 'verify.passed': {
      const job = workflow.jobs[event.payload.job];
      if (!job) return [];
      return [{ kind: 'patch_ticket', patch: { verifyAttempts: 0 } }, ...successCommands(job, event.payload.runId)];
    }
    case 'verify.failed': {
      const used = ticket?.verifyAttempts ?? 0;
      const { failures, job } = event.payload;
      if (used + 1 < workflow.limits.verifyAttempts) {
        return [
          { kind: 'patch_ticket', patch: { verifyAttempts: used + 1 } },
          { kind: 'start_run', job, input: 'verify_failures', inputText: JSON.stringify(failures), resume: true },
        ];
      }
      const reason = `Vérifications toujours en échec après ${workflow.limits.verifyAttempts} tentatives.`;
      return [
        { kind: 'block', reason },
        { kind: 'activity', type: 'elicitation', body: `${reason}\n${formatFailuresShort(failures)}\nRépondez dans ce fil pour relancer.` },
      ];
    }
    case 'debounce.fired': {
      const job = workflow.jobs[event.payload.job];
      if (!job) return [];
      const out: Command[] = ticket?.blocked ? [{ kind: 'unblock' }] : [];
      out.push({ kind: 'start_run', job: job.name, input: job.input });
      return out;
    }
    case 'pr.opened':
      return [
        { kind: 'patch_ticket', patch: { prNumber: event.payload.number, prUrl: event.payload.url } },
        { kind: 'link_pr', url: event.payload.url },
      ];
    case 'session.stopped': {
      const sessionId = event.payload.linearSessionId;
      if (isQuestionSession(ticket, sessionId)) {
        return [
          { kind: 'stop_run', linearSessionId: sessionId },
          { kind: 'activity', type: 'response', body: 'Arrêté.', linearSessionId: sessionId },
        ];
      }
      break;
    }
    case 'session.prompted':
      if (isQuestionSession(ticket, event.payload.linearSessionId)) {
        if (!workflow.jobs['ask']) return [];
        return [
          { kind: 'start_run', job: 'ask', input: 'thread', inputText: event.payload.body, linearSessionId: event.payload.linearSessionId },
        ];
      }
      break;
    default:
      break;
  }
  const rules = workflow.on[event.type] ?? [];
  const rule = rules.find((r) => ruleAllowed(r, event, ticket, workflow) && ruleMatches(r, event, ticket, ctx));
  return rule ? ruleCommands(rule, event, ticket, ctx) : [];
}
