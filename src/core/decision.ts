import type { InputKind, InternalEvent, LogicalState } from './types.js';

export type ActivityType = 'thought' | 'response' | 'elicitation' | 'error';

/** An action outside the ticket state, carried out by the orchestrator (later: the outbox). */
export type Effect =
  | { kind: 'start_run'; job: string; input?: InputKind; inputText?: string; linearSessionId?: string; resume?: boolean }
  /** Without linearSessionId: stop the ticket's dev work. With it: stop only the runs of that (question) session. */
  | { kind: 'stop_run'; linearSessionId?: string }
  | { kind: 'run_verify'; runId: string; job: string }
  | { kind: 'move'; to: LogicalState }
  | { kind: 'labels'; add: string[]; remove: string[] }
  | { kind: 'comment'; body: string }
  | { kind: 'activity'; type: ActivityType; body: string; linearSessionId?: string; runId?: string }
  | { kind: 'post_output'; style: 'summary' | 'reply' | 'synthesis'; runId: string }
  | { kind: 'link_pr'; url: string }
  | { kind: 'cleanup' }
  | { kind: 'set_paused'; paused: boolean };

export type Timer = { kind: 'debounce'; job: string; ms: number };

/** What `decide` returns: state changes for `reduce`, effects to run, timers to arm, and why. */
export interface Decision {
  events: InternalEvent[];
  effects: Effect[];
  timers: Timer[];
  trace: string[];
}
