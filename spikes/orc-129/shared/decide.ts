// Minimal copy of the engine contract for the ORC-129 spike: (state, event) -> (state, effects).
// Pure: no clock, no random, no I/O, no framework import. Effect ids are assigned by the runtime.

export type TicketState = { status: 'acknowledging' | 'done'; commentId?: string };

export type EngineEvent =
  | { id: string; ticket: string; type: 'ticket.delegated'; payload: { title: string } }
  | { id: string; ticket: string; type: 'effect.done'; payload: { effectId: string; result: { commentId: string } } };

export type Effect = { kind: 'post_comment'; ticket: string; body: string };

export type Decision = { state: TicketState | undefined; effects: Effect[] };

export function decide(state: TicketState | undefined, event: EngineEvent): Decision {
  switch (event.type) {
    case 'ticket.delegated':
      if (state) return { state, effects: [] };
      return {
        state: { status: 'acknowledging' },
        effects: [{ kind: 'post_comment', ticket: event.ticket, body: `Pris en compte : ${event.payload.title}` }],
      };
    case 'effect.done':
      if (state?.status !== 'acknowledging') return { state, effects: [] };
      return { state: { status: 'done', commentId: event.payload.result.commentId }, effects: [] };
  }
}

export const effectId = (ticket: string, seq: number, i: number): string => `${ticket}:${seq}:${i}`;
