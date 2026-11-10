import { createHash } from 'node:crypto';

/**
 * The replay of closed tickets (ORC-231): each ticket run again by the factory on the `factory/fantome` preset, in its historical
 * environment, without effects; its PR then judged blind against the human one. A replay is written once, its threshold with it,
 * before any ticket runs: nothing changes it after (`Store.putGhostReplay` refuses a second write).
 */
export interface GhostReplay {
  id: string;
  projectId: string;
  /**
   * The share of the compared tickets whose factory PR must be mergeable, as is or after edits (ORC-143 decides its value): a
   * required input of the command, written with the replay and never changed.
   */
  threshold: number;
  /** The knowledge base given to the runs (ORC-260): on, at transaction time; off, none. */
  memory: boolean;
  /** Draws the order of the pairs and of each pair's PRs (`blindPairs`): kept in the store, never shown to the judge. */
  seed: string;
  tickets: string[];
  startedAt: number;
  startedBy: string;
}

/** The kind of the artifact a kept `publish` leaves (ORC-231): the PR the factory would have opened, which the blind judging reads. */
export const KEPT_PR = 'kept:pr';

/** The fixed grid of the judging (ORC-231). */
export const GRADES = ['as_is', 'after_edits', 'reject'] as const;
export type GhostGrade = (typeof GRADES)[number];
export const GRADE_LABELS: Record<GhostGrade, string> = { as_is: 'mergeable as is', after_edits: 'mergeable after edits', reject: 'to reject' };

export type GhostSide = 'factory' | 'human';

/** What a replay recorded of one ticket. */
export interface GhostTicket {
  replayId: string;
  ticketId: string;
  /** The human PR, read from the forge; its author never judges it. */
  humanPr: { number: number; url: string; author: string };
  mergeSha: string;
  /** The parent of the merge commit, where the clone stands (criterion 2); absent when the clone could not be made. */
  start?: string;
  /** The knowledge base's commit given to the run (transaction time); absent with memory off or no commit before the start. */
  knowledge?: string;
  /**
   * The dry run on the start commit (criterion 3, ORC-208): `unchecked` until it exists; `failed`, the ticket is counted apart and
   * leaves the comparison.
   */
  env: 'ok' | 'failed' | 'unchecked';
  envReason?: string;
  /** How the run ended: with a PR (kept as an artifact, `factoryPr` its id), without one, or blocked. */
  outcome: 'pr' | 'no_pr' | 'blocked';
  factoryPr?: string;
  costUsd: number;
  /** What the Rapide level assumed instead of asking, as written in the spec (`assumed`). */
  assumptions: number;
  at: number;
}

export interface GhostJudgment {
  replayId: string;
  ticketId: string;
  side: GhostSide;
  grade: GhostGrade;
  judge: string;
  at: number;
}

/** A pair as the judge sees it: its position and two PRs, A and B; which is the factory's stays out of the screen. */
export interface BlindPair {
  position: number;
  ticketId: string;
  a: GhostSide;
  b: GhostSide;
}

/** A number in [0, 1) drawn from the seed and a key: the same for the same replay, unknown without the seed. */
function draw(seed: string, key: string): number {
  return createHash('sha256').update(`${seed}\0${key}`).digest().readUInt32BE(0) / 2 ** 32;
}

/** A ticket with two PRs to compare: its environment did not fail, and the factory opened one. */
const comparable = (t: GhostTicket) => t.env !== 'failed' && t.outcome === 'pr' && t.factoryPr !== undefined;

/**
 * Criterion 5: the pairs (factory, human) of the replay in an order drawn at random, each pair's two PRs in a random order too,
 * drawn from the replay's seed: the same screen each time, whoever comes back to it. The tickets whose human PR `judge` wrote are
 * left out: someone else judges them.
 */
export function blindPairs(replay: GhostReplay, tickets: readonly GhostTicket[], judge: string): BlindPair[] {
  return tickets
    .filter((t) => comparable(t) && t.humanPr.author !== judge)
    .map((t) => ({ t, order: draw(replay.seed, `order:${t.ticketId}`), factoryFirst: draw(replay.seed, `side:${t.ticketId}`) < 0.5 }))
    .sort((x, y) => x.order - y.order || x.t.ticketId.localeCompare(y.t.ticketId))
    .map(({ t, factoryFirst }, i) => ({ position: i + 1, ticketId: t.ticketId, a: factoryFirst ? 'factory' : 'human', b: factoryFirst ? 'human' : 'factory' }));
}

/** `0.6` or `60%`: a share between 0 and 1. Anything else, or nothing, is no threshold. */
export function parseThreshold(raw: string | undefined): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(%?)\s*$/.exec(raw ?? '');
  if (!m) return undefined;
  const v = Number(m[1]) / (m[2] ? 100 : 1);
  return v >= 0 && v <= 1 ? v : undefined;
}

export interface GhostReportRow {
  ticketId: string;
  humanPr: string;
  start?: string;
  /** The factory's grade, or why it has none: `no_pr` (no PR, or blocked: not mergeable), `unjudged`. */
  factory: GhostGrade | 'no_pr' | 'unjudged';
  human: GhostGrade | 'unjudged' | null;
  assumptions: number;
  costUsd: number;
}

export interface GhostReport {
  replay: GhostReplay;
  rows: GhostReportRow[];
  /** Counted apart, out of the comparison (criterion 3). */
  envFailures: { ticketId: string; envReason: string }[];
  /** Tickets whose environment no dry run checked (ORC-208 not there yet). */
  envUnchecked: number;
  compared: number;
  mergeable: number;
  unjudged: number;
  share: number;
  threshold: number;
  /** `incomplete` while a compared PR waits for its judgment: no verdict on part of the replay. */
  verdict: 'met' | 'below' | 'incomplete';
  assumptions: number;
  totalCostUsd: number;
}

const isMergeable = (g: GhostReportRow['factory']) => g === 'as_is' || g === 'after_edits';

/**
 * The report (ORC-231): ticket by ticket, the environment failures apart, the total cost, and the verdict against the threshold
 * written before the replay. A ticket the factory left without a PR counts as not mergeable: the comparison is the factory's to win.
 */
export function ghostReport(replay: GhostReplay, tickets: readonly GhostTicket[], judgments: readonly GhostJudgment[]): GhostReport {
  const grade = (ticketId: string, side: GhostSide) => judgments.find((j) => j.ticketId === ticketId && j.side === side)?.grade;
  const kept = tickets.filter((t) => t.env !== 'failed');
  const rows: GhostReportRow[] = kept.map((t) => ({
    ticketId: t.ticketId,
    humanPr: t.humanPr.url,
    ...(t.start ? { start: t.start } : {}),
    factory: comparable(t) ? (grade(t.ticketId, 'factory') ?? 'unjudged') : 'no_pr',
    human: comparable(t) ? (grade(t.ticketId, 'human') ?? 'unjudged') : null,
    assumptions: t.assumptions,
    costUsd: t.costUsd,
  }));
  const mergeable = rows.filter((r) => isMergeable(r.factory)).length;
  const unjudged = rows.filter((r) => r.factory === 'unjudged' || r.human === 'unjudged').length;
  const share = rows.length ? mergeable / rows.length : 0;
  return {
    replay,
    rows,
    envFailures: tickets.filter((t) => t.env === 'failed').map((t) => ({ ticketId: t.ticketId, envReason: t.envReason ?? 'unknown' })),
    envUnchecked: kept.filter((t) => t.env === 'unchecked').length,
    compared: rows.length,
    mergeable,
    unjudged,
    share,
    threshold: replay.threshold,
    verdict: unjudged || !rows.length ? 'incomplete' : share >= replay.threshold ? 'met' : 'below',
    assumptions: rows.reduce((s, r) => s + r.assumptions, 0),
    totalCostUsd: tickets.reduce((s, t) => s + t.costUsd, 0),
  };
}
