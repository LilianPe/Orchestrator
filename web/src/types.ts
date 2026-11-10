import type { BlockCause, BlockKind, ParetoCause } from '../../src/core/block-cause.js';
import type { MissRate } from '../../src/core/serious-defect.js';

export interface RunView {
  id: string;
  ticketId: string;
  job: string;
  startedAt: number;
  turns: number;
  costUsd: number;
}

export interface QueueView {
  ticketId: string;
  job: string;
  queue: 'dev' | 'questions';
}

export interface Snapshot {
  paused: boolean;
  /** Until when (ms) the Claude account's usage limit holds every launch (ORC-340); null when it holds none. Absent from an older server. */
  usageLimitedUntil?: number | null;
  linearConnected: boolean;
  queue: QueueView[];
  activeRuns: RunView[];
  capacity: { dev: { used: number; total: number }; questions: { used: number; total: number } };
}

export interface FlowTicketView {
  projectId: string;
  ticketId: string;
  title: string;
  prUrl?: string;
}

export interface WorkingRunView extends FlowTicketView, Pick<TicketMeasuresView, 'tokens' | 'attemptsWithoutTokens' | 'usageLimitShare'> {
  runId: string;
  step: string;
  verifying: boolean;
  stoppable: boolean;
  durationMs: number;
  measured: boolean;
  costUsd: number;
}

/** `GET /api/flow`: `Flow` of src/server/flow.ts, which the web's types cannot import (it reaches Node's). */
export interface FlowView {
  needsYou: {
    blocked: { cause: BlockCause; tickets: (FlowTicketView & { kind: BlockKind; reason: string })[] }[];
    humanReview: FlowTicketView[];
    gates: FlowTicketView[];
  };
  working: WorkingRunView[];
  queued: { ticketId: string; job: string }[];
  done: FlowTicketView[];
  others: FlowTicketView[];
}

export type RunLine =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string }
  | { kind: 'tool_result'; isError: boolean }
  | { kind: 'result'; isError: boolean; costUsd: number; turns: number; text: string };

/** A line of a run's live feed (ORC-301): what it does in the factory's words, or an event of its ticket's journal. */
export type FeedLine =
  | { kind: 'activity'; runId: string; action: string; parameter: string; at: number }
  | { kind: 'event'; id: string; type: string; at: number };

export interface EventView {
  id: string;
  type: string;
  at: number;
  projectId: string;
  ticketId?: string;
  payload: unknown;
}

export type BusMessage =
  | { kind: 'event'; event: EventView }
  | { kind: 'command'; projectId: string; ticketId?: string; command: { kind: string } }
  | { kind: 'run'; runId: string; ticketId: string; ev: RunLine }
  | { kind: 'activity'; projectId: string; runId: string; ticketId: string; activity: { type: 'action'; action: string; parameter: string; ephemeral?: boolean }; at: number }
  | { kind: 'ticket' }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number };

export type TokensView = { input: number; output: number; cacheRead: number; cacheCreation: number };

/** One attempt of a ticket: `RunMeasure` of src/core/measures.ts (ORC-223). */
export interface RunMeasureView {
  id: string;
  job: string;
  role: 'implementer' | 'reviewer' | 'answerer' | null;
  status: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  tokens: TokensView | null;
  costUsd: number;
  turns: number;
}

/** The part of `TicketMeasures` of src/core/measures.ts the dashboard reads (ORC-223). */
export interface TicketMeasuresView {
  mergedAt: number | null;
  tokens: TokensView | null;
  attempts: number;
  attemptsWithoutTokens: number;
  usageLimitShare: number | null;
  firstTry: boolean | null;
  reworks: { cause: string; id: string }[];
  revertedWithin14Days: boolean | null;
  ciCost: { durationMs: number; runs: number } | null;
  messages: { eventId: string; type: string; kind: string; at: number; signOfLifeMs: number | null; answerMs: number | null }[];
  startedAt: number | null;
  leadTimeMs: number | null;
  workMs: number;
  costUsd: number;
  reviewRounds: { ai: number; human: number };
  runs: RunMeasureView[];
}

/** An entry of `GET /api/measures`; `measures` null when they could not be read. */
export interface MeasuredTicketView extends FlowTicketView {
  logical: string;
  blocked: boolean;
  /** Of a blocked ticket, from its typed kind as the Flow classes it (ORC-345); null when not blocked. */
  blockCause: BlockCause | null;
  measures: TicketMeasuresView | null;
}

/** Why a merged ticket was not ready at the first try: `Rework['cause']` of src/core/measures.ts. */
export type ReworkCause = 'pr.checks_failed' | 'verify.failed' | 'push.human' | 'feedback' | 'sent_back' | 'changes_requested';

/** One measure of the baseline: `BaselineValue` of src/core/baseline.ts. */
export interface BaselineValueView {
  value: number | null;
  over: number;
  leftOut: number;
  noSource: boolean;
}

/** The 90-day baseline (ORC-230), a measure without a row left out of `measures`. */
export interface BaselineView {
  projectId: string;
  since: number;
  until: number;
  computedAt: number;
  measures: Partial<Record<'delivered' | 'lead_time' | 'tokens_per_merged' | 'first_try', BaselineValueView>>;
}

/** `GET /api/overview` (ORC-299): `Overview` of src/core/overview.ts over `[since, until)`. */
export interface OverviewView {
  since: number;
  until: number;
  unmeasured: number;
  delivered: number;
  medianLeadTimeMs: number | null;
  tokensPerMerged: { mean: number | null; leftOut: number };
  usageLimitShare: { mean: number | null; leftOut: number };
  firstTry: { yes: number; of: number; reworks: { cause: ReworkCause; tickets: number }[] };
  reverted: { yes: number; known: number };
  ciPerMerged: { mean: number | null; leftOut: number };
  red: { verified: number; wouldHaveBlocked: number };
  messages: { count: number; medianSignOfLifeMs: number | null; withoutSignOfLife: number; questions: number; medianAnswerMs: number | null; unanswered: number };
  /** The 90-day baseline the measures face (ORC-230): `Baseline` of src/core/baseline.ts, null until `factory baseline` computes one. */
  baseline: BaselineView | null;
  /** The AI reviewers' miss rate (ORC-229): `MissRate` of src/core/audit.ts; not counted while no definition of a serious defect is set. Absent from an older server. */
  aiReviewMisses?: MissRateView;
}

/** `MissRate` of src/core/serious-defect.ts (ORC-229). */
export type MissRateView = MissRate;

/** `ReviewDefect` of src/core/audit.ts (ORC-229): a defect a human found in review, linked to an AI finding or not. */
export interface ReviewDefectView {
  id: string;
  projectId: string;
  ticketId: string;
  prNumber: number;
  description: string;
  findingId: string | null;
  file?: string;
  line?: number;
  definition: string | null;
  enteredBy: string;
  at: number;
}

/** What the dashboard sends to enter a defect: the body of `POST /api/audit/:projectId/:ticketId/defects`. */
export interface DefectEntry {
  prNumber: number;
  description: string;
  findingId?: string;
  file?: string;
  line?: number;
}

/** `GET /api/audit` (ORC-229): the PRs a human reviewed among the tickets updated last. */
export interface AuditListView {
  sheets: (FlowTicketView & { logical: string; mergedAt: number | null })[];
}

/** `GET /api/audit/:projectId/:ticketId` (ORC-229): `AuditSheet` of src/core/audit.ts, and the definition of a serious defect in force. */
export interface AuditSheetView {
  projectId: string;
  ticketId: string;
  definition: string | null;
  task: { title: string; spec: { goal?: string; criteria?: string[]; out_of_scope?: string[] } | null };
  path: {
    steps: RunDetailView['steps'];
    attempts: RunMeasureView[];
    checks: RunDetailView['checks'];
    findings: { id: string; sha: string; at: number; lens: string; runId: string; file: string; line: number; severity: string; explanation: string; suggestion: string }[];
  };
  result: {
    prs: { number: number; url: string; state: 'open' | 'merged' | 'closed'; mergedAt: number | null }[];
    reviews: { id: string; at: number; author: string; pr: number; kind: 'review' | 'comment'; state: string | null }[];
    firstTry: boolean | null;
    reworks: { cause: ReworkCause; id: string }[];
    revertedWithin14Days: boolean | null;
  };
  defects: ReviewDefectView[];
}

/** `GET /api/security` (ORC-300): `SecurityStats` of src/store/types.ts over `[since, until)`, hosts not a plain name merged. */
export interface SecurityPeriodView {
  since: number;
  until: number;
  hosts: { host: string; requests: number; refused: number }[];
  rules: { rule: string; refusals: number }[];
  /** The most refused runs, 50 at most: `runsLeftOut` counts the others. */
  runs: { runId: string; projectId: string; ticketId: string; requests: number; refused: number; refusals: number }[];
  runsLeftOut: number;
}

/** `GET /api/security/runs/:id` (ORC-300): `RunSecurityView` of src/network/security-log.ts, never a command nor a path. */
export interface RunSecurityView {
  runId: string;
  projectId: string;
  ticketId: string;
  at: number;
  rules: { rule: string; refusals: number }[];
  refusals: { at: number; tool: string; rule: string }[];
  hosts: { host: string; requests: number; refused: number }[];
  skipped: { egress: number; refusals: number };
}

/** `GET /api/blocks` (ORC-300): the moves into Blocked of `[since, until)`, their causes most frequent first. */
export interface BlockParetoView {
  since: number;
  until: number;
  total: number;
  causes: ParetoCause[];
}

/**
 * `GET /api/runs/:id` (ORC-298): `RunDetail` of src/core/run-detail.ts and the run's transcript, as the server reads them.
 * Its `output` is what the agent handed back through `submit_result`, as the factory validated it.
 */
export interface RunDetailView {
  run: RunMeasureView & { projectId: string; ticketId: string; queue: string; outcome: string | null; infra: boolean; labels: Record<string, unknown> | null };
  timeline: { id: string; type: string; at: number; ofRun: boolean; what: string }[];
  decisions: { id: string; type: string; at: number; channel: 'linear' | 'github' | 'dashboard' | 'cli'; who: string | null; what: string }[];
  gates: { gate: string; openedAt: number; closedAt: number | null; to: string | null; closedBy: string | null }[];
  findings: (
    | { source: 'human'; id: string; at: number; author: string; pr: number; kind: 'review' | 'comment'; state: string | null }
    | { source: 'ai'; runId: string; at: number; job: string; status: string; outcome: string | null; findings: { file: string; line: number; severity: string; explanation: string; suggestion: string }[] }
  )[];
  checks: { id: string; at: number; check: 'verify' | 'red' | 'ci'; result: 'passed' | 'failed' | 'errored'; runId: string | null; job: string | null; names: string[]; red: string | null }[];
  steps: { job: string; attempts: number; tokens: TokensView | null; attemptsWithoutTokens: number; turns: number; workMs: number; costUsd: number }[];
  attempts: RunMeasureView[];
  output: { status: string; summary: string; question?: string; tests_added: string[]; why: string; assumptions: string[]; risks: string[]; untested: string[]; review_hints: { file: string; reason: string }[] } | null;
  /** `purged`: past the 30 days transcripts are kept; `none`: no transcript recorded (a launch that failed, a run still to write one). */
  transcript: { status: 'kept'; lines: RunLine[] } | { status: 'purged' } | { status: 'none' };
}
