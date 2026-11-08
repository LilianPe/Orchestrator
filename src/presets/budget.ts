import type { FailureEdge, Preset, Step } from './preset.js';

/** What bounds a ticket's spending (ORC-216): `budgets` of factory.yml, the repository's `per_ticket_tokens` already folded in. */
export interface BudgetCaps {
  /** Tokens of one attempt, by agent step (`budgets.per_step_tokens`). */
  perStepTokens?: Record<string, number>;
  /** Lowers a step's `maxTurns` (`budgets.max_turns`). */
  maxTurns?: Record<string, number>;
  /** Tokens of all the ticket's runs (`budgets.per_ticket_tokens`). */
  perTicketTokens?: number;
}

/** The most a ticket can spend on the preset: every failure edge taken as often as its counter allows, where it costs the most. */
export interface WorstCase {
  tokens: number;
  turns: number;
  /** Attempts of each agent step on the path that spends the most tokens. */
  attempts: Record<string, number>;
}

type AgentStep = Extract<Step, { maxTurns: number }>;

const isAgent = (s: Step): s is AgentStep => s.type === 'agent_step' || s.type === 'fix' || s.type === 'review';

/** The failure edges a step can take, the red CI's included (the same as `compilePreset` follows). */
function failureEdges(s: Step, preset: Preset): FailureEdge[] {
  const out = s.onFailure ? [s.onFailure] : [];
  if ((s.type === 'publish' && s.mode === 'push') || (s.type === 'human_gate' && s.gate === 'merge')) out.push(preset.redCi);
  return out;
}

/**
 * The heaviest run of `preset` under `weight`, an exact maximum: from a step, the run follows `next` and, at each step
 * that has a failure edge whose counter is not spent, may take it instead. Memoized on the step and the counters left,
 * which a valid preset keeps small (its counters bound every way back, its `next` edges never loop).
 */
function heaviest(preset: Preset, weight: (s: Step) => number): { total: number; attempts: Map<string, number> } {
  const byId = new Map(preset.steps.map((s) => [s.id, s]));
  const names = Object.keys(preset.counters);
  const memo = new Map<string, { total: number; attempts: Map<string, number> }>();
  const from = (start: string, left: number[]): { total: number; attempts: Map<string, number> } => {
    const key = `${start}|${left.join(',')}`;
    const known = memo.get(key);
    if (known) return known;
    let best = { total: -1, attempts: new Map<string, number>() };
    const ran: Step[] = [];
    const consider = (total: number, rest: Map<string, number>) => {
      if (total <= best.total) return;
      const attempts = new Map(rest);
      for (const s of ran) if (isAgent(s)) attempts.set(s.id, (attempts.get(s.id) ?? 0) + 1);
      best = { total, attempts };
    };
    let spent = 0;
    // Bounded by the steps' count too: a preset whose `next` edges loop is refused by `compilePreset`, never walked forever.
    for (let s = byId.get(start); s && ran.length < byId.size; s = s.next === null ? undefined : byId.get(s.next)) {
      ran.push(s);
      spent += weight(s);
      for (const edge of failureEdges(s, preset)) {
        const i = names.indexOf(edge.counter);
        if (i < 0 || left[i]! <= 0) continue;
        const after = from(edge.goto, left.map((n, j) => (j === i ? n - 1 : n)));
        consider(spent + after.total, after.attempts);
      }
      if (s.next === null) consider(spent, new Map());
    }
    memo.set(key, best);
    return best;
  };
  const best = from(preset.entry, names.map((n) => preset.counters[n]!.limit));
  return { total: Math.max(0, best.total), attempts: best.attempts };
}

/** The caps an agent step runs with: its turns lowered by `max_turns`, its tokens from `per_step_tokens`. */
const turnsOf = (s: AgentStep, caps: BudgetCaps): number => Math.min(s.maxTurns, caps.maxTurns?.[s.id] ?? Infinity);

/**
 * The worst case of `preset` in tokens and in turns (ORC-216): Σ attempts × cap over the agent steps, on the run that
 * maximizes it. `missing` names the caps without which it has no bound: an agent step without `per_step_tokens`.
 */
export function worstCase(preset: Preset, caps: BudgetCaps): WorstCase | { missing: string[] } {
  const agents = preset.steps.filter(isAgent);
  const missing = agents.filter((s) => caps.perStepTokens?.[s.id] === undefined).map((s) => `budgets.per_step_tokens.${s.id}`);
  if (missing.length) return { missing };
  const tokens = heaviest(preset, (s) => (isAgent(s) ? caps.perStepTokens![s.id]! : 0));
  const turns = heaviest(preset, (s) => (isAgent(s) ? turnsOf(s, caps) : 0));
  return { tokens: tokens.total, turns: turns.total, attempts: Object.fromEntries(agents.map((s) => [s.id, tokens.attempts.get(s.id) ?? 0])) };
}

/**
 * The invariant « budget caps » of the core (ORC-216): every agent step has its cap in tokens, the ticket has its own,
 * and the worst case stays under it. A cap still « to set » refuses, never passes.
 */
export function budgetViolations(preset: Preset, caps: BudgetCaps): string[] {
  const worst = worstCase(preset, caps);
  const unset = (key: string) => `${key}: not set; the worst case of ${preset.name} has no bound without it`;
  const violations = 'missing' in worst ? worst.missing.map(unset) : [];
  if (caps.perTicketTokens === undefined) violations.push(unset('budgets.per_ticket_tokens'));
  else if (!('missing' in worst) && worst.tokens > caps.perTicketTokens) {
    violations.push(`worst case ${worst.tokens} tokens per ticket exceeds budgets.per_ticket_tokens ${caps.perTicketTokens}: lower a step's per_step_tokens or a counter of ${preset.name}`);
  }
  return violations;
}
