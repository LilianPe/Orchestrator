import { z } from 'zod';
import type { Condition } from '../core/conditions.js';
import type { EventType, InputKind, LogicalState, QueueName } from '../core/types.js';

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

const rawLimits = z.object({ turns: z.number().int().positive(), duration, usd: z.number().positive() }).partial();

export const rawJobSchema = z
  .object({
    extends: z.string().optional(),
    queue: z.enum(['dev', 'questions']).optional(),
    model: z.string().optional(),
    workspace: z.enum(['worktree', 'trunk-readonly', 'knowledge']).optional(),
    session: z.enum(['new', 'resume']).optional(),
    skill: z.string().optional(),
    input: z.enum(['feedback', 'ci_failures', 'thread', 'verify_failures']).optional(),
    verify: z.array(z.string()).optional(),
    pickup: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    limits: rawLimits.optional(),
    on_start: z.object({ move: logical.optional() }).strict().optional(),
    on_success: z
      .object({ move: logical.optional(), post: z.enum(['summary', 'reply', 'synthesis']).optional() })
      .strict()
      .optional(),
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
  usd: number;
}

export interface Limits {
  parallelSessions: number;
  questionSessions: number;
  perRun: RunLimits;
  verifyAttempts: number;
  /** Runs red CI may start before the next red CI blocks the ticket (I5, ORC-270); 0 blocks at the first. */
  ciFixAttempts: number;
  /**
   * Same failed commands on an unchanged worktree, N times in a row: blocked, cause « boucle » (ORC-187).
   * Absent from versions frozen before it, which keep deciding without it.
   */
  repeatedFailures?: number;
  reviewRounds: number;
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
  workspace: 'worktree' | 'trunk-readonly' | 'knowledge';
  session: 'new' | 'resume';
  skill: string;
  input?: InputKind;
  verify: string[];
  pickup: boolean;
  /**
   * The job's agent always calls `submit_result` (ORC-289): a success without output is a failure.
   * ponytail: provisional, off by default until ORC-191/ORC-192 rewrite the pack so every agent submits;
   * then the gate goes and `attempt` decides alone. Absent from versions frozen before it.
   */
  structuredOutput?: boolean;
  limits: RunLimits;
  onStart: { move?: LogicalState };
  onSuccess: { move?: LogicalState; post?: 'summary' | 'reply' | 'synthesis' };
}

export interface Workflow {
  version: 1;
  tracker: { kind: 'linear'; team?: string; pickup: { checks: PickupCheck[] } };
  /** `ready` (« Ready to Merge ») is gone from the pack (ORC-170): optional, for the versions frozen with it. */
  states: Record<Exclude<LogicalState, 'ready'>, string> & { ready?: string };
  limits: Limits;
  workspace: { setup: string[]; portBase: number };
  commands: string[];
  on: Partial<Record<EventType, Rule[]>>;
  jobs: Record<string, JobSpec>;
}
