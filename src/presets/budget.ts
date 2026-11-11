import { failureEdges, isAgentStep, type Preset, type Step } from './preset.js';

/**
 * What bounds a ticket's spending (ORC-216): `budgets` of factory.yml, the repository's `per_ticket_tokens` already folded in.
 * A token cap `off` is disabled in factory.yml (ORC-381): accepted, where one left unset is refused.
 */
export interface BudgetCaps {
  /** Tokens of one attempt, by agent step (`budgets.per_step_tokens`). */
  perStepTokens?: Record<string, number> | 'off';
  /** Lowers a step's `maxTurns` (`budgets.max_turns`). */
  maxTurns?: Record<string, number>;
  /** Tokens of all the ticket's runs (`budgets.per_ticket_tokens`). */
  perTicketTokens?: number | 'off';
}

/** The most a ticket can spend on the preset: every failure edge taken as often as its counter allows, where it costs the most. */
export interface WorstCase {
  tokens: number;
  turns: number;
  /** Attempts of each agent step on the path that spends the most tokens. */
  attempts: Record<string, number>;
}

type AgentStep = Extract<Step, { maxTurns: number }>;
interface Heaviest {
  total: number;
  attempts: Map<string, number>;
}

/** A state the walk reached again while computing it: some way back is not bounded. */
class Unbounded extends Error {}

/**
 * The heaviest run of `preset` under `weight`, an exact maximum: at each step, the run passes to `next` or takes a failure
 * edge whose counter is not spent. A `verify` step that passes refills its own counter, as the engine's `verify.passed`
 * resets `verifyAttempts` and `redAttempts`: each entry into a checked loop gets all its retries. Memoized on the step and
 * the counters left; a state reached again while being computed throws `Unbounded`.
 */
function heaviest(preset: Preset, weight: (s: Step) => number): Heaviest {
  const byId = new Map(preset.steps.map((s) => [s.id, s]));
  const names = Object.keys(preset.counters);
  const full = (left: number[], counter: string) => left.map((n, i) => (names[i] === counter ? preset.counters[counter]!.limit : n));
  const memo = new Map<string, Heaviest>();
  const open = new Set<string>();
  const from = (id: string | null, left: number[]): Heaviest => {
    const s = id === null ? undefined : byId.get(id);
    if (!s) return { total: 0, attempts: new Map() };
    const key = `${s.id}|${left.join(',')}`;
    const known = memo.get(key);
    if (known) return known;
    if (open.has(key)) throw new Unbounded(s.id);
    open.add(key);
    let best = from(s.next, s.type === 'verify' && s.onFailure ? full(left, s.onFailure.counter) : left);
    for (const edge of failureEdges(s, preset)) {
      const i = names.indexOf(edge.counter);
      if (i < 0 || left[i]! <= 0) continue;
      const failed = from(edge.goto, left.map((n, j) => (j === i ? n - 1 : n)));
      if (failed.total > best.total) best = failed;
    }
    const attempts = isAgentStep(s) ? new Map(best.attempts).set(s.id, (best.attempts.get(s.id) ?? 0) + 1) : best.attempts;
    const result = { total: best.total + weight(s), attempts };
    open.delete(key);
    memo.set(key, result);
    return result;
  };
  return from(preset.entry, names.map((n) => preset.counters[n]!.limit));
}

/** The turns an agent step runs with: its `maxTurns`, lowered by `max_turns`. */
const turnsOf = (s: AgentStep, caps: BudgetCaps): number => Math.min(s.maxTurns, caps.maxTurns?.[s.id] ?? Infinity);

/**
 * The worst case of `preset` in tokens and in turns (ORC-216): Σ attempts × cap over the agent steps, on the run that
 * maximizes it. `missing` names the caps without which it has no bound: an agent step without `per_step_tokens`.
 * `unbounded`: a way back the counters do not bound, named by a step on it.
 */
export function worstCase(preset: Preset, caps: BudgetCaps & { perStepTokens?: Record<string, number> }): WorstCase | { missing: string[] } | { unbounded: string } {
  const agents = preset.steps.filter(isAgentStep);
  const perStep = caps.perStepTokens ?? {};
  const missing = agents.filter((s) => perStep[s.id] === undefined).map((s) => `budgets.per_step_tokens.${s.id}`);
  if (missing.length) return { missing };
  try {
    const tokens = heaviest(preset, (s) => (isAgentStep(s) ? perStep[s.id]! : 0));
    const turns = heaviest(preset, (s) => (isAgentStep(s) ? turnsOf(s, caps) : 0));
    return { tokens: tokens.total, turns: turns.total, attempts: Object.fromEntries(agents.map((s) => [s.id, tokens.attempts.get(s.id) ?? 0])) };
  } catch (err) {
    if (err instanceof Unbounded) return { unbounded: err.message };
    throw err;
  }
}

/**
 * The invariant « budget caps » of the core (ORC-216): every agent step has its cap in tokens, the ticket has its own,
 * and the worst case stays under it. A cap still « to set » refuses, never passes; one disabled (`off`, ORC-381) passes,
 * and without the per-step caps there is no worst case in tokens. `worst`: when it has a bound.
 */
export function checkBudgets(preset: Preset, caps: BudgetCaps): { violations: string[]; worst?: WorstCase } {
  const unset = (key: string) => `${key}: not set; the worst case of ${preset.name} has no bound without it`;
  const violations = caps.perTicketTokens === undefined ? [unset('budgets.per_ticket_tokens')] : [];
  if (caps.perStepTokens === 'off') return { violations };
  const worst = worstCase(preset, { ...caps, perStepTokens: caps.perStepTokens });
  if ('missing' in worst) violations.unshift(...worst.missing.map(unset));
  if ('unbounded' in worst) violations.unshift(`worst case unbounded: a counter refills inside its own loop, through step ${worst.unbounded}`);
  if (!('tokens' in worst)) return { violations };
  if (typeof caps.perTicketTokens === 'number' && worst.tokens > caps.perTicketTokens) {
    violations.push(`worst case ${worst.tokens} tokens per ticket exceeds budgets.per_ticket_tokens ${caps.perTicketTokens}: lower a step's per_step_tokens or a counter of ${preset.name}`);
  }
  return { violations, worst };
}
