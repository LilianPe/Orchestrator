import type { ExecResult } from '../exec.js';

/** Network levels of the MVP doc: a step can only narrow the repository's level. */
export type NetworkLevel = 'none' | 'claude-api' | 'limited' | 'full';

/** Compute isolation of the MVP doc: L3 rootless container, L4 gVisor, L5 microVM. Only L3 exists at the MVP. */
export type IsolationLevel = 'L3' | 'L4' | 'L5';

/** What the pipeline asks of a sandbox (ORC-204): a backend satisfies all of it, or the sandbox is refused. */
export interface SandboxRequirements {
  minLevel: IsolationLevel;
  browser: boolean;
  services: readonly string[];
}

export const DEFAULT_REQUIREMENTS: SandboxRequirements = { minLevel: 'L3', browser: false, services: [] };

export interface SandboxMount {
  /** Absolute path on the host. */
  host: string;
  /** Absolute path in the sandbox. */
  target: string;
  readOnly: boolean;
}

export interface SandboxRequest {
  /** The attempt the sandbox belongs to: its idempotence key (label `factory.attempt=<runId>`). */
  runId: string;
  ticketId: string;
  /** The run's worktree, mounted read-write at `WORKSPACE_TARGET`. */
  workspacePath: string;
  network: NetworkLevel;
  requirements: SandboxRequirements;
  /** Other host paths the run needs (git common dir, Claude session dir, pack): nothing else is mounted. */
  mounts: readonly SandboxMount[];
}

export const WORKSPACE_TARGET = '/work';

export interface Sandbox {
  id: string;
  /** The level actually applied; can differ from the request only by a documented gap (claude-api open until ORC-213). */
  network: NetworkLevel;
  level: IsolationLevel;
}

export interface SandboxExecOptions {
  /** In the sandbox; defaults to `WORKSPACE_TARGET`. */
  cwd?: string;
  env?: Record<string, string>;
}

export interface SandboxProvider {
  /** A live sandbox for `req.runId`; replayed for the same run, it returns that sandbox. Rejects when no backend satisfies `req.requirements`. */
  create(req: SandboxRequest): Promise<Sandbox>;
  /** Runs `argv` in the sandbox to completion. Rejects on an unknown sandbox; a non-zero exit is a result, not a rejection. */
  exec(id: string, argv: readonly string[], opts?: SandboxExecOptions): Promise<ExecResult>;
  /**
   * The host command (`[cmd, ...args]`) that runs `argv` in the sandbox with stdio attached, for a
   * runner that streams its output (`ClaudeCodeRunner`). Throws on an unknown sandbox.
   */
  spawnCommand(id: string, argv: readonly string[], opts?: SandboxExecOptions): string[];
  /** The live sandbox of an attempt, by its label; none once destroyed. */
  findByAttempt(runId: string): Promise<Sandbox | undefined>;
  /** Every live sandbox this provider made (by label), for recover() to destroy those of dead attempts. */
  list(): Promise<{ runId: string; sandbox: Sandbox }[]>;
  /** Idempotent: an unknown or destroyed id is ignored. */
  destroy(id: string): Promise<void>;
}
