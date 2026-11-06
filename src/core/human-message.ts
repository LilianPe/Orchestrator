import type { FeedbackItem, MessageKind } from './types.js';

/** The commands a message can be, answered by the factory itself, no model and no agent. */
export const STOP_COMMAND = '/stop';
const STATUS_COMMAND = '/status';

/** The first word of a message, as a command is read. */
export const commandOf = (body: string): string | undefined => body.trim().toLowerCase().split(/\s+/, 1)[0];

/**
 * What a message that asks for an action starts with, accents left out. Every word an action can open a sentence with
 * cannot be listed: what is missed is ambiguous, so a question, and reaches the agent all the same. ORC-141 settles the list.
 */
const ACTION = new RegExp(
  `^(?:(?:stp|svp|s'il te plait|s'il vous plait|merci de|please)[ ,:]+)?(?:${[
    'arrete', 'stop', 'reprends', 'reprenez', 'continue', 'change', 'changez', 'modifie', 'corrige', 'corrigez', 'ajoute', 'ajoutez', 'retire', 'enleve', 'supprime',
    'remplace', 'renomme', 'renommer', 'deplace', 'mets', 'utilise', 'garde', 'fais', 'refais', 'teste', 'verifie', 'relance', 'annule', 'il faut', "n'oublie pas", 'pense a', 'ne touche pas',
    'fix', 'add', 'remove', 'delete', 'replace', 'rename', 'move', 'use', 'keep', 'update', 'revert', 'make',
  ].join('|')})(?![\\p{L}\\p{N}])`,
  'u',
);

/**
 * Classifies a human message at its arrival, the deterministic rules of ORC-180, with no model: a command by its first
 * word, a question mark outside a URL is a question, a message that opens with an action is an instruction, and all else, a mention of
 * the agent included, stays ambiguous, so a question: the worst case is a useless answer, not a silence. Pure, and
 * journaled with the event: a change of these rules leaves the decisions already taken as they are.
 */
export function classifyMessage(body: string): MessageKind {
  const first = commandOf(body);
  if (first === STOP_COMMAND || first === STATUS_COMMAND) return 'command';
  const text = body.trim().toLowerCase();
  // The question mark of a URL asks nothing.
  if (text.replace(/\bhttps?:\/\/\S+/g, '').includes('?')) return 'question';
  return ACTION.test(text.normalize('NFD').replace(/\p{M}/gu, '').replaceAll('’', "'")) ? 'instruction' : 'question';
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
