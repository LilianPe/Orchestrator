import type { FeedbackItem, InputKind, LogicalState, TicketState } from './types.js';

export type ActivityType = 'thought' | 'response' | 'elicitation' | 'error';

export type Command =
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
  | { kind: 'set_debounce'; job: string; ms: number }
  | { kind: 'append_feedback'; item: FeedbackItem }
  | { kind: 'cleanup' }
  | { kind: 'block'; reason: string }
  | { kind: 'unblock' }
  | {
      kind: 'patch_ticket';
      patch: Partial<Pick<TicketState, 'verifyAttempts' | 'prNumber' | 'prUrl' | 'prChecks' | 'prState' | 'linearSessionId'>>;
    }
  | { kind: 'set_paused'; paused: boolean };
