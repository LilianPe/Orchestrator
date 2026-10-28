import type { RunLimits } from '../../config/workflow-schema.js';
import type { TokenUsage } from '../../core/measures.js';
import type { RunOutcome } from '../../core/types.js';

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
  claudeSessionId: string;
  resume: boolean;
  model: string;
  pluginDir: string;
  settingsPath: string;
  readOnly: boolean;
  limits: RunLimits;
  env: Record<string, string>;
  /**
   * Paths the run must not write: set when it reads untrusted content (I12, ORC-274). Carried, not
   * enforced yet: `ClaudeCodeRunner` ignores it until the runner's sandbox does (ORC-151, ORC-204).
   */
  sensitivePaths?: readonly string[];
}

export interface RunResult {
  outcome: RunOutcome;
  costUsd: number;
  turns: number;
  lastText: string;
  /** What the runtime reported it used (ORC-235), never what the agent wrote; absent when it reported nothing. */
  tokens?: TokenUsage;
}

export interface RunHandle {
  readonly events: AsyncIterable<RunStreamEvent>;
  readonly done: Promise<RunResult>;
  stop(): void;
}

export interface Runner {
  start(req: RunRequest): RunHandle;
}
