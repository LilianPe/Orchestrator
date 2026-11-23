import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactsRefused, ReviewLinesRefused, type MergeResult } from '../adapters/forge/types.js';
import { prEventId, pushEventId } from '../adapters/forge/github-webhook.js';
import { PublishRefused } from '../adapters/publisher/types.js';
import { DEFAULT_REQUIREMENTS, WORKSPACE_TARGET } from '../adapters/sandbox/types.js';
import type { ActivityInput } from '../adapters/tracker/types.js';
import { KEPT_PR, type EffectOutcome, type OutboxRow, type RunRecord } from '../store/types.js';
import { describePr, START_SAID, verifySummary, type PrFacts } from '../publish/describe.js';
import { composeResult, OutputRefused } from '../publish/output-policy.js';
import type { Effect } from '../core/decision.js';
import { blockFacts, composeBlockComment, type BlockFacts, type BlockStatus } from '../core/block-comment.js';
import { mayPublish, RECONCILE_MS, reconcileTicket } from '../core/engine.js';
import { codeRunTokens, mergeTime, runMeasure } from '../core/measures.js';
import { DAY_MS } from '../core/baseline.js';
import { advancePlan, closePlan, planStepOfJob, startPlan, type PlanStep } from '../core/session-plan.js';
import { MERGE_PUSHED, upcast, upcastMergeRefusal, type MergeRefusal } from '../core/upcast.js';
import { type LogicalState, type TicketState, SCHEMA_VERSION, TRUSTED } from '../core/types.js';
import { VERIFY_CHECK } from '../core/verify.js';
import { WORKFLOW_FORMAT } from '../core/workflow.js';
import { REVIEW_LABELS, reviewLabel } from '../core/diff-class.js';
import { blockingFindings, inlineComment, NO_CHANGE, onItsLine, REVIEW_CHECK, reviewBody, reviewVerdict } from '../core/review.js';
import { FREEZE_CHECK } from '../checks/freeze.js';
import { ANTI_CHEAT_CHECK, ANTI_CHEAT_OK } from '../checks/anti-cheat.js';
import { mdCode } from '../checks/markdown.js';
import { DIFF_QUALITY_CHECK, diffQualityCheck, worstOfQuality } from '../checks/diff-quality.js';
import { captureArtifactId, captureLabel, captureName, VISUAL_PROOF_CHECK, type VisualProof } from '../checks/visual-proof.js';
import { changelogEntry, deliveredBody, lastPushed, mergedWork, type MergedPr } from '../core/changelog.js';
import { isTakenOver } from '../core/block-cause.js';
import { formatSpec, publishedSpec, specComment, specSummary, specTitle } from '../core/spec.js';
import { SPEC_PUBLICATION } from '../config/factory-yml.js';
import { type EffectKey, type StateIo, takeOverKey } from './daemon-base.js';
import { DaemonChecks } from './checks.js';
import type { ProjectRuntime, TakeOverDesk } from './daemon.js';

const asIs: StateIo = (io) => io;

/** How long the captures of a merged or closed PR stay on `factory/artifacts` (ORC-407). */
export const CAPTURES_KEPT_MS = 30 * DAY_MS;

/** What the PR's description is composed from (`describePr`), published or kept (ORC-231). */
const publishFacts = (t: TicketState, c: Extract<Effect, { kind: 'publish' }>) => ({
  ticketId: t.ticketId, title: t.title, sha: c.sha, ...(c.commands ? { commands: c.commands } : {}), ...(t.visualProof ? { visualProof: t.visualProof } : {}),
  ...(c.visualProof?.start ? { start: c.visualProof.start } : {}),
  ...(c.quality ? { lookFirst: worstOfQuality(c.quality) } : {}),
});

/** A session's plan as the store keeps it (ORC-171): the session is that of the delegation that opened it. */
interface KeptPlan {
  sessionId: string;
  plan: PlanStep[];
}

/** Why the forge refused a check run, when it says so: the hint a 403 needs, nothing for any other failure. */
function checksPermission(err: { status?: number }): string {
  return err.status === 403 ? ': the GitHub App lacks the Checks write permission (docs/github.md)' : '';
}

/**
 * `factory/preuve-visuelle` (ORC-176): the captures the factory took, or that there is none to take. A required proof the instance
 * could not take is neutral, indicative until the application starts reliably in the sandbox (ORC-152): it blocks nothing.
 */
function visualCheck(p: VisualProof): { conclusion: 'success' | 'neutral'; summary: string } {
  if (p.decision === 'not_applicable') return { conclusion: 'neutral', summary: 'No visual proof applicable.' };
  const why = [
    ...(p.intake ? ['Asked for at intake.'] : []),
    ...(p.triggers.length ? [`Changed under \`visual_paths\`:\n${p.triggers.map((t) => `- ${mdCode(t)}`).join('\n')}`] : []),
    ...(p.start ? [`Start command: ${START_SAID[p.start]}`] : []),
  ].join('\n');
  if (!p.captures?.length) return { conclusion: 'neutral', summary: `Visual proof required, not taken: ${p.unavailable ?? 'no capture'}. Indicative until the application starts reliably in the sandbox (ORC-152).\n${why}` };
  const lines = p.captures.map((c) => `- ${captureLabel(c)}: sha256 ${c.sha256}`);
  return { conclusion: 'success', summary: `Captures taken by the factory, before on the base and after on this commit:\n${lines.join('\n')}\n${why}` };
}

/** Where a bundle handed back is checked (`<runsDir>/<key>/`, its secret scan's sandbox `<key>-publish-secrets`): an attempt like any, which `recover()` reaps. */
const bundleKey = (projectId: string, ticketId: string): string => `bundle-${projectId}-${ticketId}`;

/** The daemon's outbox effects (ORC-394): `exec` and each effect, the publication, the merge, the review, the moves, the comments, the plan, the take-over. */
export abstract class DaemonEffects extends DaemonChecks {
  /**
   * The captures `verify` took on the published commit, hosted for its PR (ORC-407): each file `keepCaptures` kept, read back by its
   * row in `artifacts`, committed on the repository's `factory/artifacts` branch under `<ticket>/`. What cannot be shown is said
   * (`unhosted`): no host, a file gone from the disk, a refusal of the forge. Anything else throws, and the publication is retried.
   */
  private async hostCaptures(project: ProjectRuntime, t: TicketState, c: Extract<Effect, { kind: 'publish' }>): Promise<Pick<PrFacts, 'captures' | 'unhosted'>> {
    const shots = c.visualProof?.captures;
    if (!shots?.length) return {};
    if (this.noEffect(project.id)) return { unhosted: 'the project has no effects: nothing goes out.' };
    if (!this.d.captureHost) return { unhosted: 'this instance has no GitHub App to host them (docs/github.md).' };
    const kept = new Map((await this.d.store.artifacts(t.ticketId)).map((a) => [a.id, a.path]));
    const paths = shots.map((s) => kept.get(captureArtifactId(c.runId, s)));
    // A file gone says nothing of where it was: its path is the server's, not for the PR.
    const contents = paths.every((p) => p !== undefined) ? await Promise.all(paths.map((p) => readFile(p))).catch(() => undefined) : undefined;
    if (!contents) return { unhosted: "a capture is no longer kept on the factory's disk." };
    const files = shots.map((s, i) => ({ path: `${t.ticketId}/${s.side}-${s.width}-${s.sha256.slice(0, 16)}.png`, content: contents[i]! }));
    try {
      const urls = await this.d.captureHost.hostArtifacts(project.github, files);
      return { captures: shots.map((s, i) => ({ width: s.width, caption: captureName(s), url: urls[i]! })) };
    } catch (err) {
      if (err instanceof ArtifactsRefused) return { unhosted: err.message };
      throw err;
    }
  }

  /**
   * The captures of PRs merged or closed 30 days ago or more, removed from each repository's `factory/artifacts` (ORC-407): a
   * folder per ticket, removed when the ticket's last PR event is its merge or its closing, that long ago. A ticket the factory
   * does not know, or whose PR is open, keeps its folder. Returns the folders removed, as `<repo>: <ticket>`.
   */
  async pruneCaptures(now: number): Promise<string[]> {
    const host = this.d.captureHost;
    if (!host) return [];
    const byRepo = new Map<string, string[]>();
    for (const p of this.d.projects) if (!this.noEffect(p.id)) byRepo.set(p.github, [...(byRepo.get(p.github) ?? []), p.id]);
    const removed: string[] = [];
    for (const [github, projectIds] of byRepo) {
      const expired = async (ticketId: string) => {
        for (const projectId of projectIds) {
          const t = await this.d.store.getTicket(projectId, ticketId);
          if (!t) continue;
          // Only a PR merged or closed has its time to read, in the journal.
          if (t.prState !== 'MERGED' && t.prState !== 'CLOSED') return false;
          const last = (await this.d.store.ticketJournal(projectId, ticketId)).map((j) => upcast(j.event)).findLast((e) => e.type === 'pr.opened' || e.type === 'pr.merged' || e.type === 'pr.closed');
          if (!last || last.type === 'pr.opened') return false;
          return now - (last.type === 'pr.merged' ? mergeTime(last) : last.at) >= CAPTURES_KEPT_MS;
        }
        return false;
      };
      // One repository the forge refuses keeps none of the others from their cleanup.
      const folders = await host.pruneArtifacts(github, expired).catch((err: Error) => (this.log('warn', `captures of ${github} not pruned: ${err.message}`), []));
      for (const folder of folders) removed.push(`${github}: ${folder}`);
    }
    return removed;
  }

  /**
   * A block made out of a decision (a launch that failed, a refused pickup): the same comment as any other, without an effect's key.
   * `once`: the comment's own key, when one notice is enough for good: a comment found under it is not written again.
   */
  protected async tellBlock(project: ProjectRuntime, t: TicketState, facts: BlockFacts, once?: string): Promise<void> {
    if (this.silenced(project.id, `the block notice of ${t.ticketId}`)) return;
    // A key of its own: it carries the marker that tells a comment of the factory from a human's reply.
    await this.commentOnce(t.ticketId, async () => composeBlockComment(facts, await this.blockStatus(t)), { id: once ?? `block:${this.newId()}`, replay: once !== undefined });
  }

  /**
   * A ticket refused for the format of its frozen version (ORC-393), told on it (ORC-419): it is not blocked, none of its events
   * is decided, and only a new ticket goes on with the request. Once by ticket and version, whatever the daemon: a notice found is not
   * written again.
   */
  protected async tellRefusal(projectId: string, ticketId: string, hash: string): Promise<void> {
    const t = await this.d.store.getTicket(projectId, ticketId);
    if (!t) return;
    const facts = blockFacts({
      step: 'old frozen workflow version',
      reason: `This ticket is frozen on workflow version ${hash.slice(0, 12)}, of another format than the one this factory reads (${WORKFLOW_FORMAT}): it is refused, and none of its events is decided.`,
      tried: ['Reading the workflow version the ticket started with.'],
      question: 'Can you open a new ticket for this request? It starts on the current workflow; this one stays refused.',
    });
    // By ticket as well: Linear derives the comment's id from its key, and tickets share a version.
    await this.tellBlock(this.project(projectId), t, { ...facts, waits: 'never' }, `refused:${ticketId}:${hash}`);
  }

  /** The state line of a block's comment. An unknown value is said as such: reading it must not stop the comment. */
  private async blockStatus(t: TicketState): Promise<BlockStatus> {
    const sha = t.worktreePath ? await this.d.workspaces.head(t.worktreePath).catch(() => undefined) : undefined;
    const runs = await this.d.store.ticketRuns(t.projectId, t.ticketId).catch((): RunRecord[] => []);
    const ended = runs.filter((r) => r.endedAt !== undefined);
    return {
      branch: t.branch,
      sha,
      ci: t.prChecks,
      // The figure of `per_ticket_tokens`: a budget block says the same number as its state line.
      tokens: codeRunTokens(runs),
      durationMs: ended.length ? ended.reduce((n, r) => n + r.endedAt! - r.startedAt, 0) : undefined,
    };
  }

  /**
   * An effect of a project without effects (ORC-231), kept instead of made: what it would have written, as a JSON file and its row in
   * `artifacts`, once by the row's id. A `publish` keeps the PR it would have opened, its title, its body and the ticket's diff, then
   * goes on as a publication does (`publish.done`), so the run ends as it would have; a `reconcile` reads nothing and keeps nothing.
   */
  protected async keep(row: OutboxRow, dir: string): Promise<void> {
    const effect = row.effect;
    if (effect.kind === 'reconcile' || !row.ticketId) return;
    const project = await this.runtimeFor(row.projectId, row.ticketId);
    if (!project) return;
    const t = await this.ticket(project.id, row.ticketId);
    if (effect.kind === 'publish') return this.keepPublication(project, t, effect, row.id, dir);
    await this.keepFile(dir, t.ticketId, row.id, `kept:${effect.kind}`, { kind: effect.kind, row: row.id, effect }, 'runId' in effect ? effect.runId : undefined);
  }

  /**
   * A kept `publish` (ORC-231): the same gate as a publication (`publishRefusal`, the output policy on the PR's text), then the PR it
   * would have opened, with the ticket's diff, and the run goes on as after a publication; a run that committed nothing keeps none.
   */
  private async keepPublication(project: ProjectRuntime, t: TicketState, c: Extract<Effect, { kind: 'publish' }>, rowId: string, dir: string): Promise<void> {
    if (t.verifyingRunId !== c.runId) return this.log('info', `kept publish of ${t.ticketId} dropped: the ticket let go of run ${c.runId}`);
    const base = { ...TRUSTED, projectId: project.id, ticketId: t.ticketId, at: this.d.clock.now() };
    const payload = { runId: c.runId, job: c.job, sha: c.sha };
    const refuse = async (reason: string) => void (await this.accept({ ...base, id: `publish-refused:kept:${rowId}`, type: 'publish.refused', payload: { ...payload, reason } }));
    const done = async (empty = false) => void (await this.accept({ ...base, id: `publish-done:kept:${rowId}`, type: 'publish.done', payload: { ...payload, ...(c.output ? { output: c.output } : {}), ...(empty ? { empty: true as const } : {}) } }));
    const refusal = this.publishRefusal(project, t, c.sha);
    if (refusal) return refuse(refusal);
    if (!t.branch || !t.worktreePath) return refuse(`no branch or no worktree for ${t.ticketId}.`);
    const diff = await this.d.workspaces.ticketDiff(project.mirror, t.worktreePath);
    // A run that committed nothing has nothing to show: it ends as it would have, without a PR. An unreadable diff says nothing of it.
    const nothing = diff !== undefined && (!diff.trim() || diff === NO_CHANGE);
    if (diff === undefined || nothing) return done(nothing);
    let text;
    try {
      text = await this.policy.pr(describePr(c.output, { ...publishFacts(t, c), ...(await this.hostCaptures(project, t, c)) }));
    } catch (err) {
      if (!(err instanceof OutputRefused)) throw err;
      return refuse(`the PR's text does not pass the output policy: ${err.refusals.map((r) => r.detail).join('; ')}.`);
    }
    await this.keepFile(dir, t.ticketId, rowId, KEPT_PR, { kind: 'publish', row: rowId, pr: { ...text, branch: t.branch, sha: c.sha, diff } }, c.runId);
    await done();
  }

  /** One kept effect: its JSON under `<dir>/<ticket>/`, and its row in `artifacts`, once by the outbox row's id. */
  private async keepFile(dir: string, ticketId: string, rowId: string, kind: string, content: Record<string, unknown>, runId: string | undefined): Promise<void> {
    const body = `${JSON.stringify(content, null, 2)}\n`;
    const folder = join(dir, ticketId);
    await mkdir(folder, { recursive: true });
    const path = join(folder, `${rowId.replaceAll(/[^\w.-]/g, '_')}.json`);
    await writeFile(path, body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    await this.d.store.putArtifact({ id: `kept:${rowId}`, ticketId, ...(runId ? { attemptId: runId } : {}), kind, path, sha256, createdAt: this.d.clock.now() });
    this.log('info', `effect ${rowId} of ${ticketId} kept as ${kind}, not made: the project has no effects`);
  }

  /** Why a commit may not be published (ORC-125), whatever would publish it: it has no green verification. */
  private publishRefusal(project: ProjectRuntime, t: TicketState, sha: string): string | undefined {
    if (mayPublish(t, sha)) return undefined;
    return `the commit ${sha.slice(0, 12)} has no green verification, the last one is on ${t.verifiedSha?.slice(0, 12) ?? 'no commit'}.`;
  }

  /**
   * `key`: the idempotency key of the effect (ORC-162, docs/idempotency.md). Only a replay (a row
   * claimed before) looks for what an earlier execution wrote: a first execution has nothing to find.
   * A replay that finds the effect already made writes nothing and says so.
   */
  protected async exec(project: ProjectRuntime, ticketId: string | undefined, c: Effect, key: EffectKey): Promise<EffectOutcome | void> {
    const { store, tracker, clock } = this.d;
    if (c.kind === 'set_paused') {
      await store.setMeta('paused', c.paused ? '1' : '0');
      if (!c.paused) {
        await this.drain('dev');
        await this.drain('questions');
      }
      return;
    }
    if (c.kind === 'reconcile') {
      // Never fails: a dead effect would disarm the next timer its decision armed, and stop the 5-minute chain.
      await this.d.reconcile?.(project).catch((err: Error) => this.log('warn', `reconcile ${project.id}: ${err.message}`));
      return;
    }
    if (!ticketId) return;
    const t = await this.ticket(project.id, ticketId);
    switch (c.kind) {
      case 'start_run': {
        // A replay (a lost lease) must not start again what was handled: launched, set pending
        // behind the run it started, or queued (`startHandled`).
        const mark = `effect:${key.id}:started`;
        if (key.replay && (await this.startHandled(mark))) return { deduplicated: true };
        await this.startRun(project, ticketId, { ...c, startMark: mark });
        await store.setMeta(mark, '1');
        return;
      }
      case 'stop_run': {
        if (c.linearSessionId) {
          for (const r of await store.runsByStatus('running')) {
            if (r.projectId === project.id && r.ticketId === ticketId && r.linearSessionId === c.linearSessionId) this.stopRun(r.id);
          }
          return;
        }
        // The ticket's timers were deleted by the decision itself (`clearTimers`).
        // The ticket's dev work only: a question waiting for its slot is still answered.
        await store.removeFromQueue(project.id, ticketId, 'dev');
        if (t.activeRunId) this.stopRun(t.activeRunId);
        return;
      }
      case 'run_verify': {
        if (c.head) return this.verifyPush(project, t, c, c.head);
        const run = await store.getRun(c.runId);
        const job = project.workflow.jobs[c.job];
        // No longer awaited (a stop, a verdict): a replayed effect checks nothing, and moves no plan.
        if (!run || !job || t.verifyingRunId !== c.runId) return;
        if (planStepOfJob(job, project.workflow) === 'Build') await this.updatePlan(t, (plan) => advancePlan(plan, 'Verify'));
        this.withSlot(project, t.ticketId, job.queue, c.runId, async (now) => {
          if (job.red) {
            const red = await this.checkRed(project, run, now);
            const base = { ...TRUSTED, at: clock.now(), projectId: project.id, ticketId, id: `check:${run.id}` };
            const failures = [{ command: red.command || 'factory/red', exitCode: red.exitCode, output: red.detail }];
            const common = { runId: run.id, job: job.name, red: red.cause, ...(red.frozen ? { frozen: red.frozen } : {}) };
            await this.submitResult(
              red.verified
                ? { ...base, type: 'verify.passed', payload: { ...common, ...(c.output ? { output: c.output } : {}) } }
                : { ...base, type: 'verify.failed', payload: { ...common, failures } },
            );
            return;
          }
          await this.submitVerdict(project, now, run.id, job, () => this.verifyWork(project, now, run, job, c.output), c.output);
        });
        return;
      }
      case 'move':
        await this.move(project, t, c.to, c.keepReviewSha);
        // The factory's own work ended; a move back after a refusal concludes nothing.
        if (c.to === 'human_review' && !c.keepReviewSha) {
          await this.prReady(project, t);
          await this.labelReview(project, await this.ticket(project.id, ticketId));
          await this.updatePlan(t, (plan) => closePlan(plan, t.prNumber !== undefined));
        }
        return;
      case 'publish':
        return this.publish(project, t, c, key);
      case 'merge':
        return this.merge(project, t, c.sha, key);
      case 'labels':
        return this.setLabels(project.id, ticketId, c.add, c.remove);
      case 'comment':
        return this.commentOnce(ticketId, c.body, key);
      case 'block_comment':
        return this.commentOnce(ticketId, async () => composeBlockComment(c.block, await this.blockStatus(t)), key);
      case 'ack':
        return this.ack(t, c, key);
      case 'activity': {
        const fromRun = c.runId ? (await store.getRun(c.runId))?.linearSessionId : undefined;
        const session = c.linearSessionId ?? fromRun ?? (await this.sessionFor(t));
        return this.activityOnce(session, c.type === 'elicitation' && c.options ? { type: c.type, body: c.body, options: c.options } : { type: c.type, body: c.body }, key);
      }
      case 'publish_spec':
        return this.publishSpec(t, c, key);
      case 'post_output': {
        const run = await store.getRun(c.runId);
        if (!run) return;
        const session = run.linearSessionId ?? (await this.sessionFor(t));
        // Composed from what the run submitted, never from its last text (ORC-214): a reply is its summary, a build's end
        // its recap with the work of the ticket's attempts (ORC-195).
        const runs = c.style === 'summary' && c.output ? (await store.ticketRuns(t.projectId, ticketId)).map(runMeasure) : [];
        return this.activityOnce(session, { type: 'response', body: composeResult(c.output, c.style, runs) }, key);
      }
      case 'review':
        return this.review(project, t, c, key);
      case 'link_pr':
        if (t.linearSessionId) await tracker.addExternalUrl(t.linearSessionId, 'Pull request', c.url);
        // Seen during the run (the agent opened it), the PR waits for the end of the work: the move to Human Review closes the plan.
        if (!t.activeRunId && !t.verifyingRunId) await this.updatePlan(t, (plan) => advancePlan(plan, 'PR', 'completed'));
        return;
      case 'take_over':
        return this.openTakeOver(t, c.runId);
      case 'publish_bundle':
        return this.publishBundle(project, t, c, key);
      case 'close_take_over':
        return this.closeTakeOver(project.id, ticketId);
      case 'after_merge':
        return this.afterMerge(project, t, c, key);
      case 'cleanup':
        await this.d.workspaces.cleanup(project.id, ticketId);
        await this.apply(await this.ticket(project.id, ticketId), { type: 'workspace.released' });
        return;
    }
  }

  /**
   * The ack of a trigger (ORC-171), best effort: a courtesy must not hold back or kill the run behind it, so a write
   * Linear refuses is logged, neither retried nor blocking. The one key on every write: a replay finds what its first
   * execution wrote of each. The time a measure reads (ORC-235) is the human's first sign of life, before the plan.
   * `acknowledge: reaction` (ORC-380) reacts on the message in place of the comment; a message with no comment to react
   * on, or a reaction Linear refuses, gets the comment, logged; a delegation, which has no message, keeps its comment
   * unlogged. The session's thought stays: Linear asks for an activity.
   */
  private async ack(t: TicketState, c: Extract<Effect, { kind: 'ack' }>, key: EffectKey): Promise<EffectOutcome | void> {
    const outcomes: (EffectOutcome | void)[] = [];
    const attempt = async (what: string, write: () => Promise<EffectOutcome | void>, failed = 'not written'): Promise<boolean> => {
      try {
        outcomes.push(await write());
        return true;
      } catch (err) {
        this.log('warn', `${what} of the ack of ${t.ticketId} ${failed}: ${(err as Error).message}`);
        return false;
      }
    };
    const comment = () => attempt('comment', () => this.commentOnce(t.ticketId, c.body, key));
    // A delegation has no message of its own: it keeps its comment, first, in either mode.
    if (c.comment) await comment();
    await attempt('activity', () => this.activityOnce(c.linearSessionId, { type: 'thought', body: c.body }, key));
    // The reaction comes after the thought, which Linear waits for within 10 s.
    if (this.d.acknowledge === 'reaction' && !c.comment) {
      const { commentId } = c;
      if (!commentId) this.log('info', `no message to put a reaction on for the ack of ${t.ticketId}: a comment instead`);
      const reacted = !!commentId && (await attempt('the reaction', () => this.reactOnce(commentId, key), `refused on comment ${commentId}, a comment instead`));
      if (!reacted) await comment();
    }
    if (outcomes.length > 0) await this.d.store.markAcked(key.eventId, this.d.clock.now()).catch((err: Error) => this.log('warn', `ack of ${key.eventId} posted, its time not recorded: ${err.message}`));
    if (c.plan) await this.openPlan(t, c.linearSessionId);
    // Already made only if nothing was written here.
    return outcomes.length > 0 && outcomes.every((o) => o?.deduplicated) ? outcomes[0] : undefined;
  }

  /**
   * The `after_merge` step (ORC-197). The changelog entry first, which needs nothing of Linear: appended once by its merge, never
   * changed. Then the requester, the issue's creator, mentioned in the ticket's session with the merged PR's link. A replay finds both.
   * The mention is best effort, as an ack: a dead effect would hold back the cleanup and the run its decision starts after it.
   */
  private async afterMerge(project: ProjectRuntime, t: TicketState, c: MergedPr, key: EffectKey): Promise<EffectOutcome | void> {
    const events = (await this.d.store.ticketJournal(project.id, t.ticketId)).map((j) => upcast(j.event));
    const appended = await this.d.store.appendChangelog(changelogEntry(t, c, mergedWork(events, c.headSha)));
    try {
      const { creator } = await this.d.tracker.getIssue(t.ticketId);
      const told = await this.activityOnce(await this.sessionFor(t), { type: 'response', body: deliveredBody(creator, c) }, key);
      return !appended && told?.deduplicated ? told : undefined;
    } catch (err) {
      this.log('warn', `the requester of ${t.ticketId} not told of PR #${c.number}: ${(err as Error).message}`);
    }
  }

  /**
   * A version of the spec (ORC-382): in a comment of the ticket, or in a document linked to it, as factory.yml's `spec` says, the
   * comment then giving its summary and its link; a tracker that keeps no document gets the whole spec in the comment. Then the
   * session, where the validator replies, says where to read it. One key on every write: a replay finds what its first
   * execution wrote of each, the document first, whose link the comment and the session carry.
   */
  private async publishSpec(t: TicketState, c: Extract<Effect, { kind: 'publish_spec' }>, key: EffectKey): Promise<EffectOutcome | void> {
    const { mode, threshold } = this.d.specPublication ?? SPEC_PUBLICATION;
    const whole = specComment(c.spec, c);
    const inDocument = mode === 'doc' || (mode === 'comment+doc' && whole.length > threshold);
    const title = specTitle(t.ticketId, c.version);
    const doc = inDocument ? await this.documentOnce(t.ticketId, title, formatSpec(c.spec), key) : undefined;
    if (doc && !doc.ref) this.log('info', `the spec of ${t.ticketId} in a comment alone: the tracker keeps no document beside a ticket`);
    const url = doc?.ref;
    const comment = await this.commentOnce(t.ticketId, url ? specSummary(c.spec, c, { title, url }) : whole, key);
    const told = await this.activityOnce(await this.sessionFor(t), { type: 'response', body: publishedSpec(c.spec, c, url) }, key);
    // Already made only if nothing was written here: the document (when there is one), the comment and the session's message.
    const docMade = !doc?.ref || doc.deduplicated;
    return docMade && comment?.deduplicated && told?.deduplicated ? comment : undefined;
  }

  /** A document linked to the ticket (ORC-382), written unless its first execution already wrote it; `ref`: its link, none for a tracker without documents. */
  private async documentOnce(ticketId: string, title: string, body: string, key: EffectKey): Promise<EffectOutcome> {
    const found = key.replay ? await this.d.tracker.findDocument(ticketId, key.id) : undefined;
    if (found !== undefined) return { deduplicated: true, ref: found };
    const url = await this.d.tracker.document(ticketId, title, body, key.id);
    return url ? { ref: url } : {};
  }

  /** The ack's reaction on a message (ORC-380): 👀, by its name, put unless its first execution already put it (ORC-162). */
  private async reactOnce(commentId: string, key: EffectKey): Promise<EffectOutcome | void> {
    const found = key.replay ? await this.d.tracker.findReaction(commentId, key.id) : undefined;
    if (found !== undefined) return { deduplicated: true, ref: found };
    await this.d.tracker.react(commentId, 'eyes', key.id);
  }

  /** A comment of an outbox effect, written unless its first execution already wrote it (ORC-162). */
  private async commentOnce(ticketId: string, body: string | (() => Promise<string>), key: Pick<EffectKey, 'id' | 'replay'>): Promise<EffectOutcome | void> {
    const found = key.replay ? await this.d.tracker.findComment(ticketId, key.id) : undefined;
    if (found !== undefined) return { deduplicated: true, ref: found };
    await this.d.tracker.comment(ticketId, typeof body === 'string' ? body : await body(), key.id);
  }

  /** Opens the session's plan (ORC-171), in the session of the delegation that asks for it. */
  private openPlan(t: TicketState, sessionId: string): Promise<void> {
    return this.writePlan(t, async () => ({ sessionId, plan: startPlan() }));
  }

  /** Moves the session's plan on; a ticket whose delegation opened none gets none. */
  protected updatePlan(t: TicketState, change: (plan: readonly PlanStep[]) => PlanStep[]): Promise<void> {
    return this.writePlan(t, async (key) => {
      const stored = await this.d.store.getMeta(key);
      if (!stored) return undefined;
      const { sessionId, plan } = JSON.parse(stored) as KeptPlan;
      return { sessionId, plan: change(plan) };
    });
  }

  /**
   * Keeps the plan in the store with its session, for the next update to build on, and writes it to Linear. Never
   * throws: Linear's plan API is a preview, and a plan it refuses must not stop the work.
   */
  private async writePlan(t: TicketState, next: (key: string) => Promise<KeptPlan | undefined>): Promise<void> {
    const key = `plan:${t.projectId}:${t.ticketId}`;
    if (this.silenced(t.projectId, `the plan of ${t.ticketId}`)) return;
    try {
      const kept = await next(key);
      if (!kept) return;
      await this.d.store.setMeta(key, JSON.stringify(kept));
      await this.d.tracker.setSessionPlan(kept.sessionId, kept.plan);
    } catch (err) {
      this.log('warn', `plan of ${t.ticketId} not written: ${(err as Error).message}`);
    }
  }

  /** An activity of an outbox effect, written unless its first execution already wrote it (ORC-162). */
  private async activityOnce(session: string, a: ActivityInput, key: EffectKey): Promise<EffectOutcome | void> {
    const found = key.replay ? await this.d.tracker.findActivity(session, key.id) : undefined;
    if (found !== undefined) return { deduplicated: true, ref: found };
    await this.d.tracker.activity(session, a, key.id);
  }

  /** `state`: what the caller makes of a failed read or write of the factory's state (a launch's: a start to try again, ORC-359). */
  protected async sessionFor(t: TicketState, state: StateIo = asIs): Promise<string> {
    if (t.linearSessionId) return t.linearSessionId;
    // A project without effects opens no Linear session (ORC-231): a local one, which only kept effects name.
    const s = this.noEffect(t.projectId) ? `kept:${t.ticketId}` : await this.d.tracker.ensureSession(t.ticketId);
    await state(this.apply(await state(this.ticket(t.projectId, t.ticketId)), { type: 'session.linked', linearSessionId: s }));
    return s;
  }

  /**
   * Plans each project's reconciliation in the store (ORC-185), in `RECONCILE_MS` (the connection to Linear passes
   * at once), unless a timer already plans it (a restart): its firings then arm the next ones. The timer of a
   * project gone from the configuration is deleted: it would fire for a project the factory no longer knows.
   */
  async armReconciliation(): Promise<void> {
    const timers = (await this.d.store.dueTimers(Number.MAX_SAFE_INTEGER)).filter((t) => t.kind === 'reconcile');
    for (const t of timers) if (!this.d.projects.some((p) => p.id === t.projectId)) await this.d.store.deleteTimersFor(t.projectId, t.ticketId);
    for (const p of this.d.projects) {
      const ticketId = reconcileTicket(p.id);
      if (timers.some((t) => t.ticketId === ticketId)) continue;
      await this.d.store.putTimer({ key: `${ticketId}:reconcile`, projectId: p.id, ticketId, kind: 'reconcile', payload: {}, fireAt: this.d.clock.now() + RECONCILE_MS });
    }
    this.wake();
  }

  /** `state`: as `sessionFor`'s. */
  protected async move(project: ProjectRuntime, t: TicketState, to: LogicalState, keepReviewSha?: boolean, state: StateIo = asIs): Promise<void> {
    // `ready` and `cancelled` have no status (ORC-170): nothing moves a ticket to them.
    const stateName = project.workflow.states[to];
    if (!stateName) throw new Error(`no status for "${to}" in the workflow of ${project.id}`);
    if (this.silenced(project.id, `the move of ${t.ticketId} to ${to}`)) return;
    // Only a move that concludes the factory's work records the commit shown; a move back keeps the reviewed one.
    // Read before the move: the status is recorded right after its write, which is how a pass knows it (ORC-346).
    const reviewSha = to !== 'human_review' ? undefined : keepReviewSha ? t.reviewSha : await this.headShown(project, t);
    await this.d.tracker.moveTo(t.ticketId, stateName);
    await state(this.apply(await state(this.ticket(project.id, t.ticketId)), { type: 'status.recorded', to, ...(reviewSha ? { reviewSha } : {}) }));
  }

  /**
   * The head of the ticket's open PR as the factory shows it in Human Review (ORC-148): the only commit a Done merges.
   * Recorded only when it is the commit the ticket's worktree ended its run on: a head pushed meanwhile, which the
   * run (a review) never read, is no reviewed commit. Unread (no branch, no PR, no worktree, the forge down) or
   * different, none is recorded: a Done is refused until the factory moves the ticket to Human Review again.
   */
  private async headShown(project: ProjectRuntime, t: TicketState): Promise<string | undefined> {
    if (!t.branch || !t.worktreePath) return undefined;
    try {
      const [pr, local] = await Promise.all([this.d.forge.findPr(project.github, t.branch), this.d.workspaces.head(t.worktreePath)]);
      if (pr?.state !== 'OPEN' || !pr.headSha) return undefined;
      if (pr.headSha === local) return pr.headSha;
      this.log('warn', `head of ${t.ticketId}'s PR (${pr.headSha}) is not the commit its run ended on (${local ?? 'unread'}): no reviewed commit`);
      return undefined;
    } catch (err) {
      this.log('warn', `head of ${t.ticketId}'s PR unread at Human Review: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * The draft goes to its human reviewer with the ticket: GitHub merges no draft. Best effort: a human can do it, and until then the merge
   * refused says why. No PR, nothing to do.
   */
  private async prReady(project: ProjectRuntime, t: TicketState): Promise<void> {
    if (t.prNumber === undefined || t.prState !== 'OPEN' || !this.d.forgeWriter) return;
    await this.d.forgeWriter.markPrReady(project.github, t.prNumber).catch((err: Error) => this.log('warn', `PR #${t.prNumber} of ${t.ticketId} still a draft: ${err.message}`));
  }

  /**
   * The PR's `revue:` label (ORC-198), as the ticket goes to Human Review: from the class of the commit shown (unknown, a class
   * read of another commit), the AI review's blocking findings on it, and the draw. Best effort, as `prReady`: it tells the
   * reviewer where to look, and every PR goes through Human Review whatever it says. A final state: a replay writes nothing.
   */
  private async labelReview(project: ProjectRuntime, t: TicketState): Promise<void> {
    if (t.prNumber === undefined || t.prState !== 'OPEN' || !this.d.forgeWriter) return;
    const sha = t.reviewSha ?? t.verifiedSha;
    try {
      const blocking = sha ? blockingFindings(await this.d.store.findingsOf(project.id, t.ticketId, sha)).length : 0;
      const label = reviewLabel({ diffClass: sha === t.verifiedSha ? t.diffClass?.class : undefined, blocking, ticketId: t.ticketId });
      await this.d.forgeWriter.setExclusiveLabel(project.github, t.prNumber, label, REVIEW_LABELS);
    } catch (err) {
      this.log('warn', `review label of PR #${t.prNumber} of ${t.ticketId} not set: ${(err as Error).message}`);
    }
  }

  /**
   * The `publish` effect (ORC-125): the commit `verify` found green, out to the forge by the factory. A ticket that let go of the
   * attempt meanwhile (a stop) publishes nothing. Its result comes back through the inbox, keyed by the effect: `pr.opened` under the id
   * the webhook gives it, so that the first of the two counts, then `publish.done`. A refusal is decided once, as the merge's: its mark makes
   * a replay send the same one again instead of reading a forge that changed. Anything else throws, and the outbox retries it:
   * a push already made is found by the publisher, and the PR by its branch.
   */
  private async publish(project: ProjectRuntime, t: TicketState, c: Extract<Effect, { kind: 'publish' }>, key: EffectKey): Promise<void> {
    if (t.verifyingRunId !== c.runId) {
      this.log('info', `publish of ${t.ticketId} dropped: the ticket let go of run ${c.runId}`);
      return;
    }
    const mark = `effect:${key.id}:refused`;
    // The head the push went over (ORC-438), kept by the effect's key: a replay finds its commit pushed, and nothing under it.
    const beforeMark = `effect:${key.id}:before`;
    const payload = { runId: c.runId, job: c.job, sha: c.sha };
    const base = { ...TRUSTED, projectId: project.id, ticketId: t.ticketId };
    const refuse = async (reason: string) => void (await this.accept({ ...base, id: `publish-refused:${key.id}`, type: 'publish.refused', at: this.d.clock.now(), payload: { ...payload, reason } }));
    const published = async (empty = false, before?: string) => void (await this.accept({ ...base, id: `publish-done:${key.id}`, type: 'publish.done', at: this.d.clock.now(), payload: { ...payload, ...(c.output ? { output: c.output } : {}), ...(empty ? { empty: true as const } : {}), ...(before ? { before } : {}) } }));
    const known = key.replay ? await this.d.store.getMeta(mark) : undefined;
    if (known) return refuse(known);
    let reason: string;
    const { publisher } = this.d;
    const unverified = this.publishRefusal(project, t, c.sha);
    if (unverified) reason = unverified;
    else if (!publisher) reason = "the factory publishes through a GitHub App from its sandboxes, and this instance has none (docs/github.md).";
    else if (!t.branch || !t.worktreePath) reason = `no branch or no worktree for ${t.ticketId}.`;
    else {
      try {
        // A rebase may replace what the factory published last on the branch, and nothing else (ORC-146).
        const [untrustedMark, rewrites] = await Promise.all([this.untrustedMark(project, t), c.rewrite ? this.lastPublished(project.id, t.ticketId) : undefined]);
        const untrusted = untrustedMark ? { untrusted: untrustedMark } : {};
        // An open PR keeps its description (`ensurePr` finds it): a fixed body, the same for each fix (one scan), so a text never shown cannot hold one back.
        const open = t.prNumber !== undefined && t.prState === 'OPEN';
        const described = describePr(c.output, { ...publishFacts(t, c), ...(open ? {} : await this.hostCaptures(project, t, c)) });
        const text = await this.policy.pr(open ? { title: described.title, body: `Ticket: ${t.ticketId}` } : described);
        const pr = await publisher.publish({ projectId: project.id, github: project.github, ticketId: t.ticketId, runId: c.runId, worktree: t.worktreePath, branch: t.branch, sha: c.sha, ...untrusted, ...(rewrites ? { rewrites } : {}), ...text });
        if (pr.before) await this.d.store.setMeta(beforeMark, pr.before);
        const before = pr.before ?? (key.replay ? await this.d.store.getMeta(beforeMark) : undefined);
        await this.accept({ ...base, id: prEventId(t.ticketId, pr.prNumber, 'opened'), type: 'pr.opened', at: this.d.clock.now(), payload: { number: pr.prNumber, url: pr.url, branch: t.branch } });
        await this.publishChecks(project, t, c);
        return published(false, before);
      } catch (err) {
        if (err instanceof OutputRefused) reason = `the PR's text does not pass the output policy: ${err.refusals.map((r) => r.detail).join('; ')}.`;
        else if (err instanceof PublishRefused) {
          // A run that committed nothing has nothing to show: it ends as it would have, without a PR.
          if (err.code === 'empty') return published(true);
          reason = err.message;
        } else throw err;
      }
    }
    await this.d.store.setMeta(mark, reason);
    await refuse(reason);
  }

  /**
   * The dashboard's take-over (ORC-234), only with sandboxes: the command of a shell in the ticket's container, and the
   * bundles handed back, kept under the runs' dir and purged with it.
   */
  takeOverDesk(): TakeOverDesk | undefined {
    const { sandboxes, runsDir } = this.d;
    if (!sandboxes || !runsDir) return undefined;
    return {
      attach: async (projectId, ticketId) => {
        const key = takeOverKey(projectId, ticketId);
        // Taken back, as an attempt is: after a restart its container is alive but not this process's yet.
        const box = await sandboxes.reattach(key);
        if (!box) return undefined;
        this.log('info', `take-over of ${ticketId}: the command of a shell in its container ${box.id} given to the dashboard`);
        return sandboxes.spawnCommand(box.id, ['sh', '-i'], { cwd: WORKSPACE_TARGET });
      },
      keepBundle: async (projectId, ticketId, bytes) => {
        const dir = join(runsDir, bundleKey(projectId, ticketId));
        await mkdir(dir, { recursive: true });
        const file = join(dir, `${this.newId()}.bundle`);
        await writeFile(file, bytes);
        return file;
      },
    };
  }

  /**
   * A container of its own for the human who took `runId` over (ORC-234): on the ticket's worktree, no network, nothing else
   * mounted (no Claude session, no pack, no secret), never a shell on the host. Opened once the agent's run has ended and its
   * sandbox is gone: the human and the agent never write the worktree together. Without sandboxes, nothing opens.
   */
  private async openTakeOver(t: TicketState, runId: string): Promise<void> {
    const { sandboxes } = this.d;
    if (!sandboxes) return this.log('error', `take-over of ${t.ticketId} not opened: it needs sandboxes (FACTORY_CONTAINER_CLI), never a shell on the host`);
    if (!isTakenOver(t) || !t.worktreePath) return this.log('info', `take-over of ${t.ticketId} not opened: ${t.worktreePath ? 'the ticket left it' : 'no worktree'}`);
    await Promise.all([...this.background].filter(([, id]) => id === runId).map(([p]) => p));
    if (await sandboxes.findByAttempt(runId)) throw new Error(`take-over of ${t.ticketId}: the sandbox of run ${runId} is still alive`);
    const box = await sandboxes.create({ runId: takeOverKey(t.projectId, t.ticketId), ticketId: t.ticketId, workspacePath: t.worktreePath, network: 'none', requirements: DEFAULT_REQUIREMENTS, mounts: [] });
    this.log('info', `take-over of ${t.ticketId}: container ${box.id} open on its worktree, without network nor secret`);
  }

  /** The ticket's take-over container closed, if one is alive (ORC-234): found by its label, even one a restart left unusable. */
  private async closeTakeOver(projectId: string, ticketId: string): Promise<void> {
    const sandboxes = this.d.sandboxes;
    if (!sandboxes) return;
    const key = takeOverKey(projectId, ticketId);
    for (const { runId, sandbox } of await sandboxes.list()) {
      if (runId !== key) continue;
      await this.destroySandbox(sandbox.id, key);
      this.log('info', `take-over of ${ticketId}: container ${sandbox.id} closed`);
    }
  }

  /**
   * A bundle handed back after a take-over (ORC-234), checked and pushed by the publisher (`publishBundle`). Pushed, the
   * take-over ends and the push is the human's (`push.human`, under the id GitHub's would have, which the factory's App never
   * sends): `verify` checks it as any human's (ORC-159). Refused, nothing is on the forge, and the human is told.
   */
  private async publishBundle(project: ProjectRuntime, t: TicketState, c: Extract<Effect, { kind: 'publish_bundle' }>, key: EffectKey): Promise<void> {
    try {
      await this.checkBundle(project, t, c, key);
    } finally {
      // Read once, whatever came of it.
      await rm(c.file, { force: true });
    }
  }

  private async checkBundle(project: ProjectRuntime, t: TicketState, c: Extract<Effect, { kind: 'publish_bundle' }>, key: EffectKey): Promise<void> {
    if (!isTakenOver(t)) return this.log('info', `bundle of ${t.ticketId} dropped: the ticket is no longer taken over`);
    const mark = `effect:${key.id}:refused`;
    const refuse = async (reason: string) =>
      void (await this.accept({ ...TRUSTED, projectId: project.id, ticketId: t.ticketId, id: `bundle-refused:${key.id}`, type: 'bundle.refused', at: this.d.clock.now(), payload: { file: c.file, reason } }));
    const known = key.replay ? await this.d.store.getMeta(mark) : undefined;
    if (known) return refuse(known);
    let reason: string;
    const { publisher } = this.d;
    if (!publisher?.publishBundle) reason = 'the factory pushes through a GitHub App from its sandboxes, and this instance has none (docs/github.md).';
    else if (!t.branch) reason = `no branch for ${t.ticketId}.`;
    else {
      try {
        const pushed = await publisher.publishBundle({ projectId: project.id, github: project.github, ticketId: t.ticketId, runId: bundleKey(project.id, t.ticketId), branch: t.branch, bundle: c.file });
        await this.closeTakeOver(project.id, t.ticketId);
        const payload = { branch: t.branch, sha: pushed.sha, author: c.by, ...(pushed.before ? { before: pushed.before } : {}) };
        await this.accept({ schemaVersion: SCHEMA_VERSION, taint: 'untrusted', projectId: project.id, ticketId: t.ticketId, id: pushEventId(t.ticketId, pushed.sha), type: 'push.human', at: this.d.clock.now(), payload });
        return;
      } catch (err) {
        if (!(err instanceof PublishRefused)) throw err;
        reason = err.message;
      }
    }
    await this.d.store.setMeta(mark, reason);
    await refuse(reason);
  }

  /**
   * The head the factory published last on the ticket's branch (ORC-146), read from its journal: the sha of its last
   * `publish.done` that pushed something, which is journaled once the push is on the forge; an `empty` one pushed nothing
   * (ORC-402). The one head a rebase may replace.
   */
  private async lastPublished(projectId: string, ticketId: string): Promise<string | undefined> {
    return lastPushed((await this.d.store.ticketJournal(projectId, ticketId)).map((j) => upcast(j.event)))?.sha;
  }

  /**
   * The checks `verify` found green, on the commit just pushed (ORC-151): only a pushed commit can carry one, so a red
   * verdict, never pushed, has none. Keyed by the sha and the check: a replay, or a second publication of the same commit,
   * updates them, never doubles them. Best effort, as `prReady`: the PR is out, and a check that fails to go out blocks nothing.
   */
  private async publishChecks(project: ProjectRuntime, t: TicketState, c: Extract<Effect, { kind: 'publish' }>): Promise<void> {
    const writer = this.d.forgeWriter;
    if (!writer) return;
    const { sha, commands } = c;
    const frozen = Object.keys(t.frozenTests?.files ?? {}).length;
    const checks = [
      { name: VERIFY_CHECK, ...verifySummary(sha, commands) },
      { name: FREEZE_CHECK, conclusion: frozen ? 'success' : 'neutral', summary: frozen ? `${frozen} frozen file(s) intact.` : 'No frozen test for this ticket.' },
      { name: ANTI_CHEAT_CHECK, conclusion: 'success', summary: ANTI_CHEAT_OK },
      ...(c.visualProof ? [{ name: VISUAL_PROOF_CHECK, ...visualCheck(c.visualProof) }] : []),
      ...(c.quality ? [{ name: DIFF_QUALITY_CHECK, ...diffQualityCheck(c.quality) }] : []),
    ] as const;
    await Promise.all(
      checks.map(({ name, conclusion, summary }) =>
        writer.upsertCheckRun(project.github, { sha, name, externalId: `${name}@${sha}`, status: 'completed', conclusion, summary }).catch((err: Error & { status?: number }) => {
          const hint = checksPermission(err);
          this.log('warn', `check ${name} of ${t.ticketId} not published on ${sha.slice(0, 12)}${hint}: ${err.message}`);
        }),
      ),
    );
  }

  /**
   * The `review` effect (ORC-183): a lens's findings kept on the commit it read, in place of what that lens kept there before.
   * The publishing one then posts every lens's findings on that commit as one GitHub review, each on its line, or listed in its
   * text when GitHub cannot place one, and `factory/review`, failed on a blocking finding. Every text through the
   * `OutputPolicy`, a refused one replaced by its notice. Keyed: a replay finds its review by the effect's id, and the check by
   * the commit's. Any failure throws, and the outbox retries it: its move to Human Review waits behind it, and a dead one blocks the ticket.
   */
  private async review(project: ProjectRuntime, t: TicketState, c: Extract<Effect, { kind: 'review' }>, key: EffectKey): Promise<EffectOutcome | void> {
    const { store, clock } = this.d;
    await store.putFindings({ projectId: project.id, ticketId: t.ticketId, sha: c.sha, lens: c.lens, runId: c.runId, at: clock.now(), findings: c.findings });
    if (!c.publish) return;
    const writer = this.d.forgeWriter;
    if (!writer || t.prNumber === undefined) {
      this.log('warn', `AI review of ${t.ticketId} on ${c.sha.slice(0, 12)} not published: ${writer ? 'the ticket has no PR' : 'this instance has no GitHub App (docs/github.md)'}`);
      return;
    }
    const findings = await store.findingsOf(project.id, t.ticketId, c.sha);
    const placed = findings.filter(onItsLine);
    const verdict = reviewVerdict(findings);
    const [body, summary, ...texts] = await this.policy.comments([reviewBody(c.sha, findings, { inline: true }), `${verdict.summary}.`, ...placed.map(inlineComment)]);
    const post = (review: { body: string; comments: { path: string; line: number; body: string }[] }) => writer.postReview(project.github, t.prNumber!, { sha: c.sha, ...review, externalId: `review:${key.id}` });
    const posted = await post({ body: body!, comments: placed.map((f, i) => ({ path: f.file, line: f.line, body: texts[i]! })) }).catch(async (err: unknown) => {
      if (!(err instanceof ReviewLinesRefused)) throw err;
      this.log('info', `AI review of ${t.ticketId}: a finding is on a line the PR does not show, all listed in the review's text`);
      return post({ body: await this.policy.comment(reviewBody(c.sha, findings, { inline: false })), comments: [] });
    });
    await writer
      .upsertCheckRun(project.github, { sha: c.sha, name: REVIEW_CHECK, externalId: `${REVIEW_CHECK}@${c.sha}`, status: 'completed', conclusion: verdict.conclusion, title: verdict.summary, summary: summary! })
      .catch((err: Error & { status?: number }) => {
        err.message += checksPermission(err);
        throw err;
      });
    return posted.deduplicated ? { deduplicated: true } : undefined;
  }

  /**
   * The `merge` effect (ORC-148). The forge is read first, as only it knows the checks of the reviewed commit: the
   * PR still open, its head still that commit, its checks green. Then merged with that head imposed, so a push in
   * between is refused by GitHub itself. A refusal reaches the human through `pr.merge_refused`, and is decided once:
   * its mark, written before the event, makes a replay (a lost lease, a failed inbox write) send the same refusal
   * again (the inbox drops the copy by its id) instead of reading the forge anew, where checks green since would merge.
   */
  private async merge(project: ProjectRuntime, t: TicketState, sha: string, key: EffectKey): Promise<EffectOutcome | void> {
    if (t.prNumber === undefined) return;
    const mark = `effect:${key.id}:refused`;
    const saved = key.replay ? await this.d.store.getMeta(mark) : undefined;
    if (saved) return this.refuseMerge(project, t, key, upcastMergeRefusal(saved));
    const writer = this.d.forgeWriter;
    const pr = t.branch ? await this.d.forge.findPr(project.github, t.branch) : undefined;
    let reason: string;
    // Said by the forge (`head_moved`) or seen here, never read back from the sentence (ORC-345).
    let headMoved = false;
    if (pr?.number === t.prNumber && pr.state === 'MERGED') {
      if (pr.headSha === sha) return { deduplicated: true };
      // Merged on GitHub meanwhile, on another head: no refusal to answer, the merge's own events deliver the ticket.
      this.log('info', `merge of ${t.ticketId} dropped: PR #${pr.number} already merged on ${pr.headSha}`);
      return;
    }
    if (!t.branch) reason = 'the ticket\'s branch is unknown';
    else if (pr && pr.number !== t.prNumber) reason = `the branch's PR (#${pr.number}) is not the ticket's (#${t.prNumber})`;
    else if (!writer) reason = "the factory's GitHub App is required to merge";
    else if (pr?.state !== 'OPEN') reason = 'the PR is no longer open';
    else if (pr.headSha !== sha) {
      reason = MERGE_PUSHED;
      headMoved = true;
    }
    else if (pr.checks !== 'pass' && pr.checks !== 'none') {
      // A check in a state the forge does not know is named: a bare `pending` reads as a CI still running (ORC-304).
      const unknown = pr.unknownChecks?.length ? `; in a state the forge does not know: ${pr.unknownChecks.join(', ')}` : '';
      reason = `the checks of the reviewed commit are not green (${pr.failedChecks.join(', ') || pr.checks}${unknown})`;
    }
    else {
      // No check at all: the forge merges only in a repository with no CI (`mergePr`, `unchecked`).
      // GitHub merges no draft: a Done is a merge decision, whatever became of the move's best effort (`prReady`).
      await writer.markPrReady(project.github, t.prNumber);
      const res: MergeResult = await writer.mergePr(project.github, t.prNumber, sha, pr.checks === 'none' ? { unchecked: true } : undefined);
      if (res.merged) return res.deduplicated ? { deduplicated: true } : undefined;
      headMoved = res.reason === 'head_moved';
      reason = res.reason === 'head_moved'
        ? MERGE_PUSHED
        : res.reason === 'checks_missing'
          ? 'no check ran on the reviewed commit, while the repository has a CI or the factory cannot check that it has none (CI not started yet, checks just appearing, or a GitHub App without the Actions read permission)'
          : `GitHub refuses the merge (${res.message})`;
    }
    const refusal: MergeRefusal = { reason, headMoved };
    await this.d.store.setMeta(mark, JSON.stringify(refusal));
    await this.refuseMerge(project, t, key, refusal);
  }

  /** The `pr.merge_refused` of a merge effect, keyed by it. A failed write throws, so that the outbox retries the effect. */
  private async refuseMerge(project: ProjectRuntime, t: TicketState, key: EffectKey, { reason, headMoved }: MergeRefusal): Promise<void> {
    await this.accept({
      ...TRUSTED,
      id: `merge-refused:${key.id}`,
      type: 'pr.merge_refused',
      at: this.d.clock.now(),
      projectId: project.id,
      ticketId: t.ticketId,
      payload: { number: t.prNumber!, url: t.prUrl ?? '', branch: t.branch ?? '', reason, headMoved },
    });
  }
}
