import type { FeedbackItem, MessageKind } from './types.js';

/** The commands a message can be, answered by the factory itself, no model and no agent. */
export const STOP_COMMAND = '/stop';
const STATUS_COMMAND = '/status';

/** The first word of a message, as a command is read. */
export const commandOf = (body: string): string | undefined => body.trim().toLowerCase().split(/\s+/, 1)[0];

/** `/stop` and `/status`, read by the first word, answered by the factory itself: they never reach a model. */
export const isCommand = (body: string): boolean => {
  const first = commandOf(body);
  return first === STOP_COMMAND || first === STATUS_COMMAND;
};

/** What the small model said of a message (ORC-336): nothing when it could not say. */
export type ModelVerdict = 'instruction' | 'question' | undefined;

/**
 * Classifies a human message at its arrival (ORC-180, ORC-336): a command by its first word; otherwise what the small
 * model said at ingestion; without its verdict (no backend, a failure, a timeout, an answer that is neither word), a
 * question mark outside a URL makes a question and anything else an instruction. Pure, and journaled with the event:
 * the model is never called on replay, and a change of these rules leaves the decisions already taken as they are.
 */
export function classifyMessage(body: string, verdict?: ModelVerdict): MessageKind {
  if (isCommand(body)) return 'command';
  if (verdict) return verdict;
  // The question mark of a URL asks nothing.
  return body.replace(/\bhttps?:\/\/\S+/gi, '').includes('?') ? 'question' : 'instruction';
}

/** What of the human inbox a run reads: a command is answered by the factory, nothing is left of it for an agent. */
/** A message classified at its arrival, that the factory did not answer itself. */
const classified = (i: FeedbackItem): boolean => i.kind !== undefined && i.kind !== 'command';

export function forAgent(items: readonly FeedbackItem[]): FeedbackItem[] {
  return items.filter((i) => i.kind !== 'command');
}

/**
 * Whether a message waits for the agent that implements and asks for it to be resumed when no step comes next. A
 * question of a thread has its answer: it goes with the next run, and starts none. An item without a class was written
 * before ORC-180: the debounce relays it, as it did.
 */
export function awaitsAgent(items: readonly FeedbackItem[]): boolean {
  return items.some((i) => classified(i) && i.source === 'session');
}

/**
 * What a launch that does not read the feedback by itself gives the agent that implements: its step boundary (ORC-180).
 * Nothing without a classified message, so that what was written before ORC-180 goes on waiting for its debounce.
 */
export function carriedAtLaunch(items: readonly FeedbackItem[]): FeedbackItem[] {
  return items.some(classified) ? forAgent(items) : [];
}
