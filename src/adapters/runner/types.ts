import type { RunLimits } from '../../config/workflow-schema.js';
import type { RunOutcome } from '../../core/types.js';

export type RunStreamEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string }
  | { kind: 'tool_result'; isError: boolean }
  | { kind: 'result'; isError: boolean; costUsd: number; turns: number; text: string };

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
}

export interface RunResult {
  outcome: RunOutcome;
  costUsd: number;
  turns: number;
  lastText: string;
}

export interface RunHandle {
  readonly events: AsyncIterable<RunStreamEvent>;
  readonly done: Promise<RunResult>;
  stop(): void;
}

export interface Runner {
  start(req: RunRequest): RunHandle;
}
