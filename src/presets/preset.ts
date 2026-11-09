import type { NetworkLevel } from '../adapters/sandbox/types.js';
import { NETWORK_RANK } from '../network/levels.js';
import { hashCanonical } from '../runtime/workflow-version.js';
import { checkBudgets, type BudgetCaps } from './budget.js';

/** A preset (ORC-187): typed steps chained by `next`, every way back bounded by a counter. */
export interface Preset {
  name: string;
  entry: string;
  steps: Step[];
  /** Limits of the failure edges, per run. Past the limit, the run is Blocked. */
  counters: Record<string, { limit: number }>;
  /** Same command, same failure, unchanged diff: past `limit` occurrences the run is Blocked with this cause. */
  sameFailure: { limit: number; cause: 'boucle' };
  /** An attempt that writes nothing on its stream for this long is stopped, the run Blocked (ORC-136): the lease only says that its container lives. */
  silentRun: { minutes: number };
  /**
   * Where a red CI goes, from any step while the PR is open (the merge gate included): it is the failure of
   * a push, and it never restarts `fix` outside this counter.
   */
  redCi: FailureEdge;
  /**
   * Where a conflict with the default branch goes (ORC-146), from the same steps as `redCi`: the engine starts the rebase
   * step, on the same counter, and no agent at work on another step resolves it.
   */
  conflict: FailureEdge;
}

export interface FailureEdge {
  goto: string;
  counter: string;
}

export type Effort = 'low' | 'medium' | 'high';
/** What sent the run to `fix`, which picks its skill. */
export type FixCause = 'ci' | 'review' | 'human';
/** What an agent step writes: only `code` must wait for the frozen tests. Required, so that omitting it never passes. */
export type Writes = 'nothing' | 'spec' | 'tests' | 'code';

interface BaseStep {
  id: string;
  /** Next step on success; null ends the run. */
  next: string | null;
  onFailure?: FailureEdge;
  network?: NetworkLevel;
}

interface AgentFields {
  model: string;
  effort: Effort;
  /** Turn cap of the step; its cap in tokens is `budgets.per_step_tokens` of factory.yml (ORC-216). */
  maxTurns: number;
  network: NetworkLevel;
}

export type Step =
  /** `readOnly`: it reads and searches, no write tool and no shell (`READ_TOOLS`, ORC-367); only a step that writes nothing. */
  | (BaseStep & AgentFields & { type: 'agent_step'; writes: Writes; skill?: string; optional?: boolean; readOnly?: boolean })
  | (BaseStep & AgentFields & { type: 'fix'; skills: Record<FixCause, string> })
  | (BaseStep & AgentFields & { type: 'review'; skill: string; readOnly: boolean })
  | (BaseStep & { type: 'verify'; mode: 'red' | 'freeze' | 'full'; network: NetworkLevel })
  | (BaseStep & { type: 'spec_check'; network: NetworkLevel })
  | (BaseStep & { type: 'human_gate'; gate: 'spec' | 'merge' })
  | (BaseStep & { type: 'publish'; mode: 'push' | 'merge' });

export interface CompileOptions {
  /** Network level chosen by the repository; a step can only narrow it. */
  repoNetwork?: NetworkLevel;
  /**
   * The budgets to check the invariant « budget caps » against (ORC-216): a cap to set, or a worst case over the
   * ticket's, refuses the preset. Absent, as the daemon loads it: the caps are still to calibrate, the structure alone is checked.
   */
  budgets?: BudgetCaps;
}

export interface CompiledPreset {
  preset: Preset;
  /** sha256 of the canonical JSON: the version a run is frozen on. */
  hash: string;
}

export class PresetError extends Error {
  constructor(readonly violations: string[]) {
    super(`invalid preset:\n- ${violations.join('\n- ')}`);
  }
}

/** Checks the invariants of the core and hashes the preset; throws a PresetError listing every violation. */
export function compilePreset(preset: Preset, options: CompileOptions = {}): CompiledPreset {
  const repoNetwork = options.repoNetwork ?? 'limited';
  const byId = new Map(preset.steps.map((s) => [s.id, s]));
  const violations: string[] = [];

  if (!byId.has(preset.entry)) violations.push(`entry ${preset.entry} is not a step`);
  if (byId.size !== preset.steps.length) violations.push('step ids must be unique');
  for (const [name, { limit }] of Object.entries(preset.counters)) {
    if (!isPositiveInt(limit)) violations.push(`counter ${name}: limit must be a positive integer`);
  }
  if (!isPositiveInt(preset.sameFailure.limit)) violations.push('sameFailure: limit must be a positive integer');
  if (!isPositiveInt(preset.silentRun.minutes)) violations.push('silentRun: minutes must be a positive integer');
  checkEdge('redCi', preset.redCi);
  checkEdge('conflict', preset.conflict);

  for (const s of preset.steps) {
    const where = `step ${s.id}`;
    if (s.next !== null && !byId.has(s.next)) violations.push(`${where}: next ${s.next} is not a step`);
    if (s.onFailure) checkEdge(where, s.onFailure);
    if (s.network) {
      if (s.network === 'full') violations.push(`${where}: network full is reserved for setup`);
      else if (NETWORK_RANK[s.network] > NETWORK_RANK[repoNetwork]) {
        violations.push(`${where}: network ${s.network} is wider than the repository level ${repoNetwork}`);
      }
    }
    if (s.type === 'verify' && s.network !== 'none') violations.push(`${where}: a verify step must run with network none`);
    if (s.type === 'review') {
      if (!s.readOnly) violations.push(`${where}: a review step must be read-only`);
      if (NETWORK_RANK[s.network] > NETWORK_RANK['claude-api']) violations.push(`${where}: a review step runs with network claude-api at most`);
    }
    if (s.type === 'agent_step' && !s.writes) violations.push(`${where}: an agent step must declare what it writes`);
    if (s.type === 'agent_step' && s.readOnly && s.writes !== 'nothing') violations.push(`${where}: a read-only step writes nothing`);
    if (isAgentStep(s) && !isPositiveInt(s.maxTurns)) {
      violations.push(`${where}: maxTurns must be a positive integer`);
    }
  }

  // Bounded cycles: every failure edge carries a counter, so the success edges alone must not loop.
  const cycle = findCycle(preset, byId);
  if (cycle) violations.push(`unbounded cycle through ${cycle.join(' → ')}`);

  // Tests frozen before the build: no step that writes code is reachable while skipping every freeze.
  const writers = preset.steps.filter((s) => s.type === 'fix' || (s.type === 'agent_step' && s.writes === 'code'));
  const unfrozen = reachable(preset, byId, [preset.entry], (s) => s.type === 'verify' && s.mode === 'freeze');
  for (const s of writers) if (unfrozen.has(s.id)) violations.push(`step ${s.id}: reachable without freezing the tests first`);

  // Merge gate: from written code, a merge is only reachable through a human merge gate.
  const ungated = reachable(preset, byId, writers.map((s) => s.id), (s) => s.type === 'human_gate' && s.gate === 'merge');
  for (const s of preset.steps) {
    if (s.type === 'publish' && s.mode === 'merge' && ungated.has(s.id)) violations.push(`step ${s.id}: reachable from written code without a merge gate`);
  }

  // The worst case walks the graph: only on a preset whose structure holds.
  if (violations.length === 0 && options.budgets) violations.push(...checkBudgets(preset, options.budgets).violations);
  if (violations.length > 0) throw new PresetError(violations);
  return { preset, hash: hashCanonical(preset) };

  function checkEdge(where: string, edge: FailureEdge) {
    if (!byId.has(edge.goto)) violations.push(`${where}: goto ${edge.goto} is not a step`);
    if (!Object.hasOwn(preset.counters, edge.counter)) violations.push(`${where}: counter ${edge.counter} is not declared`);
  }
}

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

/** A step an agent runs: it has a model, an effort and a cap of turns. */
export function isAgentStep(s: Step): s is Extract<Step, { maxTurns: number }> {
  return s.type === 'agent_step' || s.type === 'fix' || s.type === 'review';
}

/** The built-in tools of a read-only step (`claude --tools`): it reads and searches, it writes nothing and runs no command (ORC-183, ORC-367). */
export const READ_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

/** Its tools, when the step is read-only: `intake`, `clarify` and the AI review. Every other step has all of them. */
export function stepTools(s: Step): readonly string[] | undefined {
  return (s.type === 'agent_step' || s.type === 'review') && s.readOnly ? READ_TOOLS : undefined;
}

/** The ways back a step can take: its own failure edge, the red CI's and the conflict's (ORC-146). */
export function failureEdges(s: Step, preset: Preset): FailureEdge[] {
  const out = s.onFailure ? [s.onFailure] : [];
  // A red CI fails a push, and reaches the merge gate while the PR waits there, as a conflict does; a merged PR has no way back.
  if ((s.type === 'publish' && s.mode === 'push') || (s.type === 'human_gate' && s.gate === 'merge')) out.push(preset.redCi, preset.conflict);
  return out;
}

function edges(s: Step, preset: Preset): string[] {
  return [...(s.next === null ? [] : [s.next]), ...failureEdges(s, preset).map((e) => e.goto)];
}

/** Steps reachable from `starts` by success and failure edges, never entering a step that `stops` matches. */
function reachable(preset: Preset, byId: Map<string, Step>, starts: string[], stops: (s: Step) => boolean): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const s = byId.get(queue.pop()!);
    if (!s || seen.has(s.id) || stops(s)) continue;
    seen.add(s.id);
    queue.push(...edges(s, preset));
  }
  return seen;
}

/** A cycle of `next` edges, as the list of its steps closed on the first one, or null. */
function findCycle(preset: Preset, byId: Map<string, Step>): string[] | null {
  const done = new Set<string>();
  for (const start of preset.steps) {
    const path: string[] = [];
    for (let id: string | null = start.id; id !== null && byId.has(id) && !done.has(id); id = byId.get(id)!.next) {
      const at = path.indexOf(id);
      if (at >= 0) return [...path.slice(at), id];
      path.push(id);
    }
    for (const id of path) done.add(id);
  }
  return null;
}
