import type { TicketState } from './types.js';

/**
 * What a block says, in fields (ORC-196): `decide` writes them on the `block_comment` effect, so that a replay compares
 * facts and not a sentence. `reason` is also the ticket's `blockReason`, shown only: the block's kind says its cause (ORC-345).
 */
export interface BlockFacts {
  /** The step of `factory/default`, or the name of a job out of the preset. */
  step: string;
  /** The attempts the block ends: its last one is its bound. Effects recorded before may carry an `attempt` too, read by none. */
  max: number;
  reason: string;
  /** What was tried, facts only: as many as there are, 5 at most in the comment. */
  tried: string[];
  question: string;
  /** Only an action lifts this block (a repo to add or to name): a reply does not resume it. */
  waits?: true;
}

/** The state line, read when the comment is written: the repository and the attempts are not in the decision. */
export interface BlockStatus {
  branch?: string | undefined;
  sha?: string | undefined;
  ci?: TicketState['prChecks'];
  /** Of the ticket's code runs, as `per_ticket_tokens` counts them (`codeRunTokens`, ORC-340). */
  tokens?: number | undefined;
  durationMs?: number | undefined;
}

/** The closed question of a block that no one asked: the common one, the reply being the instruction if there is any. */
const REDO = 'Shall I redo the step as is (reply "yes") or with an instruction (write it)?';

/**
 * The fields of a block. `attempts`: the counter the block is the end of, so its last attempt as well as its bound; a
 * step no counter sends back had one try.
 */
export function blockFacts({ reason, step, tried, attempts = 1, question = REDO }: Pick<BlockFacts, 'reason' | 'step' | 'tried'> & { attempts?: number; question?: string }): BlockFacts {
  return { step, max: attempts, reason, tried, question };
}

const CI: Record<NonNullable<TicketState['prChecks']>, string> = { pending: 'pending', pass: 'green', fail: 'red', none: 'none' };
const MAX_TRIED = 5;
const SHORT_SHA = 12;

function stateLine({ branch, sha, ci, tokens, durationMs }: BlockStatus): string {
  const duration = durationMs === undefined ? 'unknown duration' : `${Math.round(durationMs / 60_000)} min`;
  return `State: branch ${branch ?? 'none'} · last commit ${sha?.slice(0, SHORT_SHA) ?? 'none'} · CI ${ci ? CI[ci] : 'none'} · code-run tokens ${tokens ?? 'unknown'} · ${duration}`;
}

/**
 * The one text of a block, the only place that composes it. Pure, and read by no bundle of the web: ORC-214 puts its
 * `OutputPolicy` in front of what this returns, the agent's question being the one free text in it.
 */
export function composeBlockComment(facts: BlockFacts, status: BlockStatus): string {
  return [
    `🔴 Blocked at step ${facts.step} (attempt ${facts.max}/${facts.max})`,
    `Reason: ${facts.reason.replace(/\s+/g, ' ').trim()}`,
    'What I tried:',
    ...facts.tried.slice(0, MAX_TRIED).map((t) => `- ${t}`),
    `Question: ${facts.question}`,
    stateLine(status),
    facts.waits ? 'A reply is not enough here: I will resume once what is asked above is done.' : 'Reply on this ticket: I will resume as soon as you answer.',
  ].join('\n');
}
