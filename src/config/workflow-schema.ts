import { z } from 'zod';
import type { Condition } from '../core/conditions.js';
import type { EventType, InputKind, LogicalState, QueueName } from '../core/types.js';
import type { NetworkLevel } from '../adapters/sandbox/types.js';
import type { Effort } from '../presets/preset.js';

const logical = z.enum(['todo', 'dev', 'human_review', 'ai_review', 'ready', 'done']);
const duration = z.union([z.string(), z.number()]);

export const rawRuleSchema = z
  .object({
    from: logical.optional(),
    to: logical.optional(),
    label: z.string().optional(),
    say: z.string().optional(),
    when: z.string().optional(),
    run: z.string().optional(),
    debounce: duration.optional(),
    move: logical.optional(),
    labels: z.object({ add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }).optional(),
    comment: z.string().optional(),
    do: z.enum(['stop', 'cleanup', 'propose_delegate']).optional(),
  })
  .strict();

// No `usd` (ORC-216): a budget counts tokens and turns, `budgets` of factory.yml.
const rawLimits = z.object({ turns: z.number().int().positive(), duration }).partial();

export const rawJobSchema = z
  .object({
    extends: z.string().optional(),
    step: z.string().optional(),
    queue: z.enum(['dev', 'questions']).optional(),
    model: z.string().optional(),
    workspace: z.enum(['worktree', 'trunk-readonly', 'knowledge', 'published']).optional(),
    session: z.enum(['new', 'resume']).optional(),
    skill: z.string().optional(),
    lens: z.enum(['correctness', 'security']).optional(),
    input: z.enum(['feedback', 'ci_failures', 'thread', 'verify_failures', 'findings']).optional(),
    verify: z.array(z.string()).optional(),
    pickup: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    repo_checks: z.boolean().optional(),
    verify_failure: z.literal('block').optional(),
    red: z.object({ command: z.string().min(1), mode: z.enum(['measure', 'blocking']) }).partial().strict().optional(),
    limits: rawLimits.optional(),
    on_start: z.object({ move: logical.optional() }).strict().optional(),
    on_success: z
      .object({ move: logical.optional(), post: z.enum(['summary', 'reply', 'synthesis', 'review']).optional(), run: z.string().optional() })
      .strict()
      .optional(),
    on_blocking: z.object({ run: z.string() }).strict().optional(),
  })
  .strict();

export const rawWorkflowSchema = z
  .object({
    version: z.literal(1),
    extends: z.string().optional(),
    tracker: z
      .object({
        kind: z.literal('linear').default('linear'),
        team: z.string().optional(),
        pickup: z
          .object({ checks: z.array(z.enum(['has_description', 'not_started', 'has_acceptance_criteria'])).optional() })
          .optional(),
      })
      .optional(),
    states: z
      .object({
        todo: z.string(),
        dev: z.string(),
        human_review: z.string(),
        ai_review: z.string(),
        ready: z.string(),
        done: z.string(),
      })
      .partial()
      .strict()
      .optional(),
    limits: z
      .object({
        parallel_sessions: z.number().int().positive(),
        question_sessions: z.number().int().positive(),
        per_run: rawLimits,
        verify_attempts: z.number().int().nonnegative(),
        ci_fix_attempts: z.number().int().nonnegative(),
        /** Read by nothing since ORC-183, accepted so a project file that still sets it loads. */
        review_rounds: z.number().int().positive(),
      })
      .partial()
      .optional(),
    workspace: z
      .object({ setup: z.array(z.string()), ports: z.object({ base: z.number().int().positive() }) })
      .partial()
      .optional(),
    on: z.record(z.string(), z.array(rawRuleSchema)).optional(),
    jobs: z.record(z.string(), rawJobSchema).optional(),
  })
  .strict();

export type RawWorkflow = z.infer<typeof rawWorkflowSchema>;
export type RawJob = z.infer<typeof rawJobSchema>;

export type PickupCheck = 'has_description' | 'not_started' | 'has_acceptance_criteria';

export interface RunLimits {
  turns: number;
  durationMs: number;
  /** Tokens of the attempt (`budgets.per_step_tokens`, ORC-136), cache reads left out: past it, a cap. Absent: no cap, the values are to calibrate (ORC-216). */
  tokens?: number;
}

export interface Limits {
  parallelSessions: number;
  questionSessions: number;
  perRun: RunLimits;
  verifyAttempts: number;
  /** Runs red CI and conflicts may start, together, before the next one blocks the ticket (I5, ORC-270, ORC-146); 0 blocks at the first. */
  ciFixAttempts: number;
  /**
   * Same failed commands on an unchanged worktree, N times in a row: blocked, cause « boucle » (ORC-187).
   * Absent from versions frozen before it, which keep deciding without it.
   */
  repeatedFailures?: number;
  /** An attempt that writes nothing for this long is stopped (ORC-136). Absent from versions frozen before it, which do not watch it. */
  silentAfterMs?: number;
}

export interface Rule {
  from?: LogicalState;
  to?: LogicalState;
  label?: string;
  say?: string;
  when?: Condition;
  whenSrc?: string;
  run?: string;
  debounceMs?: number;
  move?: LogicalState;
  labels?: { add: string[]; remove: string[] };
  comment?: string;
  do?: 'stop' | 'cleanup' | 'propose_delegate';
}

export interface JobSpec {
  name: string;
  queue: QueueName;
  model: string;
  /** The preset step the job runs (`step`, ORC-136), named by its block's comment (ORC-196). Absent from the jobs out of the preset and from versions frozen before it. */
  step?: string;
  /** `claude --effort`, of the preset step the job names (`step`, ORC-136). Absent from the jobs out of the preset and from versions frozen before it: the CLI's default. */
  effort?: Effort;
  /**
   * `published`: a fresh clone of the commit the factory published, detached, gone with the run (ORC-183): what an AI review
   * reads, never the agent's worktree. Only a job of the `review` step has it.
   */
  workspace: 'worktree' | 'trunk-readonly' | 'knowledge' | 'published';
  session: 'new' | 'resume';
  skill: string;
  /** The angle of an AI review job (ORC-183): correctness and the spec, or security and the tests. Only a job of the `review` step has one. */
  lens?: ReviewLens;
  /** The network level of the job's preset step (ORC-183), narrowed by the repository's at the launch. Absent from the jobs out of the preset. */
  network?: NetworkLevel;
  /**
   * The built-in tools of the job's preset step when the step is read-only (`stepTools`, ORC-367): `Read`, `Grep` and `Glob`,
   * refused anything else by the run itself, whatever its skill says. Absent: every tool.
   */
  tools?: readonly string[];
  input?: InputKind;
  verify: string[];
  /**
   * The job's commits go through `verify` whether or not it declares commands (ORC-151): the repository's, read on its
   * base branch, and the checks of the diff; and only a commit it found green may be merged. Absent from the jobs and versions without it.
   */
  repoChecks?: boolean;
  /** `block`: a failed `verify` blocks the ticket instead of sending the job back: the job did not write what it found (a review, on a human's push). */
  verifyFailure?: 'block';
  pickup: boolean;
  /**
   * The job's agent always calls `submit_result` (ORC-289): a success without output is a failure.
   * ponytail: provisional, off by default until ORC-191/ORC-192 rewrite the pack so every agent submits;
   * then the gate goes and `attempt` decides alone. Absent from versions frozen before it.
   */
  structuredOutput?: boolean;
  /**
   * The `red` factory check after the job (ORC-123) instead of `verify`: its added tests must fail for the right
   * reason. `measure` records what it would have blocked and goes on; `blocking` sends the job back, `attempts`
   * checks at most (the preset counter `red` + 1), then blocks; a check that could not run blocks in both. Absent from the jobs and versions without it.
   */
  red?: { command: string; mode: 'measure' | 'blocking'; attempts: number };
  limits: RunLimits;
  onStart: { move?: LogicalState };
  /** `run`: the job started once this one succeeded (ORC-123: `tests` then `dev`). */
  /** `post: review`: the findings of the ticket's AI review lenses, on the published commit, as a GitHub review and `factory/review` (ORC-183). */
  onSuccess: { move?: LogicalState; post?: 'summary' | 'reply' | 'synthesis' | 'review'; run?: string };
  /**
   * The lens that publishes the review (ORC-184): a blocking finding on the commit starts `run`, the fix of the review loop, in
   * place of `on_success`, on the counter of the review and CI loop; past it, the ticket is blocked. Absent from versions frozen
   * before it, whose review goes to Human Review whatever it found.
   */
  onBlocking?: { run: string };
}

export type ReviewLens = 'correctness' | 'security';

export interface Workflow {
  version: 1;
  /**
   * A block is told by the standard comment, a reply resumes its step, and a comment on the ticket is a reply (ORC-196).
   * Absent from versions frozen before it, whose tickets keep the free text of their session: a replay decides as they did.
   */
  blockComment?: true;
  tracker: { kind: 'linear'; team?: string; pickup: { checks: PickupCheck[] } };
  /** `ready` (« Ready to Merge ») is gone from the pack (ORC-170): optional, for the versions frozen with it. */
  states: Record<Exclude<LogicalState, 'ready'>, string> & { ready?: string };
  limits: Limits;
  workspace: { setup: string[]; portBase: number };
  commands: string[];
  on: Partial<Record<EventType, Rule[]>>;
  jobs: Record<string, JobSpec>;
}
