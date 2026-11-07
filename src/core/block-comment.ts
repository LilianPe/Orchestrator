import type { TicketState } from './types.js';

/**
 * What a block says, in fields (ORC-196): `decide` writes them on the `block_comment` effect, so that a replay compares
 * facts and not a sentence. `reason` is also the ticket's `blockReason`, whose head gives the cause (`blockCause`).
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
  tokens?: number | undefined;
  durationMs?: number | undefined;
}

/** The closed question of a block that no one asked: the common one, the reply being the instruction if there is any. */
const REDO = "Je reprends l'étape telle quelle (répondez « oui ») ou avec une consigne (écrivez-la) ?";

/**
 * The fields of a block. `attempts`: the counter the block is the end of, so its last attempt as well as its bound; a
 * step no counter sends back had one try.
 */
export function blockFacts({ reason, step, tried, attempts = 1, question = REDO }: Pick<BlockFacts, 'reason' | 'step' | 'tried'> & { attempts?: number; question?: string }): BlockFacts {
  return { step, max: attempts, reason, tried, question };
}

const CI: Record<NonNullable<TicketState['prChecks']>, string> = { pending: 'en cours', pass: 'verte', fail: 'rouge', none: 'aucune' };
const MAX_TRIED = 5;
const SHORT_SHA = 12;

function stateLine({ branch, sha, ci, tokens, durationMs }: BlockStatus): string {
  const duration = durationMs === undefined ? 'durée inconnue' : `${Math.round(durationMs / 60_000)} min`;
  return `État : branche ${branch ?? 'aucune'} · dernier commit ${sha?.slice(0, SHORT_SHA) ?? 'aucun'} · CI ${ci ? CI[ci] : 'aucune'} · tokens ${tokens ?? 'inconnus'} · ${duration}`;
}

/**
 * The one text of a block, the only place that composes it. Pure, and read by no bundle of the web: ORC-214 puts its
 * `OutputPolicy` in front of what this returns, the agent's question being the one free text in it.
 */
export function composeBlockComment(facts: BlockFacts, status: BlockStatus): string {
  return [
    `🔴 Bloqué à l'étape ${facts.step} (tentative ${facts.max}/${facts.max})`,
    `Raison : ${facts.reason.replace(/\s+/g, ' ').trim()}`,
    "Ce que j'ai essayé :",
    ...facts.tried.slice(0, MAX_TRIED).map((t) => `- ${t}`),
    `Question : ${facts.question}`,
    stateLine(status),
    facts.waits ? 'Une réponse ne suffit pas ici : je reprends une fois ce qui est demandé ci-dessus fait.' : 'Répondez dans ce ticket : je reprends dès votre réponse.',
  ].join('\n');
}
