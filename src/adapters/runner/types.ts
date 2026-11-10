import type { RunLimits } from '../../config/workflow-schema.js';
import type { OverBudget, RunOutcome, Stagnation, TokenUsage } from '../../core/types.js';

/** The bounds of the stagnation detector (ORC-136), of the frozen workflow: absent, a version without them, nothing is watched. */
export interface StagnationBounds {
  /** Same command, same failure, same worktree: stopped at this many. */
  repeats?: number;
  /** Nothing written on the stream for this long: stopped. */
  silentMs?: number;
}

export type RunStreamEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string }
  | { kind: 'tool_result'; isError: boolean }
  /** `tokens`: the `usage` of the result line, absent when the CLI reported none (ORC-235). */
  | { kind: 'result'; isError: boolean; costUsd: number; turns: number; text: string; tokens?: TokenUsage };

export interface RunRequest {
  runId: string;
  cwd: string;
  prompt: string;
  /** Appended to the session's system prompt (`claude --append-system-prompt`): the knowledge index, as data (ORC-232). */
  systemPrompt?: string;
  claudeSessionId: string;
  resume: boolean;
  model: string;
  /** `claude --effort`, of the job's preset step (ORC-136). Absent: the CLI's default. */
  effort?: string;
  stagnation?: StagnationBounds;
  pluginDir: string;
  settingsPath: string;
  readOnly: boolean;
  /** The built-in tools the session has, all of them when absent (`claude --tools`): an AI review has `Read`, `Grep` and `Glob` only (ORC-183). */
  tools?: readonly string[];
  limits: RunLimits;
  env: Record<string, string>;
  /**
   * Paths the run must not write: set when it reads untrusted content (I12, ORC-274). The runner
   * does not enforce it: it marks the ticket's branch untrusted (`TicketState.untrustedSince`, ORC-338), and `checkClone` refuses what
   * the branch then commits in the repository's `sensitive_paths`.
   */
  sensitivePaths?: readonly string[];
  /**
   * The sandbox the run executes in (ORC-204): `claude` runs there through `SandboxProvider.spawnCommand`,
   * and `cwd`, `pluginDir` and `settingsPath` are paths in the sandbox. Absent: on the host (fake runner, tests).
   */
  sandboxId?: string;
}

export interface RunResult {
  outcome: RunOutcome;
  costUsd: number;
  turns: number;
  lastText: string;
  /** What the runtime reported it used (ORC-235), never what the agent wrote; absent when it reported nothing. */
  tokens?: TokenUsage;
  /** The runner or its sandbox broke (refused before the spawn, spawn error): nothing for the agent to fix (ORC-289). */
  infra?: true;
  /** What stopped it, when the detector did (ORC-136): `outcome` is then `limit`. */
  stagnation?: Stagnation;
  /** The subscription's usage limit stopped it (ORC-340); `resetAt` (ms) when the CLI told it. */
  usageLimit?: { resetAt?: number };
  /** The cap of its budget that stopped it (ORC-216): `outcome` is then `limit`. Absent for its duration cap and the detector. */
  overBudget?: OverBudget;
}

export interface RunHandle {
  readonly events: AsyncIterable<RunStreamEvent>;
  readonly done: Promise<RunResult>;
  stop(): void;
  /**
   * Lets go of the attempt without stopping it, at a clean shutdown (ORC-344): its events end, `done` never settles,
   * and the attempt goes on for the next daemon to `attach`. Absent: the handle is just no longer read.
   */
  detach?(): void;
}

/** What the supervisor knows of an attempt started by an earlier process (ORC-220). */
export interface AttachRequest {
  runId: string;
  limits: RunLimits;
  /** Prices the attempt if it ended without a result line (ORC-340). */
  model?: string;
  /** Spent already, against `limits.durationMs`. */
  elapsedMs: number;
  /** The run's environment: its secrets are masked as at the start. */
  env: Record<string, string>;
  /** Silence only is watched: the worktree of an attempt taken up is not read, its loops are left to its turns and its duration. */
  stagnation?: StagnationBounds;
}

export interface Runner {
  start(req: RunRequest): RunHandle;
  /**
   * Takes up an attempt started by an earlier process, a factory that was killed (ORC-220): the events from
   * now on, and its real result, even if it ended meanwhile. Undefined when nothing is left of it: the
   * supervisor then starts its step again. Absent: a runner that cannot.
   */
  attach?(req: AttachRequest): RunHandle | undefined;
}
