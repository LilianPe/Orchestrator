import { REFREEZE, type FrozenTests } from '../checks/freeze.js';
import type { JobSpec, ReviewLens, Rule, Workflow } from '../config/workflow-schema.js';
import { allowed, DEFAULT_MATRIX, refusalMessage, type AuthzAction, type AuthzMatrix, type Channel } from './authz.js';
import { evalCondition } from './conditions.js';
import { deadLetterReason, deadLetterTried, heldMessage, isRefusedNotice, liftDeadLetterBlock, REPAIR_LABELS, repairedEvent } from './dead-letter.js';
import type { AgentOutput, ConflictCase } from './agent-output.js';
import { blockFacts, type BlockFacts } from './block-comment.js';
import { AGENT_QUESTION, causeOf, CLARIFY_EXPIRED, NO_ASSESSMENT, PAUSED, STOPPED, type BlockKind } from './block-cause.js';
import type { Decision, Effect } from './decision.js';
import { awaitsAgent, commandOf, forAgent, STOP_COMMAND } from './human-message.js';
import { PRODUCT_NAME } from '../product.js';
import { CUT_RELAUNCHES, CUT_WINDOW_MS } from '../store/types.js';
import { isOwnMoveEcho, pendingOf, reduce } from './reduce.js';
import { blockingTotal, isBlocking } from './review.js';
import { holds, isNoRepo, isUnrouted, repoLabel, unroutedReason } from './routing.js';
import { higherRisk, type Blocker, type ClarifyQuestion, type EventPayloads, type EventType, type FactoryEvent, type FeedbackItem, type InputKind, type MessageKind, type PendingJob, type RunOutcome, type Taint, type TicketState, type VerifyFailure } from './types.js';

type StartRun = Extract<Effect, { kind: 'start_run' }>;

/** What a stop's answer says of the way back: versions frozen before ORC-196 keep their label. */
const relaunch = (workflow: Workflow): string => (workflow.blockComment ? 'Reply on this ticket to relaunch.' : 'Reply in this thread or add the agent:reprendre label to relaunch.');

/**
 * The mark of a run started from untrusted content (I12, ORC-274), carried by its `start_run` and its run record. Only its
 * presence is read: it sets `TicketState.untrustedSince` (ORC-338), from which the repository's `sensitive_paths` are
 * refused. What every run is refused is `FORBIDDEN_PATHS`. Kept a list, not a flag, as the journals record it in decisions.
 */
export const SENSITIVE_PATHS: readonly string[] = ['.github/**', '.factory/**', '.claude/**', 'CODEOWNERS', '.env*'];

/**
 * The refusal of a knowledge job (I12): its event is untrusted, or what it would read at its launch is (ORC-274), the
 * ticket and its PR included (ORC-349).
 */
export function taintedKnowledge(job: string, source: 'event' | 'read' | 'history' = 'event'): string {
  const what = {
    event: 'the event comes',
    read: 'the feedback it would read (thread or review comments) comes',
    history: 'what it would read of the ticket and its PR (reviews, messages, commits) comes in part',
  }[source];
  return `I am not starting ${job}: this job writes to the knowledge base, and ${what} from an untrusted source.`;
}

/**
 * The events whose text or code a run reads later through the ticket or its PR, not only as its input (ORC-349): the
 * ticket a delegation brings, a human message, a review of the PR, the commits a human pushed. The others carry nothing
 * an agent reads (a move, a label, CI's facts) or what the factory wrote itself. `HUMAN_EVENTS` without its move and label, and the
 * forge's two: a human event added there that brings text belongs here too.
 */
const CONTENT_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['ticket.delegated', 'session.prompted', 'session.mentioned', 'command', 'ticket.commented', 'pr.reviewed', 'push.human']);

/**
 * The taint of a ticket's history, as a run that reads the ticket and its PR takes it in (ORC-349): untrusted once an
 * untrusted event brought it content, whoever starts that run. `Orchestrator.launch` adds the branch's mark (ORC-338).
 */
export function historyTaint(events: readonly FactoryEvent[]): Taint {
  return events.some((e) => e.taint === 'untrusted' && CONTENT_EVENTS.has(e.type) && !silentReview(e)) ? 'untrusted' : 'trusted';
}

/**
 * The Linear messages whose text `ingestedConversation` gives. A command is control, not knowledge; a review is GitHub's,
 * untrusted whoever wrote it (ORC-160), so never given.
 */
const CONVERSATION: ReadonlySet<EventType> = new Set<EventType>(['session.prompted', 'session.mentioned', 'ticket.commented']);

/**
 * What `learn` after a merge is given of the ticket's conversation, in place of reading the PR itself (ORC-361): the Linear
 * messages the factory ingested, in their order, as it would hand them to an agent (`keepMessage`, `forAgent`). Only trusted
 * ones, never one the matrix refused (`refused`, the ids of those events): untrusted content is never read as knowledge,
 * whatever `historyTaint` lets through. What the forge holds that was never ingested (a comment on the PR's conversation, any
 * review with GitHub webhooks off) is not in the journal, so not here either.
 */
export function ingestedConversation(events: readonly FactoryEvent[], refused: ReadonlySet<string> = new Set()): FeedbackItem[] {
  const given = events.filter((e): e is HumanMessage => e.taint !== 'untrusted' && CONVERSATION.has(e.type) && !refused.has(e.id));
  return forAgent(given.map((e) => messageItem(e, 'session'))).filter((i) => i.body.trim());
}

/** A review without a word (an approval, most often): it brings nothing a run reads. */
function silentReview(e: FactoryEvent): boolean {
  return e.type === 'pr.reviewed' && !(e as FactoryEvent<'pr.reviewed'>).payload.body.trim();
}

const BUILT_IN = new Set<EventType>([
  'control.pause', 'control.resume', 'control.stop', 'run.finished', 'run.lost', 'verify.passed', 'verify.failed', 'verify.errored', 'verify.lost', 'publish.done', 'publish.refused', 'timer.fired', 'pr.opened',
  'effect.done', 'effect.failed', 'dead_letter.added', 'agent.asked', 'blockers.done',
]);

function empty(): Decision {
  return { events: [], effects: [], timers: [], trace: [] };
}

/** The ticket's work stops: the run in flight, the check awaited, the waiting job and the timers (`stop_run` clears them). */
function cancelWork(out: Decision, why: string): Decision {
  out.trace.push(why);
  out.events.push({ type: 'work.cancelled' });
  out.effects.push({ kind: 'stop_run' });
  return out;
}

/** The ticket's work stops and it is blocked for `reason` until a human relaunches it; `body` tells the session: a stop is an answer, not an escalation. */
function stop(out: Decision, workflow: Workflow, reason = STOPPED, body = `Stopped. ${relaunch(workflow)}`, kind: BlockKind = 'stopped'): Decision {
  out.events.push({ type: 'work.cancelled' }, { type: 'ticket.blocked', reason, kind });
  out.effects.push({ kind: 'stop_run' }, { kind: 'activity', type: 'response', body });
  return out;
}

/** The job's `on_success`, its `run` included (ORC-123: `tests` starts `dev`). */
function success(out: Decision, at: { event: FactoryEvent; ticket: TicketState | undefined; workflow: Workflow }, job: JobSpec, runId: string, output?: AgentOutput): Decision {
  // A fix of the review loop ends in AI Review already (ORC-184): no move to the state the ticket is in.
  if (job.onSuccess.move && job.onSuccess.move !== at.ticket?.logical) out.effects.push({ kind: 'move', to: job.onSuccess.move });
  // `review`: the findings, published by the `review` effect (`reviewEnd`); nothing of the lens's summary goes to Linear.
  if (job.onSuccess.post && job.onSuccess.post !== 'review') out.effects.push({ kind: 'post_output', style: job.onSuccess.post, runId, ...(output ? { output } : {}) });
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
  if (job.queue !== 'dev' || !ticket?.delegated || heldInbox(ticket)) return;
  // A move owed by an earlier job is made by this end too (`publish.done`).
  const after = { ...ticket, logical: job.onSuccess.move ?? ticket.owedMove ?? ticket.logical };
  // The first rule that matches, as a reply would pick it: one with no run listed first starts nothing.
  const rule = workflow.on['session.prompted']?.[firstRule('session.prompted', event, after, workflow)];
  const next = rule?.run ? workflow.jobs[rule.run] : undefined;
  if (!next) return;
  out.trace.push(`human inbox: handed over to ${next.name} at the end of ${job.name}`);
  humanRound(out, event, after, workflow, next, { input: next.input });
}

/**
 * The end of `intake` (ORC-206): its assessment is recorded, then the guard before In Progress. Within a run the risk
 * never goes down (I4) and the visual proof only hardens to `required`; a new run starts from neither (`newRun`). A
 * ticket not complete enough, by intake's judgement or by the deterministic checks of its launch, does not start: `clarify` asks its questions (ORC-210), and nothing moves to In
 * Progress meanwhile. A complete one « blocked by » a ticket not done waits for it (ORC-363).
 */
function intakeEnd(out: Decision, at: { event: FactoryEvent; ticket: TicketState | undefined; workflow: Workflow }, job: JobSpec, p: EventPayloads['run.finished']): Decision {
  const a = p.output?.intake;
  if (!a) {
    const reason = NO_ASSESSMENT;
    return block(out, at.workflow, { kind: 'failed', reason, body: `${reason} Reply in this thread and I will resume.`, job: job.name, tried: [`Started the run ${job.name}: its result has no \`intake\` field.`] });
  }
  out.events.push({ type: 'ticket.patched', patch: { size: a.size, risk: higherRisk(at.ticket?.risk, a.risk), ...(a.screen ? { visualProof: 'required' as const } : {}) } });
  const checks = p.pickup ?? [];
  if (!checks.length && a.complete) {
    // Complete, but « blocked by » a ticket not done (ORC-363): what it would start waits for it.
    const next = job.onSuccess.run ? at.workflow.jobs[job.onSuccess.run] : undefined;
    if (!next || !p.blockedBy?.length) return success(out, at, job, p.runId);
    // Its assessment is posted now; a move it owes waits with the start, which moves the ticket itself (`dev`'s `on_start`).
    if (job.onSuccess.post && job.onSuccess.post !== 'review') out.effects.push({ kind: 'post_output', style: job.onSuccess.post, runId: p.runId, ...(p.output ? { output: p.output } : {}) });
    return waitFor(out, p.blockedBy, pendingOf({ job: next.name, input: next.input }));
  }
  // Incomplete: the questions come first, blocked by a ticket or not; intake runs again after the last answer and comes back here.
  // A failed check is a fact, not a question: the ticket's to complete, answered freely, within the 3 questions.
  const completeIt: ClarifyQuestion[] = checks.length ? [{ question: `${checks.join(' ')} Can you complete the ticket, then reply here?`, options: [] }] : [];
  const asked = a.complete ? [] : a.missing.map((m) => (typeof m === 'string' ? { question: m, options: [] } : m));
  return clarify(out, at.event, job, [...completeIt, ...asked].slice(0, CLARIFY_MAX));
}

/** At most this many questions at once (MVP doc; 5 is EVP 1's). */
const CLARIFY_MAX = 3;
/** The reminder of the questions still open, then the block (ORC-210), on the decision's clock. */
export const CLARIFY_REMIND_MS = 24 * 3_600_000;
export const CLARIFY_EXPIRE_MS = 72 * 3_600_000;

/**
 * The question `n` of `questions` as the session shows it: picked in its options (`select`), or answered in the human's
 * own words, in the session (a comment on the ticket is not read while it waits).
 */
function askEffect(questions: readonly ClarifyQuestion[], n: number, head = ''): Effect {
  const { question, options } = questions[n]!;
  const rank = questions.length > 1 ? `Question ${n + 1}/${questions.length}: ` : '';
  const pick = options.length > 0;
  const body = `${head}${rank}${question}\n${pick ? 'Pick an option, or answer here in your own words.' : 'Answer here in your own words.'}`;
  return { kind: 'activity', type: 'elicitation', body, ...(pick ? { options } : {}) };
}

/**
 * `clarify` (ORC-210): the guard's questions, one elicitation of the ticket's session at a time, the next once one is
 * answered: Linear sends a picked option back as a plain reply, so the one on screen is the one it answers. The reminder
 * at 24 h and the block at 72 h are armed. The ticket waits, not blocked: the requester may answer as well as the team
 * (`answer_clarify`).
 */
function clarify(out: Decision, event: FactoryEvent, job: JobSpec, questions: ClarifyQuestion[]): Decision {
  out.events.push({ type: 'ticket.patched', patch: { clarify: { job: job.name, questions, at: event.at, answered: 0 } } });
  out.effects.push(askEffect(questions, 0));
  out.timers.push(
    { kind: 'clarify.remind', slot: 'clarify.remind', ms: CLARIFY_REMIND_MS, payload: { at: event.at } },
    { kind: 'clarify.expire', slot: 'clarify.expire', ms: CLARIFY_EXPIRE_MS, payload: { at: event.at } },
  );
  out.trace.push(`clarify: ${questions.length} question(s) asked after ${job.name}`);
  return out;
}

type Clarifying = TicketState & { clarify: NonNullable<TicketState['clarify']> };

/**
 * Whether a reply of the ticket's own session answers its `clarify` questions: while they wait. A question back
 * (`kind: question`) is none: it takes the question path, the questions stay open.
 */
function answersClarify(ticket: TicketState | undefined, kind?: MessageKind): ticket is Clarifying {
  return !!ticket?.clarify && !ticket.blocked && kind !== 'question';
}

/**
 * An authorized reply to the `clarify` questions (ORC-210), already kept for the agent: it answers the question on
 * screen, and becomes a decision of the ticket unless unsigned (I12: no run reads it as settled). The next question
 * follows; once each has its answer, the job that asked them reads the ticket again with them.
 */
function clarifyAnswer(out: Decision, event: FactoryEvent<'session.prompted'>, ticket: Clarifying, workflow: Workflow): Decision {
  const { questions, answered, job } = ticket.clarify;
  const decision = { question: questions[answered]!.question, answer: event.payload.body, author: event.payload.author, ...(event.actor ? { authorId: event.actor } : {}), at: event.at };
  const decisions = event.taint === 'untrusted' ? {} : { decisions: [...(ticket.decisions ?? []), decision] };
  const open = questions.length - answered - 1;
  out.events.push({ type: 'ticket.patched', patch: { ...decisions, clarify: open ? { ...ticket.clarify, answered: answered + 1 } : null } });
  if (open) {
    out.trace.push(`clarify: answered, ${open} question(s) still open`);
    out.effects.push(askEffect(questions, answered + 1));
    return out;
  }
  const next = workflow.jobs[job];
  // A version is frozen with the ticket (ORC-149): the job that asked is in it, unless the journal was written by another.
  out.trace.push(next ? `clarify: answered, ${job} reads the ticket again` : `clarify: answered, but ${job} is not in the workflow: nothing starts`);
  if (next) startRun(out, event, ticket, next, { input: 'feedback' });
  return out;
}

/**
 * A `clarify` timer (ORC-210). Only the round that armed it, still waiting: one answered or ended since (a block, an
 * undelegation, a move: `reduce`), or asked again since, does nothing. At 24 h the questions still open are asked again;
 * at 72 h the ticket is blocked on the job that asked them, which a reply relaunches (ORC-196).
 */
function clarifyTimer(out: Decision, fired: { kind: 'clarify.remind' | 'clarify.expire'; payload: { at?: number } }, ticket: TicketState | undefined, workflow: Workflow): Decision {
  const c = ticket?.clarify;
  if (!c || c.at !== fired.payload.at || ticket.blocked || !ticket.delegated) {
    out.trace.push(`timer.fired ${fired.kind}: no question of this round waits`);
    return out;
  }
  if (fired.kind === 'clarify.remind') {
    out.effects.push(askEffect(c.questions, c.answered, 'Reminder, still waiting for your answer. '));
    return out;
  }
  const open = c.questions.slice(c.answered);
  const asked = open.map((q) => q.question).join(' ');
  const reason = `${CLARIFY_EXPIRED} ${asked}`;
  return block(out, workflow, {
    kind: 'question',
    reason,
    body: `${reason}\nReply in this thread and I will read the ticket again.`,
    job: c.job,
    step: 'clarify',
    tried: [`Asked ${c.questions.length} question(s) in the session, and again after 24 h.`],
    question: asked,
  });
}

/** What the session hears of a wait on blockers (ORC-363): what it waits for, and that nothing is asked. */
export function waitingBody(blockers: readonly Blocker[]): string {
  const them = blockers.length > 1;
  const list = blockers.map((b) => `${b.identifier} (${b.stateName})`).join(', ');
  return `This ticket is « blocked by » ${list} in Linear: I am waiting for ${them ? 'them' : 'it'} to be Done before starting, and will start on my own then. Nothing to answer; take the relation off to start without waiting.`;
}

/** The wait on blockers as the ticket records it (ORC-363): `start` is made once they are done. */
export const waitingOn = (blockers: readonly Blocker[], start: PendingJob) =>
  ({ type: 'ticket.patched', patch: { waitingOn: { blockers: blockers.map((b) => b.identifier), start } } }) as const;

/** Why the wait on blockers holds back `job` (ORC-363): any dev work but the start it waits for, which `blockers.done` makes. */
const heldByWait = (ticket: TicketState | undefined, job: JobSpec): string | undefined =>
  ticket?.waitingOn && job.queue === 'dev' ? `waiting on ${ticket.waitingOn.blockers.join(', ')}` : undefined;

/**
 * The ticket waits on the tickets it is « blocked by » that are not done (ORC-363): no block and no question, a thought in its
 * session. `blockers.done`, from the reconciliation, makes `start` then.
 */
function waitFor(out: Decision, blockers: readonly Blocker[], start: PendingJob): Decision {
  out.events.push(waitingOn(blockers, start));
  out.effects.push({ kind: 'activity', type: 'thought', body: waitingBody(blockers) });
  out.trace.push(`waiting on ${blockers.map((b) => b.identifier).join(', ')}: ${start.job} starts once done`);
  return out;
}

/**
 * The end of an AI review lens (ORC-183): its findings kept on the published commit it read (`verifiedSha`, what its
 * launch cloned), and published with the other lens's by the job whose `on_success` posts the review; then its `on_success`.
 * A lens that handed back no findings list, or a ticket with no published commit, is blocked: a silent review is no review.
 *
 * The review loop (ORC-184): each lens's blocking findings are counted on the commit, and once the lens that publishes ends
 * with one standing, its `on_blocking` fix starts in place of its `on_success`, one round of the review and CI loop; past
 * the bound, the ticket is blocked. A version frozen before it, with no `on_blocking`, goes to Human Review as it did.
 */
function reviewEnd(out: Decision, at: { event: FactoryEvent; ticket: TicketState | undefined; workflow: Workflow }, job: JobSpec, lens: ReviewLens, p: EventPayloads['run.finished']): Decision {
  const findings = p.output?.findings;
  const { ticket, workflow } = at;
  const sha = ticket?.verifiedSha;
  if (!findings || !sha) {
    const reason = sha ? `The AI review ${job.name} returned no findings list.` : `The AI review ${job.name} has no published commit to review.`;
    return block(out, workflow, { kind: 'failed', reason, body: `${reason} Reply in this thread and I will resume.`, job: job.name, tried: [`Started the run ${job.name} (${lens} lens).`] });
  }
  const publishes = job.onSuccess.post === 'review';
  out.effects.push({ kind: 'review', runId: p.runId, lens, sha, findings, ...(publishes ? { publish: true as const } : {}) });
  if (!Object.values(workflow.jobs).some((j) => j.onBlocking)) return success(out, at, job, p.runId, p.output);
  // Each lens's count on the commit, the lens that publishes reading their sum.
  const counts = { ...(ticket?.reviewBlocking?.sha === sha ? ticket.reviewBlocking.counts : {}), [lens]: findings.filter(isBlocking).length };
  // What the fix contested of the previous round, its lenses have read now: the findings standing are this review's.
  out.events.push({ type: 'ticket.patched', patch: { reviewBlocking: { sha, counts }, ...(publishes && ticket?.contested ? { contested: null } : {}) } });
  const blocking = publishes ? blockingTotal(counts) : 0;
  const fix = job.onBlocking && workflow.jobs[job.onBlocking.run];
  if (!fix || !blocking) return success(out, at, job, p.runId, p.output);
  if (refusal(at.event, ticket, fix)) {
    out.trace.push(`review: ${fix.name} refused, the PR is merged`);
    return out;
  }
  return loopRound(out, ticket, workflow, () => startRun(out, at.event, ticket, fix, { input: fix.input }), (bound) => {
    out.trace.push(`review: ${fix.name} bound ${bound} reached`);
    const reason = `The AI review still has ${blocking} blocking finding${blocking === 1 ? '' : 's'} on ${sha.slice(0, 12)}, and the review and CI loop has used its ${bound} runs: I am not starting ${fix.name}.`;
    return block(out, workflow, {
      kind: 'limit',
      reason,
      body: `${reason}\nReply in this thread to relaunch.`,
      job: fix.name,
      attempts: bound,
      tried: [`${bound} run(s) of the review and CI loop (fix-ci, fix-review, rebase).`, `AI review of ${sha.slice(0, 12)}: ${blocking} blocking finding(s), published on the PR.`],
    });
  });
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
    const reason = `The red check of ${job.name} could not run: infrastructure failure, not the agent's fault.`;
    return block(out, at.workflow, { kind: 'infra', reason, body: `${reason}\n${failures[0]?.output ?? ''}\nReply in this thread and I will resume.`, job: job.name, step: 'red', tried: triedFailures(failures) });
  }
  if (red.mode === 'measure') {
    out.trace.push(`red: would have blocked (${cause}), measure mode: the run goes on`);
    freeze(out, at.ticket, at.event.payload.frozen);
    return success(out, at, job, runId);
  }
  const used = at.ticket?.redAttempts ?? 0;
  if (used + 1 < red.attempts) {
    out.events.push({ type: 'ticket.patched', patch: { redAttempts: used + 1 } });
    startRun(out, at.event, at.ticket, job, { input: 'verify_failures', inputText: JSON.stringify(failures), resume: true });
    return out;
  }
  const reason = `Red not verified after ${red.attempts} attempts of ${job.name}.`;
  return block(out, at.workflow, { kind: 'red', ...failedChecks(reason, failures), job: job.name, step: 'red', attempts: red.attempts });
}

/**
 * Records the freeze read after `red` (ORC-131), once the run goes on to the build. A freeze already there keeps its
 * commit and fingerprints, the new files are added: only a maintainer's `/refreeze` takes a file out of the freeze (I3).
 */
function freeze(out: Decision, ticket: TicketState | undefined, frozen: FrozenTests | undefined): void {
  if (!frozen) return;
  const old = ticket?.frozenTests;
  const decisions = frozenDecisions(ticket);
  // The old freeze keeps its rules (ORC-342): its harness is the one it was made with.
  out.events.push({ type: 'ticket.patched', patch: { frozenTests: { ...(old ? { ...old, files: { ...frozen.files, ...old.files } } : frozen), ...decisions } } });
}

/** The answers to `clarify` (ORC-210), frozen with the tests they decided: the ticket's, as they are at the freeze or the refreeze. */
const frozenDecisions = (ticket: TicketState | undefined) => (ticket?.decisions?.length ? { decisions: ticket.decisions } : {});

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
  if (event.payload.kind) keepMessage(out, event, 'session');
  const { frozen, linearSessionId } = event.payload;
  const answer = (body: string) => out.effects.push({ kind: 'activity', type: 'response', body, linearSessionId });
  if (!frozen) {
    answer('Nothing to refreeze: this ticket has no freeze or no working branch.');
    return out;
  }
  const count = Object.keys(frozen.files).length;
  out.trace.push(`refreeze by ${event.actor}: ${count} files frozen at ${frozen.sha}`);
  out.events.push({ type: 'ticket.patched', patch: { frozenTests: { ...frozen, ...frozenDecisions(ticket) } } });
  answer(`Refrozen: ${count} files, as of commit ${frozen.sha.slice(0, 12)}. The next verification starts from this freeze.`);
  return out;
}

/**
 * A block, in fields. `body`: the free text a version frozen before ORC-196 posts instead. `job`: the step a reply
 * resumes, and the step the comment names unless `step` says otherwise.
 */
type Block = Omit<Parameters<typeof blockFacts>[0], 'step'> & { kind: BlockKind; body: string; linearSessionId?: string | undefined } & ({ job: string; step?: string } | { job?: undefined; step: string });

/** What a run's end says of its block: its job is the caller's. */
type RunBlock = Pick<Block, 'kind' | 'reason' | 'body' | 'tried' | 'question'>;

/** The one fork on how a block is told: a comment, or on a version frozen before ORC-196 what it posted. */
function tell(out: Decision, workflow: Workflow, facts: BlockFacts, frozen: Effect): void {
  out.effects.push(workflow.blockComment ? { kind: 'block_comment', block: facts } : frozen);
}

function block(out: Decision, workflow: Workflow, b: Block): Decision {
  out.events.push({ type: 'ticket.blocked', reason: b.reason, kind: b.kind, ...(workflow.blockComment && b.job ? { job: b.job } : {}) });
  tell(out, workflow, blockFacts({ ...b, step: b.step ?? stepOf(workflow, b.job!) }), { kind: 'activity', type: 'elicitation', body: b.body, ...(b.linearSessionId ? { linearSessionId: b.linearSessionId } : {}) });
  return out;
}

/**
 * A `settle` that died (ORC-339): its retries spent, a pending job with no run would hold the ticket's messages for
 * good, in silence. The ticket is blocked on that job instead; the job stays pending, all of it (its input, its
 * restrictions), and a reply starts that very job (`resumedPending`). Anything else: only logged.
 */
function stuckPending(out: Decision, ticket: TicketState, workflow: Workflow, error: string, attempts: number): Decision {
  const pending = ticket.pendingJob;
  if (!pending || !ticket.delegated || ticket.activeRunId || ticket.verifyingRunId || ticket.usageWait || ticket.blocked || settledTicket(ticket)) return out;
  const reason = `Error: the pending ${pending.job} could not be started: ${error}`;
  return block(out, workflow, {
    kind: 'stuck',
    reason,
    body: `${reason} Reply in this thread to start it again.`,
    job: pending.job,
    tried: [`Starting ${pending.job}, ${attempts} times.`],
    question: 'Can you reply here once the factory is healthy again?',
  });
}

/** A wait for a repo: only an action lifts it, no job of the ticket has started. Its reason is what a frozen version posts. */
function askForRepo(out: Decision, workflow: Workflow, reason: string, question: string, tried: string, sessionId: string | undefined): void {
  tell(out, workflow, { ...blockFacts({ reason, step: 'intake', tried: [tried], question }), waits: true }, { kind: 'activity', type: 'elicitation', body: reason, ...(sessionId ? { linearSessionId: sessionId } : {}) });
}

/** Failed checks, the block's fields and what a frozen version posts. */
const failedChecks = (reason: string, failures: VerifyFailure[]) => ({ reason, body: `${reason}
${formatFailuresShort(failures)}
Reply in this thread to relaunch.`, tried: triedFailures(failures) });

/** The preset step of a job, by its own name when it is out of the preset. */
export const stepOf = (workflow: Workflow, job: string): string => workflow.jobs[job]?.step ?? job;

/** The step of the preset that rebases a ticket's branch on the default branch (ORC-146). */
const REBASE = 'rebase';

/** The check after a job: the ones a fix and a rebase go through have their own steps in the preset. */
const checkOf = (workflow: Workflow, job: string): string => {
  const step = stepOf(workflow, job);
  return step === 'fix' || step === REBASE ? `verify_${step}` : 'verify';
};

/** What each conflict the rebase step stops on says in its block (ORC-146). */
const CONFLICTS: Record<ConflictCase, string> = {
  logic: 'the two sides contradict each other',
  migrations: 'two migrations change the same schema',
  scope: "the resolution goes beyond the ticket's scope",
};

const triedFailures = (failures: VerifyFailure[]): string[] => failures.map((f) => `\`${f.command}\` (code ${f.exitCode ?? 'timeout'})`);

/**
 * A dev run's end read through its closed outcome (ORC-289): the `RunOutcome` it decides as, or the block
 * it ends in. Without `attempt` (rows written before it), `outcome` decides as before. `errored` is the
 * infrastructure's: blocked, never handed back to the agent. A success without output stays a success
 * until the job is `structuredOutput` (ORC-191/ORC-192 make every agent submit).
 */
function attemptDecision(p: EventPayloads['run.finished'], job: JobSpec): RunOutcome | RunBlock {
  const question = p.output?.question ?? '';
  switch (p.attempt) {
    case 'succeeded':
      return 'success';
    case 'failed':
      return p.outcome === 'success' && !job.structuredOutput ? 'success' : 'failure';
    case 'timeout':
      return 'limit';
    case 'errored': {
      const reason = `The run ${job.name} was interrupted: infrastructure failure, not the agent's fault.`;
      return { kind: 'infra', reason, body: `${reason} Reply in this thread and I will resume.`, tried: [`Started the run ${job.name}: its process stopped without a result.`] };
    }
    case 'needs_input': {
      // A rebase the agent stops on one of the three conflicts a human decides (ORC-146): a block of its own kind.
      // Another step that reports one asks a question: the conflict is the rebase step's, started by its event.
      const conflict = p.output?.reason === 'conflict' && job.step === REBASE ? p.output.conflict : undefined;
      if (conflict) {
        const reason = `Conflict with the default branch left to a human: ${CONFLICTS[conflict]}.`;
        return { kind: 'conflict', reason, body: `${reason}\n${question}\n\nReply in this thread and I will resume.`, tried: [`Started the run ${job.name}: the agent stops the rebase (\`${conflict}\`).`], question: question || undefined };
      }
      return { kind: 'question', reason: "Waiting for an answer to the agent's question.", body: `${question}\n\nReply in this thread and I will resume.`, tried: [`Started the run ${job.name}: the agent asks for a clarification.`], question: question || undefined };
    }
    case 'spec_impossible':
      return {
        kind: 'contested',
        reason: 'The agent disputes the ticket: it cannot honestly be done as written.',
        body: `I cannot do this ticket as written: ${question}\n\nFix the ticket or reply in this thread and I will resume.`,
        tried: [`Started the run ${job.name}: the agent returns \`spec_impossible\`.`],
        question: [question, 'Can you fix the ticket, or clarify what is expected?'].filter(Boolean).join(' '),
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
function stagnationBlock(p: EventPayloads['run.finished'], workflow: Workflow): RunBlock | undefined {
  const seen = p.stagnation;
  if (!seen) return undefined;
  if (seen.kind === 'silent') {
    const reason = `The run ${p.job} has written nothing for ${Math.round(seen.silentMs / 60_000)} min: the agent no longer responds, its container is still running.`;
    return { kind: 'limit', reason, body: `${reason} Reply in this thread and I will resume.`, tried: [`Stopped the run ${p.job} after ${Math.round(seen.silentMs / 60_000)} min of silence.`] };
  }
  const bound = workflow.limits.repeatedFailures;
  if (bound === undefined || seen.count < bound) return undefined;
  const reason = `Loop: same command, same failure, ${seen.count} times, with no code change.`;
  return { kind: 'loop', reason, body: `${reason}\n- \`${seen.command}\`\nReply in this thread to relaunch.`, tried: [`\`${seen.command}\`, ${seen.count} times`] };
}

/**
 * Events a human sends: unblocking the ticket, they give the review and CI loop its whole bound back (ORC-270, ORC-184). A review
 * on the PR, authorized, starts work as a reply does (ORC-190); it never unblocks.
 */
const HUMAN_RELAUNCH = new Set<EventType>(['session.prompted', 'ticket.commented', 'label.changed', 'status.changed', 'ticket.delegated', 'pr.reviewed']);

/** The review and CI loop starts over with its whole bound (ORC-270, ORC-184); nothing is recorded when its count is already 0. */
function resetRedCi(out: Decision, ticket: TicketState | undefined): void {
  if ((ticket?.ciFixAttempts ?? 0) > 0) out.events.push({ type: 'ticket.patched', patch: { ciFixAttempts: 0 } });
}

/**
 * Work starts again on a blocked ticket. Relaunched by a human (a reply, a label, a status change), the
 * red-CI count and the « Loop » guard reset; by a machine event (a timer, red CI itself), it does not, or a timer armed before
 * the block would undo it.
 */
function unblock(out: Decision, event: FactoryEvent, ticket: TicketState): void {
  out.events.push({ type: 'ticket.unblocked' });
  if (!HUMAN_RELAUNCH.has(event.type)) return;
  resetRedCi(out, ticket);
  // The human review rounds too (ORC-190): the reply to their own bound relaunches on the feedback it kept.
  if (ticket.humanReviewRounds) out.events.push({ type: 'ticket.patched', patch: { humanReviewRounds: 0 } });
  // The « Loop » guard starts over too (ORC-187); `null`, not undefined, survives the JSON of the journal.
  if (ticket.repeatedFailure) out.events.push({ type: 'ticket.patched', patch: { repeatedFailure: null } });
  // The red loop too (ORC-123).
  if (ticket.redAttempts) out.events.push({ type: 'ticket.patched', patch: { redAttempts: 0 } });
  // The lease's relaunch too (ORC-220), and the relaunches after a cut, which nothing else gives back.
  if (ticket.leaseRelaunches) out.events.push({ type: 'ticket.patched', patch: { leaseRelaunches: 0 } });
  if (ticket.cutRelaunches?.length) out.events.push({ type: 'ticket.patched', patch: { cutRelaunches: [] } });
  // And the relaunches at a usage reset (ORC-340): a human's resume is not blocked again at the first cut.
  if (ticket.usageRelaunches) out.events.push({ type: 'ticket.patched', patch: { usageRelaunches: null } });
}

/** The relaunches still in the window at the time of the event: never the clock, so that a replay decides the same. */
function recentCuts(ticket: TicketState, at: number): number[] {
  return (ticket.cutRelaunches ?? []).filter((t) => t > at - CUT_WINDOW_MS);
}

/** The bound of the relaunches after a cut is reached (ORC-220): no agent, and a human hears why. */
function blockOnCuts(out: Decision, workflow: Workflow, job: string, step = stepOf(workflow, job)): Decision {
  const reason = `Too many relaunches after a cut: ${CUT_RELAUNCHES} in ${CUT_WINDOW_MS / 60_000} min.`;
  return block(out, workflow, {
    kind: 'limit',
    reason,
    body: `${reason} ${PRODUCT_NAME} or its runner keeps restarting: check the daemon, then reply in this thread and I will resume.`,
    job,
    step,
    attempts: CUT_RELAUNCHES,
    tried: [`${CUT_RELAUNCHES} automatic relaunches after a cut.`],
    question: `${PRODUCT_NAME} or its runner keeps restarting: is the daemon back (reply "yes" and I will resume)?`,
  });
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
    const why = cause === 'restart' ? `${PRODUCT_NAME} restarted during my answer.` : 'The runner of my answer no longer responds.';
    out.effects.push({ kind: 'activity', type: 'error', body: `${why} Ask the question again in this thread.`, runId });
    return out;
  }
  if (!ticket?.delegated || ticket.blocked || refusesDevWork(ticket, job)) {
    out.trace.push(`run.lost: ${jobName} not started again, nothing should run on the ticket`);
    return out;
  }
  const used = ticket.leaseRelaunches ?? 0;
  if (cause === 'lease' && used >= LEASE_RELAUNCHES) {
    const reason = `The lease of the run ${jobName} expired ${used + 1} times: the runner no longer responds.`;
    return block(out, workflow, { kind: 'infra', reason, body: `${reason} Reply in this thread and I will resume.`, job: jobName, attempts: used + 1, tried: [`${used} relaunch(es) after an expired lease.`] });
  }
  const recent = recentCuts(ticket, event.at);
  if (recent.length >= CUT_RELAUNCHES) return blockOnCuts(out, workflow, jobName);
  out.events.push({ type: 'ticket.patched', patch: { ...(cause === 'lease' ? { leaseRelaunches: used + 1 } : {}), cutRelaunches: [...recent, event.at] } });
  startRun(out, event, ticket, job, { relaunchOf: runId });
  return out;
}

/** Relaunches at a usage reset a step gets in a row (ORC-340): the next cut blocks it. */
export const USAGE_RELAUNCHES = 3;

/**
 * A run the subscription's usage limit stopped, the factory waiting on it (`on_usage_limit: wait`, ORC-340): no failure of the agent,
 * no attempt counted. A question is asked again after the reset, its thread told so. A code step, the ticket's active one, waits for
 * the reset (`usageWait`) and is relaunched then, `USAGE_RELAUNCHES` times in a row at most. Undefined: decided as any other end.
 */
function usageLimitDecision(out: Decision, event: FactoryEvent<'run.finished'>, ticket: TicketState | undefined, workflow: Workflow, limited: { resetAt: number; account?: string }): Decision | undefined {
  const { job: jobName, runId } = event.payload;
  const job = workflow.jobs[jobName]!;
  const at = new Date(limited.resetAt).toISOString();
  const ms = Math.max(0, limited.resetAt - event.at);
  const payload = { job: jobName, runId, ...(limited.account ? { account: limited.account } : {}) };
  if (job.queue === 'questions') {
    const asks = ticket?.usageAsks ?? 0;
    if (asks >= USAGE_RELAUNCHES) {
      // Asked again as many times as a step is relaunched: the thread is told once, and nothing more is armed.
      out.events.push({ type: 'ticket.patched', patch: { usageAsks: null } });
      out.effects.push({ kind: 'activity', type: 'error', body: 'The usage limit is still reached; ask again later.', runId });
      return out;
    }
    out.events.push({ type: 'ticket.patched', patch: { usageAsks: asks + 1 } });
    out.effects.push({ kind: 'activity', type: 'response', body: `The usage limit is reached: I will answer after ${at}.`, runId });
    out.timers.push({ kind: 'usage.reset', slot: `usage.reset:${runId}`, ms, payload });
    return out;
  }
  // Only the ticket's active step reaches here: the result of another attempt is fenced before (`staleAttempt`). A blocked ticket keeps
  // its block; an undelegated or delivered one has no step to resume (`attemptLost` guards the same): decided as any other end.
  if (!ticket || ticket.blocked || !ticket.delegated || refusesDevWork(ticket, job)) return undefined;
  const count = ticket.usageRelaunches?.job === jobName ? ticket.usageRelaunches.count : 0;
  if (count >= USAGE_RELAUNCHES) {
    const reason = `The run ${jobName} reached a limit: the usage limit stopped it ${count + 1} times in a row.`;
    return block(out, workflow, { kind: 'limit', reason, body: `${reason} Reply in this thread and I will resume.`, job: jobName, attempts: count + 1, tried: [`${count} relaunch(es) at a usage reset.`] });
  }
  out.events.push({ type: 'ticket.patched', patch: { usageWait: { runId, job: jobName, logical: ticket.logical }, usageRelaunches: { job: jobName, count: count + 1 } } });
  out.effects.push({ kind: 'activity', type: 'thought', body: `Usage limit reached; resuming at ${at}.` });
  out.timers.push({ kind: 'usage.reset', slot: 'usage.reset', ms, payload });
  out.trace.push(`usage limit: ${jobName} resumes at ${at}`);
  return out;
}

/**
 * The tickets a waiting ticket was « blocked by » are done or no longer linked (ORC-363): the wait ends and its start is made,
 * unless the ticket moved on meanwhile: blocked, undelegated or at work (which ended the wait already), or moved by a human
 * out of the states a delegation starts from.
 */
function blockersDone(out: Decision, event: FactoryEvent<'blockers.done'>, ticket: TicketState | undefined, workflow: Workflow): Decision {
  const wait = ticket?.waitingOn;
  const job = wait && workflow.jobs[wait.start.job];
  if (wait) out.events.push({ type: 'ticket.patched', patch: { waitingOn: null } });
  const startable = ticket?.logical === 'todo' || ticket?.logical === 'dev';
  if (!ticket || !wait || !job || !startable || refusesDevWork(ticket, job) || ticket.blocked || ticket.activeRunId || ticket.verifyingRunId) {
    out.trace.push('blockers.done: the ticket no longer waits, nothing started');
    return out;
  }
  out.effects.push({ kind: 'activity', type: 'thought', body: `Nothing blocks this ticket any more (${event.payload.blockers.join(', ')} done or no longer linked): starting.` });
  startAs(out, event, ticket, job, wait.start);
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
 * The strongest taint of what a run takes in: its event, and the ticket's whole human inbox when the run
 * consumes it, even if a trusted event (a timer, a label) starts it (I12). A command is not given to the
 * agent and counts all the same: the rule is the inbox the run empties, not what a filter lets through.
 * An item without taint was written before ORC-269, when no source marked an event untrusted: it stays
 * trusted, as `upcast` reads a version 1 event, so that replaying the journal gives the same decisions.
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
 * when what the launch reads or empties is untrusted. A launch reads the feedback when it starts, not when
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

/**
 * A relaunch on the failures of a verify loop that a green check started over since (ORC-362): `verify.passed` resets the
 * `verifyAttempts` its `verify.failed` counted. Kept pending, `decide` takes it off the ticket with that check (ORC-360);
 * already in the queue (`settle` or a start found no slot), `Orchestrator.startRun` refuses it at its launch. Not the red
 * check's returns: a human relaunch resets their count as well.
 */
export function staleRelaunch(ticket: TicketState, job: JobSpec, input: InputKind | undefined): boolean {
  return input === 'verify_failures' && !job.red && !ticket.verifyAttempts;
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
  return triedFailures(failures).map((t) => `- ${t}`).join('\n');
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

/** The index of the first rule of `type` that applies to the event, on the ticket as it is read, the active job included: -1 without one. */
function firstRule(type: EventType, event: FactoryEvent, ticket: TicketState | undefined, workflow: Workflow): number {
  return (workflow.on[type] ?? []).findIndex((r) => ruleAllowed(r, event, ticket, workflow) && ruleMatches(r, event, ticket, ticket?.activeJob));
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
type HumanMessage = FactoryEvent<'session.prompted' | 'session.mentioned' | 'command' | 'ticket.commented'>;

/** A command as its author wrote it: the event carries its name apart. */
const commandText = (event: FactoryEvent<'command'>): string => `${event.payload.name} ${event.payload.body}`.trim();

/** Records a human message: it waits in humanInbox for the next run that consumes it (I6), its taint with it (I12). */
function keepMessage(out: Decision, event: HumanMessage, source: 'session' | 'thread'): void {
  out.events.push({ type: 'feedback.appended', item: messageItem(event, source) });
}

/** A human message as an agent is handed it: kept in humanInbox (`keepMessage`), or given to `learn` (`ingestedConversation`). */
function messageItem(event: HumanMessage, source: 'session' | 'thread'): FeedbackItem {
  const { author, kind } = event.payload;
  const body = event.type === 'command' && kind ? commandText(event) : event.payload.body;
  return { author, authorId: event.actor, body, at: event.at, source, taint: event.taint, ...(kind ? { kind } : {}) };
}

/**
 * Why the regrouping of classified messages ends without a run (ORC-180). Work in flight is not interrupted nor stacked
 * behind: its end is their step boundary. A block that came since waits for a reply: the messages before it answer nothing.
 */
function heldInbox(ticket: TicketState | undefined): string | undefined {
  // The block first: a pending job a dead settle left on a blocked ticket is no work in flight (ORC-339).
  if (ticket?.blocked) return 'held by the block';
  if (ticket?.activeRunId || ticket?.verifyingRunId || ticket?.pendingJob) return 'held for the end of the work in flight';
  return awaitsAgent(ticket?.humanInbox ?? []) ? undefined : 'nothing left to hand over';
}

/**
 * A review written on the PR (ORC-190): human review feedback, read through the reply rules as a session message is. On the
 * ticket's open PR, with words (an approval or a silent review asks nothing), from a writer of the repository (`review_feedback`,
 * on its GitHub login): kept in the inbox, untrusted as GitHub's content is, then the first reply rule whose `when` matches
 * the ticket. In Human Review that is `fix-human`, debounced, a round of human feedback; during other work, it waits for the end
 * of that work (`handOver`). A blocked ticket keeps it: only a reply in Linear relaunches.
 */
function humanReview(out: Decision, event: FactoryEvent<'pr.reviewed'>, ticket: TicketState | undefined, workflow: Workflow, matrix: AuthzMatrix): Decision {
  const { number, kind, author, body, state } = event.payload;
  if (!ticket?.delegated || ticket.prNumber !== number || ticket.prState !== 'OPEN') {
    out.trace.push(`pr.reviewed: PR #${number} is not the open PR of a ticket at work`);
    return out;
  }
  if (!body.trim() || state?.toUpperCase() === 'APPROVED') {
    out.trace.push('pr.reviewed: no feedback to fix (an approval, or no words)');
    return out;
  }
  if (!authorize(out, event, ticket, 'review_feedback', 'pr', matrix)) return out;
  out.events.push({ type: 'feedback.appended', item: { author, ...(event.actor ? { authorId: event.actor } : {}), body, at: event.at, source: 'review', taint: event.taint, kind: 'instruction', ...(kind === 'comment' ? { thread: true as const } : {}) } });
  if (ticket.blocked) {
    out.trace.push('pr.reviewed: kept, a review relaunches no blocked ticket');
    return out;
  }
  const index = firstRule('session.prompted', event, ticket, workflow);
  if (index < 0) {
    out.trace.push('pr.reviewed: kept for the end of the work in flight');
    return out;
  }
  out.trace.push(`pr.reviewed: on.session.prompted[${index}]`);
  return applyRule(out, workflow.on['session.prompted']![index]!, event, ticket, workflow);
}

/**
 * The regrouping of a message for the agent that implements (ORC-180), by the workflow's reply rule, whichever session it came
 * from: blocked, the rule relaunches at once (ORC-196's path); else it arms the debounce, and no rule leaves it for the next run.
 */
function regroup(out: Decision, event: FactoryEvent<'session.prompted' | 'session.mentioned'>, ticket: TicketState | undefined, workflow: Workflow): Decision {
  const index = firstRule('session.prompted', event, ticket, workflow);
  if (index < 0) {
    out.trace.push('no rule for session.prompted');
    return out;
  }
  out.trace.push(`on.session.prompted[${index}]`);
  return applyRule(out, workflow.on['session.prompted']![index]!, event, ticket, workflow);
}

/**
 * `/status` or `/stop` (ORC-180), answered by the factory, never by a model. `/stop` stops as the stop signal of its session
 * does. A session opened by this very mention holds no run: on a delegated ticket, it is the ticket's work that it stops.
 */
function factoryCommand(out: Decision, event: FactoryEvent<'session.prompted' | 'session.mentioned' | 'ticket.commented'>, ticket: TicketState | undefined, workflow: Workflow): Decision {
  const { body } = event.payload;
  // A comment has no session of its own: it is answered where it was written (ORC-196).
  const linearSessionId = event.type === 'ticket.commented' ? undefined : event.payload.linearSessionId;
  if (commandOf(body) !== STOP_COMMAND) {
    out.effects.push(linearSessionId ? { kind: 'activity', type: 'response', body: statusAnswer(ticket), linearSessionId } : { kind: 'comment', body: statusAnswer(ticket) });
    return out;
  }
  const session = event.type === 'session.mentioned' && ticket?.delegated ? undefined : linearSessionId;
  if (isQuestionSession(ticket, session)) return stopQuestion(out, session!);
  const index = firstRule('session.stopped', event, ticket, workflow);
  return index < 0 ? out : applyRule(out, workflow.on['session.stopped']![index]!, event, ticket, workflow);
}

/** The stop of a question session: its answer, not the ticket's work. */
function stopQuestion(out: Decision, sessionId: string): Decision {
  out.trace.push('built-in session.stopped (question session)');
  out.effects.push({ kind: 'stop_run', linearSessionId: sessionId }, { kind: 'activity', type: 'response', body: 'Stopped.', linearSessionId: sessionId });
  return out;
}

/** The read-only answer to a question, in its session. */
function askInThread(out: Decision, event: FactoryEvent<'session.prompted'>, ticket: TicketState | undefined, workflow: Workflow): void {
  const ask = workflow.jobs['ask'];
  if (ask) startRun(out, event, ticket, ask, { input: 'thread', inputText: event.payload.body, linearSessionId: event.payload.linearSessionId });
}

/**
 * A reply classified at its arrival (ORC-180). Whatever its class, it enters the human inbox; the class only decides
 * whether an answer starts as well. Only the ticket's dev session relaunches a blocked ticket, and there a reply is a reply: no
 * answer of its own. On a ticket not delegated, the answer is the only reaction there can be. A refused one is not kept.
 */
function classifiedReply(out: Decision, event: FactoryEvent<'session.prompted'>, ticket: TicketState | undefined, workflow: Workflow, matrix: AuthzMatrix): Decision {
  const { kind } = event.payload;
  const thread = isQuestionSession(ticket, event.payload.linearSessionId);
  // A command relaunches nothing: answered under the same right as any reply, blocked or not.
  const relaunches = !thread && !!ticket?.blocked && kind !== 'command';
  if (!authorize(out, event, ticket, relaunches ? 'relaunch_blocked' : 'answer_clarify', 'linear_session', matrix)) return out;
  const answerOnly = thread && (kind === 'question' || !ticket?.delegated);
  if (ticket) keepMessage(out, event, answerOnly ? 'thread' : 'session');
  if (kind === 'command') return factoryCommand(out, event, ticket, workflow);
  if (!thread && answersClarify(ticket, kind)) return clarifyAnswer(out, event, ticket, workflow);
  if (answerOnly || (kind === 'question' && !ticket?.blocked)) {
    out.trace.push(`session.prompted: ${kind}, answered`);
    askInThread(out, event, ticket, workflow);
  }
  if (answerOnly || (thread && ticket?.blocked)) return out;
  return regroup(out, event, ticket, workflow);
}

/** Prefix of the trace of a refused action (ORC-186): the orchestrator logs it. */
export const AUTHZ_REFUSED = 'authz: refused ';
/** The trace of a decision the authorization matrix refused (ORC-186): its refusal line, else undefined. */
export const authzRefusal = (trace: readonly string[]): string | undefined => trace.find((t) => t.startsWith(AUTHZ_REFUSED));

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
  // The dashboard is no Linear thread (ORC-301), nor is the PR (ORC-190): the refusal is only traced, and logged. A stranger's
  // comment on a public repository is answered by no message in the ticket.
  if (channel === 'dashboard' || channel === 'pr') return false;
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
  'ticket.delegated', 'session.mentioned', 'command', 'session.prompted', 'ticket.commented', 'label.changed', 'status.changed', 'pr.reviewed',
]);

/** A human acting on a run, by a rule (a label, a status change): relaunching it when the ticket is blocked, triggering it otherwise. */
const ruleAction = (ticket: TicketState | undefined): AuthzAction => (ticket?.blocked ? 'relaunch_blocked' : 'trigger');

/** The replies to a blocked ticket: in its session, or on the ticket itself (ORC-196). What makes one a reply is not read here (ORC-180). */
const REPLIES = new Set<EventType>(['session.prompted', 'ticket.commented']);

/**
 * The job a reply resumes (ORC-196): the one the ticket blocked on, in place of the job its rule names, reading the
 * reply. A rule stays what lets the reply through (its `when`). The rule's job stays when the blocked one is made to
 * read something else (`fix-ci`, its red checks: `dev-feedback` is the same step), and when the rule is debounced: its
 * timer starts it once the block is gone.
 */
function resumedJob(rule: Rule, event: FactoryEvent, ticket: TicketState | undefined, workflow: Workflow): JobSpec | undefined {
  if (!workflow.blockComment || !REPLIES.has(event.type) || !rule.run || rule.debounceMs || !ticket?.blocked || !ticket.blockedJob) return undefined;
  const job = workflow.jobs[ticket.blockedJob];
  // The fix of the review loop resumes itself on the reply, then goes back through the review (ORC-184): reading its findings
  // again, it would leave the reply aside.
  return job && (!job.input || job.input === 'feedback' || job.input === 'findings') ? job : undefined;
}

/**
 * A pending job no run will start (ORC-339): no run or check ahead of it, on a ticket blocked on it (a settle that could
 * not start it, `stuckPending`). Only a reply lifts that block, by starting the job: at once, or when its debounce fires.
 * Read by its kind: another block on that job (the red-CI bound on a `fix-ci` kept pending) is not lifted (ORC-360).
 */
function strandedPending(ticket: TicketState | undefined, workflow: Workflow): PendingJob | undefined {
  const pending = ticket?.pendingJob;
  if (!pending || !ticket.blocked || ticket.blockedJob !== pending.job || ticket.blockKind !== 'stuck' || ticket.activeRunId || ticket.verifyingRunId || ticket.usageWait) return undefined;
  return workflow.jobs[pending.job] ? pending : undefined;
}

/** The pending job a reply resumes, at once: the reply rule is not debounced (`timer.fired` resumes it otherwise). */
function resumedPending(rule: Rule, event: FactoryEvent, ticket: TicketState | undefined, workflow: Workflow): PendingJob | undefined {
  if (!workflow.blockComment || !REPLIES.has(event.type) || !rule.run || rule.debounceMs || !ticket?.blocked) return undefined;
  return strandedPending(ticket, workflow);
}

/** Starts a stranded pending job as it was set pending, its input and restrictions, and takes it off the ticket with this decision. */
function startPending(out: Decision, event: FactoryEvent, ticket: TicketState, workflow: Workflow, pending: PendingJob): Decision {
  const job = workflow.jobs[pending.job]!;
  if (refusal(event, ticket, job, runTaint(event, ticket, pending.input ?? job.input))) return out;
  unblock(out, event, ticket);
  // Off the ticket with this decision: the start it makes is the outbox's now, at least once.
  out.events.push({ type: 'pending.cleared', job: pending });
  startAs(out, event, ticket, job, pending);
  return out;
}

/** Starts `job` as `pending` was set aside: its input and its restrictions. */
function startAs(out: Decision, event: FactoryEvent, ticket: TicketState, job: JobSpec, pending: PendingJob): void {
  startRun(out, event, ticket, job, {
    ...(pending.input ? { input: pending.input } : {}),
    ...(pending.inputText !== undefined ? { inputText: pending.inputText } : {}),
    ...(pending.resume ? { resume: true } : {}),
    ...(pending.sensitivePaths ? { sensitivePaths: pending.sensitivePaths } : {}),
    ...(pending.relaunchOf ? { relaunchOf: pending.relaunchOf } : {}),
  });
}

function applyRule(out: Decision, rule: Rule, event: FactoryEvent, ticket: TicketState | undefined, workflow: Workflow): Decision {
  const pending = resumedPending(rule, event, ticket, workflow);
  if (pending) return startPending(out, event, ticket!, workflow, pending);
  const resumed = resumedJob(rule, event, ticket, workflow);
  const job = resumed ?? (rule.run ? workflow.jobs[rule.run]! : undefined);
  // A resumed job reads the inbox whatever its own input says: judged on the taint it will start with, or the ticket would lose its block for a run refused (I12).
  // A block on a stranded pending job stays until the debounce fires: it is what tells that reply to start that job (ORC-339).
  const keepsBlock = !!rule.debounceMs && !!strandedPending(ticket, workflow);
  const refused = !job || !!refusal(event, ticket, job, runTaint(event, ticket, resumed ? 'feedback' : job.input));
  const unblocks = !refused && !keepsBlock && !!ticket?.blocked;
  if (unblocks) unblock(out, event, ticket!);
  // A human who starts work gives the review and CI loop its whole bound back, blocked or not (ORC-184): the count is the run's.
  else if (!refused && !ticket?.blocked && HUMAN_RELAUNCH.has(event.type)) resetRedCi(out, ticket);
  if (rule.move) out.effects.push({ kind: 'move', to: rule.move });
  if (rule.labels) out.effects.push({ kind: 'labels', add: rule.labels.add, remove: rule.labels.remove });
  if (rule.comment) out.effects.push({ kind: 'comment', body: rule.comment });
  if (rule.do === 'stop') stop(out, workflow);
  if (rule.do === 'cleanup') out.effects.push({ kind: 'cleanup' });
  if (rule.do === 'propose_delegate') {
    out.effects.push({
      kind: 'activity',
      type: 'response',
      body: 'To have me develop this ticket, delegate it to me (the ticket\'s "Agent" field).',
    });
  }
  if (!job) return out;
  // Waiting on its blockers, the ticket starts no dev work for a message or a move: a reply stays in the inbox (ORC-363).
  const waits = heldByWait(ticket, job);
  if (waits) {
    out.trace.push(`${job.name} not started, ${waits}`);
    return out;
  }
  if (rule.debounceMs && rule.debounceMs > 0 && !refusal(event, ticket, job)) {
    const inbox = ((event.type === 'session.prompted' || event.type === 'session.mentioned') && !!event.payload.kind) || event.type === 'pr.reviewed';
    out.timers.push({ kind: 'debounce', slot: job.name, ms: rule.debounceMs, payload: { job: job.name, ...(inbox ? { inbox: true as const } : {}) } });
  } else {
    const threaded = event.type === 'session.mentioned' || event.type === 'command';
    const run = { input: resumed ? 'feedback' : job.input, inputText: threaded ? event.payload.body : undefined, linearSessionId: threaded ? event.payload.linearSessionId : undefined };
    // A human relaunch in this decision gave the human rounds back (`unblock`).
    humanRound(out, event, ticket, workflow, job, run, unblocks && HUMAN_RELAUNCH.has(event.type) ? 0 : undefined);
  }
  return out;
}

/**
 * Starts `job`; a round of human review feedback when it runs on the `human_review` counter (ORC-190, `fix-human`): counted
 * on `humanReviewRounds`, apart from the review and CI loop's `ciFixAttempts`. Past `limits.humanReviewRounds`, the ticket is
 * blocked instead, the feedback left in its inbox for the reply that relaunches it. `used`: the count as this decision leaves
 * it, when a human relaunch in it gave the rounds back. A start refused anyway (merged PR) is no round.
 */
function humanRound(out: Decision, event: FactoryEvent, ticket: TicketState | undefined, workflow: Workflow, job: JobSpec, run: Omit<StartRun, 'kind' | 'job'>, used = ticket?.humanReviewRounds ?? 0): void {
  const bound = workflow.limits.humanReviewRounds;
  if (job.counter !== 'human_review' || bound === undefined || refusal(event, ticket, job, runTaint(event, ticket, run.input ?? job.input))) {
    startRun(out, event, ticket, job, run);
    return;
  }
  if (used < bound) {
    startRun(out, event, ticket, job, run);
    out.events.push({ type: 'ticket.patched', patch: { humanReviewRounds: used + 1 } });
    return;
  }
  out.trace.push(`human review: ${job.name} bound ${bound} reached`);
  const reason = `The ${bound} rounds of human review feedback are used: I am not starting ${job.name} on the new feedback.`;
  block(out, workflow, {
    kind: 'limit',
    reason,
    body: `${reason}\nThe feedback is kept: reply in this thread to relaunch.`,
    job: job.name,
    attempts: bound,
    tried: [`${bound} round(s) of human review feedback (${job.name}), each through verify and the AI review.`],
  });
}

/**
 * One round of the review and CI loop (I5): the preset's `review_ci`, carried as `limits.ciFixAttempts`, one count per run.
 * Red CI's `fix-ci` (ORC-270), the rebase step on a conflict (ORC-146) and the fix of an AI review with a blocking finding
 * (ORC-184) all count on it: `start` runs and is counted while the count is under the bound, `past` decides otherwise. Only
 * another PR or a human relaunch (`unblock`) starts the count over: a green CI does not, or a review that keeps finding
 * would loop for good between its fix and the CI.
 */
function loopRound(out: Decision, ticket: TicketState | undefined, workflow: Workflow, start: () => void, past: (bound: number) => Decision): Decision {
  const used = ticket?.ciFixAttempts ?? 0;
  const bound = workflow.limits.ciFixAttempts;
  if (used >= bound) return past(bound);
  start();
  out.events.push({ type: 'ticket.patched', patch: { ciFixAttempts: used + 1 } });
  return out;
}

/**
 * A rule that answers red CI or a conflict with the default branch with a run: a round of the review and CI loop
 * (`loopRound`). Once the count reaches the bound, the next red CI or conflict blocks the ticket instead of applying the
 * rule. A run the rule would not start anyway (merged PR, I8 b) is neither counted nor blocked.
 */
function reviewCiLoop(out: Decision, rule: Rule, event: FactoryEvent<'pr.checks_failed' | 'pr.conflicted'>, ticket: TicketState | undefined, workflow: Workflow): Decision {
  const job = workflow.jobs[rule.run!]!;
  if (refusal(event, ticket, job)) return applyRule(out, rule, event, ticket, workflow);
  return loopRound(out, ticket, workflow, () => applyRule(out, rule, event, ticket, workflow), (bound) => {
    const conflict = event.type === 'pr.conflicted';
    out.trace.push(`${conflict ? 'conflict' : 'red CI'}: ${job.name} bound ${bound} reached`);
    // Already blocked (by a rule without !blocked): the ticket keeps its reason and gets no second notice.
    if (ticket?.blocked) return out;
    const past = event.type === 'pr.conflicted' ? conflictBound(event, bound) : redCiBound(event, job, bound);
    return block(out, workflow, { ...past, job: job.name, attempts: bound });
  });
}

/** Red CI past the bound: `ci_bound`, which a green CI lifts. */
function redCiBound(event: FactoryEvent<'pr.checks_failed'>, job: JobSpec, bound: number): RunBlock {
  const reason = `CI still failing after ${bound} attempts of ${job.name}.`;
  const failures = event.payload.failures.map((f) => `- \`${f}\``);
  return {
    kind: 'ci_bound',
    reason,
    body: [reason, ...failures, 'Reply in this thread to relaunch.'].join('\n'),
    tried: event.payload.failures.length ? event.payload.failures.map((f) => `\`${f}\``) : [`${bound} run(s) of ${job.name}.`],
  };
}

/** A conflict past the bound (ORC-146): a block of the conflict's own kind, which a green CI says nothing of. */
function conflictBound(event: FactoryEvent<'pr.conflicted'>, bound: number): RunBlock {
  const { number, baseRef, headSha } = event.payload;
  const reason = `Conflict with ${baseRef}, and the review and CI loop has used its ${bound} runs: I am not starting a rebase.`;
  return {
    kind: 'conflict',
    reason,
    body: `${reason}\nReply in this thread to relaunch.`,
    tried: [`PR #${number} conflicts with ${baseRef} at ${headSha.slice(0, 12)}.`, `${bound} run(s) of the review and CI loop (fix-ci, rebase).`],
  };
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

/** The check of a human's push (ORC-159): no run made the commit, so the check's id names it, and the push's time. */
const SHA = '[0-9a-f]{4,64}';
const PUSH_CHECK = new RegExp(`^push-(${SHA})-\\d+$`);
export const pushCheckId = (sha: string, at: number): string => `push-${sha}-${at}`;
/** The commit a check of a human's push verifies; undefined for the check of a run. */
const pushedHead = (runId: string): string | undefined => PUSH_CHECK.exec(runId)?.[1];

/**
 * The job whose checks a human's push goes through (ORC-159): the first the factory publishes. None on a version whose
 * agents push themselves (frozen before ORC-125): their own pushes come in as `push.human`, and pause nothing.
 */
function pushCheckJob(workflow: Workflow): JobSpec | undefined {
  return Object.values(workflow.jobs).find((j) => publishes(j) && j.workspace === 'worktree' && j.verifyFailure !== 'block');
}

/**
 * A human pushed to the ticket's branch (ORC-159). The agent's work pauses: the run in flight stops, the check or the
 * publication awaited and the waiting job go with it, and the ticket is blocked on the job the push interrupted, which a
 * human's reply resumes. `verify` starts again from the pushed commit, as the forge holds it, in a fresh clone; its verdict
 * is told then (`pushChecked`). A push of the commit `verify` last found green is the factory's own publication: nothing
 * pauses. Nor does a ticket the factory does not work on (not delegated, delivered, stopped, its PR closed): the rules decide.
 * A ticket blocked for another reason keeps it, and its push is checked all the same.
 */
function humanPush(out: Decision, event: FactoryEvent<'push.human'>, state: TicketState | undefined, ticket: TicketState | undefined, workflow: Workflow): Decision | undefined {
  const { sha, author } = event.payload;
  if (sha === state?.verifiedSha) {
    out.trace.push(`push.human: ${sha} is the commit verify last found green, the factory's own publication`);
    return out;
  }
  const job = pushCheckJob(workflow);
  if (!job) return undefined;
  // The commit shown to the reviewer is no longer the branch's: no approval from before the push passes a gate (I2).
  if (state?.reviewSha) out.events.push({ type: 'ticket.patched', patch: { reviewSha: null } });
  if (!ticket?.delegated || settledTicket(ticket) || ticket.prState === 'CLOSED' || !PUSH_CHECK.test(pushCheckId(sha, event.at))) return undefined;
  if (!ticket.blocked || ticket.blockKind === 'human_push') {
    cancelWork(out, `push.human: ${author} pushed ${sha.slice(0, 12)}, the agent's work paused`);
    // A push on a paused ticket keeps the job the first one interrupted.
    const resumes = ticket.blockKind === 'human_push' ? ticket.blockedJob : state?.activeJob && workflow.jobs[state.activeJob]?.queue === 'dev' ? state.activeJob : (state?.pendingJob?.job ?? ticket.blockedJob);
    out.events.push({ type: 'ticket.blocked', reason: `${pushed(sha)}: the agent's work is paused while verify checks it.`, kind: 'human_push', ...(workflow.blockComment && resumes ? { job: resumes } : {}) });
  } else {
    // Its block, and the pending job a reply to it resumes, stay: only the run in flight stops.
    out.trace.push(`push.human: ${author} pushed ${sha.slice(0, 12)}, the ticket stays blocked for its own reason`);
    out.effects.push({ kind: 'stop_run' });
  }
  const runId = pushCheckId(sha, event.at);
  out.events.push({ type: 'verify.started', runId });
  out.effects.push({ kind: 'run_verify', runId, job: job.name, head: sha });
  return out;
}

const pushed = (sha: string): string => `A human pushed ${sha.slice(0, 12)} to the ticket's branch`;

/**
 * The verdict of `verify` on a human's push (ORC-159). Green, the pushed commit is the one verified last: what a
 * publication or a merge may carry. Either way the ticket stays paused and the human hears the verdict: a reply resumes
 * the interrupted job on top of the push; a commit that fails waits for another push, or for a designated maintainer's
 * `/refreeze` when it changes a frozen test. A ticket a human relaunched meanwhile, or blocked for another reason, goes on as it is.
 */
function pushChecked(out: Decision, event: FactoryEvent<'verify.passed' | 'verify.failed' | 'verify.errored'>, head: string, ticket: TicketState | undefined, workflow: Workflow): Decision {
  if (event.type === 'verify.passed') out.events.push({ type: 'ticket.patched', patch: { verifiedSha: event.payload.sha ?? head } });
  if (!ticket?.blocked || ticket.blockKind !== 'human_push') {
    out.trace.push(`${event.type} on the push of ${head.slice(0, 12)}: the ticket ${ticket?.blocked ? 'is blocked for another reason' : 'was relaunched meanwhile'}`);
    return out;
  }
  const at = ticket.blockedJob ? { job: ticket.blockedJob, step: 'verify' } : { step: 'verify' };
  const resume = 'reply to resume the agent: it rebases its work on top of your commits, and never pushes over them.';
  if (event.type === 'verify.errored') {
    // Still the push's block: a next push replaces it, and its verdict is told.
    const reason = `The verification of ${head.slice(0, 12)}, pushed by a human, could not run: infrastructure failure.`;
    return block(out, workflow, { kind: 'human_push', reason, body: `${reason}\n${event.payload.error}\nReply in this thread and I will resume.`, ...at, tried: [`Started the verification of the pushed commit: ${event.payload.error}`] });
  }
  if (event.type === 'verify.failed') {
    const reason = `${pushed(head)}: verify fails on it.`;
    return block(out, workflow, { kind: 'human_push', ...failedChecks(reason, event.payload.failures), ...at, question: `Push a fix (it is checked again), or have a designated maintainer send /refreeze if it changes a frozen test on purpose; then ${resume}` });
  }
  const reason = `${pushed(head)}: verify passed on it, in a fresh clone. The agent's work is paused.`;
  return block(out, workflow, { kind: 'human_push', reason, body: `${reason}\nReply in this thread to resume the agent on top of it.`, ...at, tried: [`Checked the pushed commit ${head.slice(0, 12)} in a fresh clone of the forge: green.`], question: `Shall I go on? Move the ticket to AI Review to have your commits reviewed, or ${resume}` });
}

/** The ticket goes back to Human Review (ORC-148): nothing merged, `reason` answered in the ticket. */
function backToReview(out: Decision, reason: string): Decision {
  out.trace.push(`not merged: ${reason}`);
  // The commit under review stays the one shown: a head pushed since is never taken as reviewed.
  out.effects.push({ kind: 'move', to: 'human_review', keepReviewSha: true }, { kind: 'comment', body: `${reason} The ticket goes back to Human Review.` });
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
    return backToReview(out, 'I am not merging: no reviewed commit is recorded for this ticket (the factory records one only at the end of its own work, an AI review or a dev run that brings the ticket back to Human Review, and only if the head of the PR is the commit that work ended on; a move back to Human Review after a refusal records none). Move the ticket to AI Review: the AI review brings it back to Human Review on the head of the PR, which becomes the reviewed commit. Commits pushed by a human first need a reply in this thread, so that the agent takes them in and the factory verifies and publishes them: the AI review reads only what the factory published.');
  }
  if (!mayPublish(state, state.reviewSha, workflow)) {
    return backThroughAiReview(out, event, state, workflow, `I am not merging: the reviewed commit (${state.reviewSha.slice(0, 12)}) has no green verification, the last one is on ${state.verifiedSha?.slice(0, 12) ?? 'no commit'}.`);
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
  const refused = `I did not merge PR #${event.payload.number}: ${event.payload.reason}.`;
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
  return event.payload.headMoved ? backThroughAiReview(out, event, ticket, workflow, refused, { pushed: true }) : backToReview(out, refused);
}

/**
 * New commits go through the AI review again, whose `verify` finds them green or not, and which shows the head in Human
 * Review. A blocked ticket (it waits for a human) or a workflow with no AI review goes back to Human Review. So does a push
 * since the review (`pushed`) when the review reads only what the factory published (ORC-183): it can neither take the push
 * in nor verify it, which the implementer's feedback run does.
 */
function backThroughAiReview(out: Decision, event: FactoryEvent, ticket: TicketState, workflow: Workflow, refused: string, o: { pushed?: true } = {}): Decision {
  // The rule a human's move from Done to AI Review would apply, read on the ticket as it would then be.
  const moved: FactoryEvent<'status.changed'> = { ...event, type: 'status.changed', payload: { from: 'done', to: 'ai_review' } } as FactoryEvent<'status.changed'>;
  const inAiReview = { ...ticket, logical: 'ai_review' as const };
  // The first rule that matches, as `decideEvent` picks it: one with no run listed first starts no review.
  const run = (workflow.on['status.changed'] ?? []).find((r) => ruleAllowed(r, moved, inAiReview, workflow) && ruleMatches(r, moved, inAiReview, ticket.activeJob))?.run;
  const job = run && workflow.states.ai_review ? workflow.jobs[run] : undefined;
  if (!job || ticket.blocked) return backToReview(out, refused);
  if (o.pushed && job.lens) return backToReview(out, `${refused} ${PUSH_NOT_REVIEWED}`);
  out.trace.push(`not merged: ${refused}, back to the AI review`);
  out.effects.push({ kind: 'move', to: 'ai_review' }, { kind: 'comment', body: `${refused} The new commits go through the AI review again.` });
  startRun(out, event, ticket, job, { input: job.input });
  return out;
}

/** A push since the review, which today's AI review never reads (ORC-183): how its commits reach a merge. */
export const PUSH_NOT_REVIEWED = 'The AI review reads only the commits the factory published, and these were pushed since: reply in this thread so that the agent takes them in and the factory verifies them, then move the ticket to AI Review to have them reviewed.';

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
export function settledTicket(ticket: TicketState): string | undefined {
  if (ticket.logical === 'done' || ticket.prState === 'MERGED') return 'delivered';
  return ticket.blocked && causeOf(ticket.blockKind) === 'stopped' ? 'stopped' : undefined;
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
  if (lifted) out.effects.push({ kind: 'activity', type: 'response', body: `Event ${eventId} repaired by ${by} (${REPAIR_LABELS[action]}): the ticket is unblocked.` });
  return out;
}

/** Events that trigger the agent (ORC-186): a delegation, a mention, a command. */
const TRIGGERS = new Set<EventType>(['ticket.delegated', 'session.mentioned', 'command']);

/** What the factory answers a trigger within 10 s (ORC-171), a comment rather than a reaction until ORC-140 decides. */
export const ACK_BODY = 'Got it.';

/**
 * The ack of a trigger the webhook brought, first of its decision (ORC-171): a delegation gets the comment, and the
 * plan when it starts a run; any other trigger only the session's. An event already answered in its session (a
 * refusal, a run already active) gets no ack: nothing was taken. An event no webhook brought has no one waiting, and
 * a row journaled before ORC-171 asks for none: it replays as it was decided.
 */
function acknowledge(out: Decision, event: FactoryEvent, state: TicketState | undefined): void {
  const { ack, linearSessionId, kind } = event.payload as { ack?: true; linearSessionId?: string; kind?: MessageKind };
  if (!ack || !linearSessionId) return;
  if (out.effects.some((e) => e.kind === 'activity' && e.linearSessionId === linearSessionId)) return;
  // A command of a reply is answered by what it does: `/stop` says so in the ticket's session, whichever one it came from.
  if (event.type === 'session.prompted' && kind === 'command') return;
  const delegation = event.type === 'ticket.delegated';
  const plan = delegation && out.effects.some((e) => e.kind === 'start_run');
  // A mention that asks a question keeps the ack of a trigger (ORC-171).
  const body = kind === 'instruction' || (event.type === 'session.prompted' && kind) ? messageAck(out, state) : ACK_BODY;
  out.effects.unshift({ kind: 'ack', body, linearSessionId, ...(delegation ? { comment: true as const } : {}), ...(plan ? { plan: true as const } : {}) });
}

/**
 * Said to whoever left a secret in a message: masked here, it stays in Linear (ORC-180). With the ack; with no ack to
 * carry it (a refusal, a command, a `/refreeze`, a comment), on its own.
 */
function noticeMasked(out: Decision, event: FactoryEvent): void {
  const { masked, linearSessionId } = event.payload as { masked?: true; linearSessionId?: string };
  if (!masked) return;
  const notice = 'Your message contained a secret: the factory masks it, but it is still visible in Linear. Revoke it and delete it from the message.';
  const ack = out.effects.find((e) => e.kind === 'ack');
  if (ack) ack.body = `${ack.body} ${notice}`;
  else if (linearSessionId) out.effects.push({ kind: 'activity', type: 'response', body: notice, linearSessionId });
  // A comment has no session: told where it was written (ORC-196).
  else out.effects.push({ kind: 'comment', body: notice });
}

/** The sign of life of a message (ORC-180): what will come of it, as this decision has it. */
function messageAck(out: Decision, state: TicketState | undefined): string {
  if (out.events.some((e) => e.type === 'ticket.unblocked')) return 'Noted, resuming.';
  if (out.effects.some((e) => e.kind === 'start_run' && e.input === 'thread')) return 'Noted, I am looking into it and will answer here.';
  if (state && settledTicket(state) === 'delivered') return 'Noted, but this ticket is delivered: no step will pick it up again.';
  return 'Noted, taken into account at the next step.';
}

/** `/status` (ORC-180): the state of the ticket as the projection has it, with no model. */
function statusAnswer(ticket: TicketState | undefined): string {
  if (!ticket) return 'I am not following this ticket.';
  const lines = [`State: ${ticket.logical}`];
  if (ticket.activeJob) lines.push(`Running: ${ticket.activeJob}`);
  else if (ticket.verifyingRunId) lines.push('Running: verification');
  if (ticket.blocked) lines.push(`Blocked: ${ticket.blockReason ?? 'no recorded reason'}`);
  if (ticket.waitingOn) lines.push(`Waiting for: ${ticket.waitingOn.blockers.join(', ')} to be done`);
  lines.push(`Messages waiting for the agent: ${forAgent(ticket.humanInbox).length}`);
  return lines.join('\n');
}

/**
 * A delegation on a Linear team no project takes (ORC-171): blocked, whoever delegated (no repo, no role to check),
 * or asked again when already waiting: a wait for a repo with none to choose from (`awaitingRepo: []`). Told by the
 * standard comment (ORC-196), which says that only an action lifts it; a version frozen before it, in the session.
 */
function noRepoBlock(out: Decision, state: TicketState | undefined, event: FactoryEvent<'ticket.delegated'>, team: string, workflow: Workflow): Decision {
  const reason = `No repository known for the Linear team ${team}: add a project for it to the configuration, restart, then delegate this ticket again.`;
  if (!isNoRepo(state)) out.events.push({ type: 'ticket.blocked', reason, kind: 'pickup' }, { type: 'ticket.patched', patch: { awaitingRepo: [] } });
  askForRepo(out, workflow, reason, 'Can you add a project for this team, restart, then delegate this ticket again?', `Delegation on the team ${team}, which no project takes.`, event.payload.linearSessionId);
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
  const trackerDown = event.type === 'effect.failed' && ['activity', 'labels', 'block_comment'].includes(event.payload.kind);
  // An undelegation that lifts a repo choice while the issue's ticket in its repo is blocked leaves the label (ORC-291).
  const keepLabel = event.type === 'ticket.undelegated' && event.payload.keepLabel;
  if (!trackerDown && !keepLabel) blockedLabel(out, state, event);
  // Come from a wait in another project: the label goes now, not at the pass that ends that wait.
  if ((event.payload as { waitedIn?: string }).waitedIn && !out.events.reduce<TicketState | undefined>((t, e) => reduce(t, e), reduce(state, event))?.blocked) {
    out.effects.push(blockedLabelChange(true, false)!);
  }
  if (event.type === 'ticket.delegated') newRun(out, state, workflow);
  acknowledge(out, event, state);
  // A comment decide did not read (no reply awaited, refused) is not the factory's to answer.
  if (event.type !== 'ticket.commented' || out.events.some((e) => e.type === 'feedback.appended')) noticeMasked(out, event);
  return out;
}

/**
 * The boundary of a run (ORC-365): a delegation whose decision starts a dev run starts a new run, which takes its risk and
 * its visual proof from its own assessment, not from the last run's (I4): they are cleared (`null`) until it assesses.
 * A delegation that starts nothing (refused, a run active, a blocked ticket, one waiting on its blockers) leaves the run
 * as it is; a ticket never assessed has nothing to clear, and patches nothing.
 */
function newRun(out: Decision, state: TicketState | undefined, workflow: Workflow): void {
  const starts = out.effects.some((e) => e.kind === 'start_run' && workflow.jobs[e.job]?.queue === 'dev');
  if ((state?.risk || state?.visualProof) && starts) out.events.push({ type: 'ticket.patched', patch: { risk: null, visualProof: null } });
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
function unrouted(state: TicketState | undefined, event: FactoryEvent, workflow: Workflow, matrix: AuthzMatrix): Decision | undefined {
  const repos = (event.payload as { repos?: string[] }).repos;
  if (!repos && (!isUnrouted(state) || PAST_THE_WAIT.has(event.type))) return undefined;
  const out = empty();
  const choices = repos ?? state!.awaitingRepo!;
  const body = unroutedReason(choices);
  const sessionId = (event.payload as { linearSessionId?: string }).linearSessionId;
  if (event.type === 'ticket.delegated' && repos) {
    if (!isUnrouted(state)) out.events.push({ type: 'ticket.blocked', reason: body, kind: 'pickup' }, { type: 'ticket.patched', patch: { awaitingRepo: repos } });
    // In the session this delegation opened: the ticket keeps the first one it had.
    askForRepo(out, workflow, body, `Which repository: ${choices.map((r) => `\`${repoLabel(r)}\``).join(' or ')}? Add its label to the ticket, then delegate it again.`, 'Delegation on a team with several repositories, without a label naming one.', sessionId);
    // A new ticket: `blockedLabel` sees no state before it and puts no label.
    if (!state) out.effects.push(blockedLabelChange(false, true)!);
    return out;
  }
  // Kept for the run that follows the choice (I6), if the matrix would have let it in: nothing is refused here.
  if ((event.type === 'session.prompted' || event.type === 'session.mentioned' || event.type === 'command') && event.payload.kind) {
    const asked = event.type === 'session.prompted' ? ({ action: 'answer_clarify', channel: 'linear_session' } as const) : ({ action: 'trigger', channel: 'linear' } as const);
    // As `authorize` reads it, its refusal left out: nothing is refused here.
    if (event.roles === undefined || allowed(asked, event.actor, state, matrix, event.roles).ok) keepMessage(out, event, 'thread');
  }
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
  const waiting = ticket && unrouted(state, event, workflow, matrix);
  if (waiting) return waiting;
  // Before the wait's end below: delegated again, a team with still no repo has chosen nothing.
  if (event.type === 'ticket.delegated' && event.payload.noRepo) return noRepoBlock(out, state, event, event.payload.noRepo, workflow);
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
    return cancelWork(out, 'status.changed: ticket cancelled, work cancelled');
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
      if (sessionId) out.effects.push({ kind: 'activity', type: 'response', body: 'A run is already in progress on this ticket: I am not starting a second one.', linearSessionId: sessionId });
      return out;
    }
    // The run's initiator, and its requester: who delegated it, as Linear signed it and the matrix allowed it.
    // Only a checked delegation names one: a row journaled before ORC-186 replays as it was decided.
    if (event.type === 'ticket.delegated' && event.roles !== undefined && event.actor && ticket && ticket.initiatorId !== event.actor) {
      out.events.push({ type: 'ticket.patched', patch: { initiatorId: event.actor } });
    }
  }
  if (event.type === 'verify.passed' || event.type === 'verify.failed' || event.type === 'verify.errored') {
    const head = pushedHead(event.payload.runId);
    if (head) return pushChecked(out, event, head, ticket, workflow);
  }
  switch (event.type) {
    case 'control.pause':
      out.effects.push({ kind: 'set_paused', paused: true });
      return out;
    case 'control.resume':
      out.effects.push({ kind: 'set_paused', paused: false });
      return out;
    case 'control.stop': {
      const { runId, pause } = event.payload;
      if (!authorize(out, event, ticket, pause ? 'pause_run' : 'stop_run', 'dashboard', matrix)) return out;
      // Aimed at a run (the dashboard's inspection, ORC-301): once it has ended, another may be at work, which this stops not.
      if (runId && ticket?.activeRunId !== runId) {
        out.trace.push(`control.stop: run ${runId} is no longer the ticket's, nothing stopped`);
        return out;
      }
      return pause ? stop(out, workflow, PAUSED, `Paused from the dashboard. ${relaunch(workflow)}`, 'paused') : stop(out, workflow);
    }
    case 'run.finished': {
      const { job: jobName, runId, output } = event.payload;
      const job = workflow.jobs[jobName];
      // An attempt that ended gives the lease's relaunch back (ORC-220): only two in a row block.
      if (ticket?.leaseRelaunches && job?.queue === 'dev') out.events.push({ type: 'ticket.patched', patch: { leaseRelaunches: 0 } });
      if (!job || event.payload.outcome === 'stopped') return out;
      // A run that succeeded is kept, whatever the stream said of the limit on the way.
      const limited = event.payload.outcome !== 'success' ? event.payload.usageLimit : undefined;
      // A step that ended without the limit starts its count of relaunches at the reset again.
      if (!limited && ticket?.usageRelaunches && job.queue === 'dev') out.events.push({ type: 'ticket.patched', patch: { usageRelaunches: null } });
      if (!limited && ticket?.usageAsks && job.queue === 'questions') out.events.push({ type: 'ticket.patched', patch: { usageAsks: null } });
      if (limited) {
        const usage = usageLimitDecision(out, event, ticket, workflow, limited);
        if (usage) return usage;
      }
      const outcome = job.queue === 'dev' ? (stagnationBlock(event.payload, workflow) ?? attemptDecision(event.payload, job)) : event.payload.outcome;
      // Already blocked (the agent asked through `ask`, a human's stop…): it keeps its reason and gets no second notice.
      if (typeof outcome === 'object') return ticket?.blocked ? out : block(out, workflow, { ...outcome, job: jobName });
      // A run that ended well on a ticket already blocked (`ask`, then the end of its turn): no output is expected of it, its question stays.
      if (event.payload.outcome === 'success' && ticket?.blocked && job.queue === 'dev') return out;
      if (outcome === 'success') {
        if (job.step === 'intake') return intakeEnd(out, { event, ticket, workflow }, job, event.payload);
        if (job.lens) return reviewEnd(out, { event, ticket, workflow }, job, job.lens, event.payload);
        // The findings the fix of the review loop contests stay open: the next review's lenses read them (ORC-184).
        const review = ticket?.reviewBlocking;
        if (job.input === 'findings' && review && output?.contested?.length) out.events.push({ type: 'ticket.patched', patch: { contested: { sha: review.sha, items: output.contested } } });
        if (job.verify.length === 0 && !job.repoChecks && !job.red && !goesThroughFreeze(ticket, job)) return success(out, { event, ticket, workflow }, job, runId, output);
        out.events.push({ type: 'verify.started', runId });
        out.effects.push({ kind: 'run_verify', runId, job: jobName, ...(output ? { output } : {}) });
        return out;
      }
      if (job.queue === 'questions') {
        out.effects.push({ kind: 'activity', type: 'error', body: 'I could not finish (failure or limit reached).', runId });
        return out;
      }
      const over = outcome === 'limit' ? event.payload.overBudget : undefined;
      if (over) {
        const reason = over === 'tokens' ? `The run ${jobName} spent its token budget (budgets.per_step_tokens, or what the ticket had left).` : `The run ${jobName} spent its turn budget (max_turns of its step).`;
        return block(out, workflow, { kind: 'budget', reason, body: `${reason} Reply in this thread and I will resume.`, job: jobName, tried: [`Started the run ${jobName}: stopped at its ${over === 'tokens' ? 'token' : 'turn'} budget.`] });
      }
      const reason =
        outcome === 'limit'
          ? `The run ${jobName} reached a limit (turns, duration or budget).`
          : `The run ${jobName} failed.`;
      return block(out, workflow, { kind: outcome === 'limit' ? 'limit' : 'failed', reason, body: `${reason} Reply in this thread and I will resume.`, job: jobName, tried: [`Started the run ${jobName}: ${outcome === 'limit' ? 'stopped at its limit' : 'it failed'}.`] });
    }
    case 'run.lost':
      return attemptLost(out, event, ticket, workflow);
    case 'blockers.done':
      return blockersDone(out, event, ticket, workflow);
    case 'agent.asked': {
      const { question, job, linearSessionId } = event.payload;
      const asker: Effect = { kind: 'activity', type: 'elicitation', body: question, ...(linearSessionId ? { linearSessionId } : {}) };
      // Not delegated: no reply on the ticket would resume it, so nothing blocks it; its thread hears the question (ORC-180).
      if (!ticket?.delegated) {
        if (linearSessionId) out.effects.push(asker);
        return out;
      }
      // A question thread hears it where it was asked; the dev session by the comment only, the one channel of a block.
      if (workflow.blockComment && linearSessionId && linearSessionId !== ticket.linearSessionId) out.effects.push(asker);
      // The job at work is the step a reply resumes; a question run has none on the ticket.
      const at = ticket.activeJob ? { job: ticket.activeJob } : { step: job };
      return block(out, workflow, { kind: 'asked', reason: AGENT_QUESTION, body: question, linearSessionId, ...at, tried: [`The run ${job} in progress: the agent asks for a clarification.`], question: question || undefined });
    }
    case 'verify.lost': {
      const { runId, job, output } = event.payload;
      const recent = ticket ? recentCuts(ticket, event.at) : [];
      const head = pushedHead(runId);
      if (recent.length >= CUT_RELAUNCHES) {
        // Nothing runs it any more: the ticket must not wait for its verdict, or no later start would pass it.
        out.events.push({ type: 'work.cancelled' });
        // The check of a human's push: its block says it is being checked, and would say so for good.
        const pushCheck = !!head && ticket?.blockKind === 'human_push';
        return ticket?.blocked && !pushCheck ? out : blockOnCuts(out, workflow, job, checkOf(workflow, job));
      }
      out.events.push({ type: 'ticket.patched', patch: { cutRelaunches: [...recent, event.at] } });
      out.effects.push({ kind: 'run_verify', runId, job, ...(output ? { output } : {}), ...(head ? { head } : {}) });
      return out;
    }
    case 'verify.passed': {
      const job = workflow.jobs[event.payload.job];
      if (!job) return out;
      // The commit found green goes out, and the job ends once it is out: until then the ticket stays held, and a stop fences the result. No sha: no commit to publish.
      const toPublish = publishes(job) ? event.payload.sha : undefined;
      const patch = { verifyAttempts: 0, ...(ticket?.repeatedFailure ? { repeatedFailure: null } : {}), ...(ticket?.redAttempts ? { redAttempts: 0 } : {}), ...(event.payload.sha ? { verifiedSha: event.payload.sha } : {}), ...(toPublish && job.onSuccess.move ? { owedMove: job.onSuccess.move } : {}) };
      out.events.push({ type: 'ticket.patched', patch });
      // A relaunch on failures still pending goes with them: settle would start it on a green check, in a loop just started over (ORC-360).
      const pending = ticket?.pendingJob;
      if (pending?.input === 'verify_failures') out.events.push({ type: 'pending.cleared', job: pending });
      if (job.red) freeze(out, ticket, event.payload.frozen);
      if (toPublish) {
        const { runId, output, commands } = event.payload;
        out.events.push({ type: 'verify.started', runId });
        // A rebase rewrites the branch (ORC-146): its commit may replace the head the factory published, and that head only.
        const rewrite = job.step === REBASE ? { rewrite: true as const } : {};
        out.effects.push({ kind: 'publish', runId, job: job.name, sha: toPublish, ...(output ? { output } : {}), ...(commands ? { commands } : {}), ...rewrite });
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
      success(out, { event, ticket, workflow }, job, event.payload.runId, event.payload.output);
      // What the owed move came with: `dev`'s AI review (ORC-183), started as that job's own end would have, or the ticket
      // would sit in AI Review with no review.
      const then = owed && !job.onSuccess.run ? Object.values(workflow.jobs).find((j) => j.onSuccess.move === owed && j.onSuccess.run)?.onSuccess.run : undefined;
      const next = then ? workflow.jobs[then] : undefined;
      if (next) startRun(out, event, ticket, next, { input: next.input });
      return out;
    }
    case 'publish.refused': {
      const reason = `Publication refused: ${event.payload.reason}`;
      // No job of its own: what relaunches it is a job that writes (`owedMove`), the rule's.
      return ticket?.blocked ? out : block(out, workflow, { kind: 'other', reason, body: `${reason}\nReply in this thread to relaunch.`, step: 'publish', tried: [`Publication of the commit of ${event.payload.job}.`] });
    }
    case 'verify.failed': {
      const used = ticket?.verifyAttempts ?? 0;
      const { failures, job } = event.payload;
      const checked = workflow.jobs[job];
      if (checked?.red) return redFailed(out, { event, ticket, workflow }, checked, checked.red);
      if (checked?.verifyFailure === 'block') {
        const reason = `Checks failing after ${job}: the commit cannot be published, and this job does not fix it.`;
        // This job does not fix what it found: the reply goes to the rule's, which writes.
        return block(out, workflow, { kind: 'failed', ...failedChecks(reason, failures), step: checkOf(workflow, job) });
      }
      const repeated = repeatedFailure(ticket, event.payload);
      if (repeated && repeated.count >= (workflow.limits.repeatedFailures ?? Infinity)) {
        out.events.push({ type: 'ticket.patched', patch: { repeatedFailure: repeated } });
        const reason = `Loop: same failure ${repeated.count} times in a row, with no code change.`;
        return block(out, workflow, { kind: 'loop', ...failedChecks(reason, failures), job, step: checkOf(workflow, job), attempts: repeated.count });
      }
      if (used + 1 < workflow.limits.verifyAttempts) {
        out.events.push({ type: 'ticket.patched', patch: { verifyAttempts: used + 1, ...(repeated ? { repeatedFailure: repeated } : {}) } });
        const spec = workflow.jobs[job];
        if (spec) startRun(out, event, ticket, spec, { input: 'verify_failures', inputText: JSON.stringify(failures), resume: true });
        return out;
      }
      const reason = `Checks still failing after ${workflow.limits.verifyAttempts} attempts.`;
      return block(out, workflow, { kind: 'limit', ...failedChecks(reason, failures), job, step: checkOf(workflow, job), attempts: workflow.limits.verifyAttempts });
    }
    case 'verify.errored': {
      // Not a failure of the work: no counter moves, and the agent gets nothing to fix. A human relaunch checks again.
      const reason = `The verification of ${event.payload.job} could not run: infrastructure failure, not the agent's fault.`;
      return ticket?.blocked ? out : block(out, workflow, { kind: 'infra', reason, body: `${reason}\n${event.payload.error}\nReply in this thread and I will resume.`, job: event.payload.job, step: checkOf(workflow, event.payload.job), tried: [`Started the verification of ${event.payload.job}: ${event.payload.error}`] });
    }
    case 'timer.fired': {
      const fired = event.payload;
      if (fired.kind === 'reconcile') {
        // The project's reconciliation (ORC-185): it runs, and the next one is armed, so the cadence lives in the store.
        out.effects.push({ kind: 'reconcile' });
        out.timers.push({ kind: 'reconcile', payload: {}, slot: 'reconcile', ms: RECONCILE_MS });
        return out;
      }
      if (fired.kind === 'usage.reset' && fired.payload.job) {
        const job = workflow.jobs[fired.payload.job];
        // A question cut by the limit: asked again, from what it read, in its thread (`relaunchOf`).
        if (job?.queue === 'questions' && fired.payload.runId) {
          startRun(out, event, ticket, job, { relaunchOf: fired.payload.runId });
          return out;
        }
        const wait = ticket?.usageWait;
        // Only the cut step, still where it was cut: a ticket moved on since (a run, a move, a block, undelegated) ended the wait (`reduce`).
        // ponytail: the timer row is left to fire into this check, not deleted; a per-slot delete in the decision plan if stale rows ever matter.
        const current = !!job && !!ticket && !!wait && wait.runId === fired.payload.runId && wait.job === job.name && ticket.logical === wait.logical && ticket.delegated && !ticket.blocked && !ticket.activeRunId && !ticket.verifyingRunId;
        if (!current) {
          // Its reason gone, the wait goes with its timer: it never outlives it. A wait of another cut has its own timer.
          if (wait && wait.runId === fired.payload.runId) out.events.push({ type: 'ticket.patched', patch: { usageWait: null } });
          out.trace.push(`timer.fired usage.reset: ${fired.payload.job} not resumed, the ticket moved on`);
          return out;
        }
        out.events.push({ type: 'ticket.patched', patch: { usageWait: null } });
        // As a relaunch after a cut (`attemptLost`): the step reads again what the cut run read, in the session of its role.
        startRun(out, event, ticket, job, { relaunchOf: wait.runId });
        return out;
      }
      if (fired.kind === 'clarify.remind' || fired.kind === 'clarify.expire') return clarifyTimer(out, fired, ticket, workflow);
      if (fired.kind !== 'debounce') {
        // A usage reset without a job: armed by no version.
        out.trace.push(`timer.fired ${fired.kind}: no rule decides it yet`);
        return out;
      }
      const job = workflow.jobs[fired.payload.job];
      if (!job) return out;
      // The debounced reply to the block of a pending job no settle could start: that very job starts (ORC-339).
      const stranded = ticket?.delegated ? strandedPending(ticket, workflow) : undefined;
      if (stranded) return startPending(out, event, ticket!, workflow, stranded);
      const held = fired.payload.inbox ? heldInbox(ticket) : undefined;
      if (held) {
        out.trace.push(`timer.fired debounce: ${job.name} not started, ${held}`);
        return out;
      }
      // Armed before the wait on blockers began (ORC-363): the wait holds it back as it does a reply.
      const waits = heldByWait(ticket, job);
      if (waits) {
        out.trace.push(`timer.fired debounce: ${job.name} not started, ${waits}`);
        return out;
      }
      if (ticket?.blocked && !refusal(event, ticket, job)) unblock(out, event, ticket);
      humanRound(out, event, ticket, workflow, job, { input: job.input });
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
      else out.events.push({ type: 'ticket.blocked', reason, kind: 'dead_letter', eventId: event.payload.eventId });
      tell(
        out,
        workflow,
        blockFacts({ reason, step: stepOf(workflow, ticket.activeJob ?? event.payload.eventType), attempts: event.payload.attempts ?? event.payload.failures, tried: [deadLetterTried(event.payload)], question: `Can a maintainer repair this event: \`factory run repair ${ticket.ticketId}\`?` }),
        { kind: 'activity', type: 'error', body: `${reason} A maintainer can repair it: \`factory run repair ${ticket.ticketId}\`.` },
      );
      return out;
    }
    case 'effect.failed': {
      // `settle` is a step of the shell, not an effect of the workflow: its failure is only logged, unless it leaves a
      // pending job no run will start (ORC-339). Its block says so, and a reply resumes the ticket (ORC-196).
      const { kind, error, eventId } = event.payload;
      if (kind === 'settle') return ticket ? stuckPending(out, ticket, workflow, error, event.payload.attempts) : out;
      if (!ticket) return out;
      if (isRefusedNotice(eventId)) {
        out.trace.push('effect.failed ignored: the notice of a refused event, which blocks nothing');
        return out;
      }
      // Nothing more comes of it: no result will lift the hold `verify.passed` kept.
      if (kind === 'publish' && ticket.verifyingRunId) out.events.push({ type: 'work.cancelled' });
      // A Done whose merge died (ORC-148) is not delivered: the human hears it, the ticket back in Human Review. Once a
      // human took it out of Done meanwhile, the merge was given up: only answered, as a late refusal is.
      if (kind === 'merge' && ticket.prState !== 'MERGED') {
        const failed = `I could not merge PR #${ticket.prNumber}: ${error}.`;
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
      // The comment of a block died (ORC-196): the tracker is down, the block keeps its reason and its step, shown in the Flow.
      if (kind === 'block_comment' && ticket.blocked) {
        out.trace.push('effect.failed ignored: the comment of a block, which keeps its reason');
        return out;
      }
      // The error notice of a block died: the ticket stays blocked for the reason the notice carried.
      if (eventId.startsWith('effect:') && ticket.blocked) {
        out.trace.push('effect.failed ignored: the notice of a block, which keeps its reason');
        return out;
      }
      const reason = `Error: ${error}`;
      out.events.push({ type: 'ticket.blocked', reason, kind: 'infra' });
      // The error notice of a failed effect is not noticed again when it fails too: the tracker may be what fails.
      if (!eventId.startsWith('effect:')) tell(out, workflow, blockFacts({ reason, step: stepOf(workflow, ticket.activeJob ?? kind), tried: [`The effect ${kind}, ${event.payload.attempts} times.`] }), { kind: 'activity', type: 'error', body: reason });
      return out;
    }
    case 'pr.merged':
      // Delivered: the dev run in flight stops, and nothing pending, queued or debounced starts after the merge.
      // Before the rule's effects, so its cleanup and learn run come after the stop.
      cancelWork(out, 'built-in pr.merged: work cancelled');
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
      stop(out, workflow, `PR #${n} closed without merge`, `PR #${n} was closed without merge: I am stopping work on this ticket. ${relaunch(workflow)}`, 'pr_closed');
      break;
    }
    case 'ticket.undelegated':
      // Its team got a repo, or delegated again with its `repo:` label the ticket went to its repo: here nothing waits any longer (ORC-171, ORC-291).
      // Otherwise taken back by a human (ORC-227): its work is cancelled as a cancel's is (ORC-170), a check, a waiting job and the
      // timers included, which the stop of a run under way does not reach. A blocked ticket keeps its block and its job: its work
      // already ended, by that stop when the reconciliation sent one first.
      if (isUnrouted(ticket)) out.events.push(...END_OF_WAIT);
      else if (state?.delegated && !state.blocked) cancelWork(out, 'built-in ticket.undelegated: work cancelled');
      break;
    case 'label.changed': {
      // Routing is sticky (ORC-291): a ticket at work stays in its repo, whichever repo of the team a label added names.
      const { change, otherRepo } = event.payload;
      if (change === 'added' && otherRepo && ticket && holds(ticket)) {
        out.effects.push({ kind: 'comment', body: `This ticket stays on the repository ${event.projectId}: the repository does not change along the way. With no branch or PR yet, stop the work, remove the delegation, wait 5 minutes for the reconciliation to see it, then delegate again. Otherwise, open a new ticket for the other repository.` });
      }
      break;
    }
    case 'push.human': {
      const paused = humanPush(out, event, state, ticket, workflow);
      if (paused) return paused;
      break;
    }
    case 'pr.merge_refused':
      return mergeRefused(out, event, ticket, workflow);
    case 'pr.reviewed':
      return humanReview(out, event, ticket, workflow, matrix);
    case 'pr.conflicted':
      // The open PR of the ticket only is rebased (ORC-146): another PR's conflict, or a merged or closed one's, is recorded.
      if (ticket?.prNumber !== event.payload.number || ticket.prState !== 'OPEN') {
        out.trace.push(`pr.conflicted: PR #${event.payload.number} is not the open PR of the ticket, nothing started`);
        return out;
      }
      // A rebase already running or waiting takes the branch onto the base as it is then: a new head still in conflict asks no second one.
      if ([ticket.activeJob, ticket.pendingJob?.job].some((j) => j && stepOf(workflow, j) === REBASE)) {
        out.trace.push('pr.conflicted: a rebase is already running or waiting, nothing started');
        return out;
      }
      break;
    case 'default_branch.pushed':
    case 'ci.run_completed':
      // Facts for the measures (ORC-278): a revert of the ticket's PR, a CI run's duration. Nothing to decide.
      out.trace.push(`${event.type}: recorded for the measures`);
      return out;
    case 'pr.checks_passed':
      // A ticket blocked by the red-CI bound is no longer blocked for a reason that holds: the block is lifted. The count of
      // the review and CI loop stays, one per run (ORC-184): a review that keeps finding would loop between its fix and green CI.
      // The rules of pr.checks_passed still apply.
      if (ticket?.blocked && ticket.blockKind === 'ci_bound') out.events.push({ type: 'ticket.unblocked' });
      break;
    case 'pr.opened': {
      // A new PR (another number) reopens a delivered ticket; the same PR seen again leaves it as it is,
      // unless it was closed: reopened, it is open again (ORC-134).
      const other = event.payload.number !== ticket?.prNumber;
      const reopens = other || ticket?.prState === 'CLOSED';
      // Another PR is another review and CI loop: the count of the previous one does not carry over (ORC-270).
      if (other) resetRedCi(out, ticket);
      // And another round of human review (ORC-190).
      if (other && ticket?.humanReviewRounds) out.events.push({ type: 'ticket.patched', patch: { humanReviewRounds: 0 } });
      out.events.push({
        type: 'ticket.patched',
        patch: { prNumber: event.payload.number, prUrl: event.payload.url, ...(reopens ? { prState: 'OPEN' as const } : {}) },
      });
      out.effects.push({ kind: 'link_pr', url: event.payload.url });
      return out;
    }
    case 'session.stopped': {
      const sessionId = event.payload.linearSessionId;
      if (isQuestionSession(ticket, sessionId)) return stopQuestion(out, sessionId!);
      break;
    }
    case 'ticket.commented':
      // The reply to a block's comment (ORC-196). A ticket that waits for none, or a version that asks for it in its session: between humans.
      if (!workflow.blockComment || !ticket?.blocked || !ticket.delegated) {
        out.trace.push('ticket.commented: no reply awaited');
        return out;
      }
      if (!authorize(out, event, ticket, 'relaunch_blocked', 'linear', matrix)) return out;
      // Into the human inbox as any reply, its class and its taint with it (ORC-180, I12): the run that empties it takes them.
      keepMessage(out, event, 'session');
      // A command relaunches nothing, here as in a session.
      if (event.payload.kind === 'command') return factoryCommand(out, event, ticket, workflow);
      break;
    case 'session.mentioned':
      // Kept, as any message (ORC-180). One that asks for an action never takes the question path of its rule.
      if (event.payload.kind && ticket) {
        const order = event.payload.kind === 'instruction' && ticket.delegated;
        keepMessage(out, event, order ? 'session' : 'thread');
        if (event.payload.kind === 'command') return factoryCommand(out, event, ticket, workflow);
        if (order) return ticket.blocked ? out : regroup(out, event, ticket, workflow);
      }
      break;
    case 'command':
      if (event.payload.kind && ticket) keepMessage(out, event, 'session');
      break;
    case 'session.prompted':
      if (event.payload.kind) return classifiedReply(out, event, ticket, workflow, matrix);
      if (isQuestionSession(ticket, event.payload.linearSessionId)) {
        // Only who may answer the agent may ask the answering agent a question.
        if (!authorize(out, event, ticket, 'answer_clarify', 'linear_session', matrix)) return out;
        out.trace.push('built-in session.prompted (question session)');
        askInThread(out, event, ticket, workflow);
        return out;
      }
      // In the dev session, a reply relaunches a blocked ticket, or answers the agent; a refused one is not kept.
      if (!authorize(out, event, ticket, ticket?.blocked ? 'relaunch_blocked' : 'answer_clarify', 'linear_session', matrix)) return out;
      // A reply in the dev session is kept whether a rule matches or not (I6).
      if (ticket) keepMessage(out, event, 'session');
      if (answersClarify(ticket)) return clarifyAnswer(out, event, ticket, workflow);
      break;
    default:
      break;
  }
  const rules = workflow.on[event.type] ?? [];
  const index = firstRule(event.type, event, ticket, workflow);
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
  if ((event.type === 'pr.checks_failed' || event.type === 'pr.conflicted') && rule.run) return reviewCiLoop(out, rule, event, ticket, workflow);
  return applyRule(out, rule, event, ticket, workflow);
}
