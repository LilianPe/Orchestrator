import type { NetworkLevel } from '../adapters/sandbox/types.js';
import type { Step } from './preset.js';

/** The built-in tools of a read-only step (`claude --tools`): it reads and searches, it writes nothing and runs no command (ORC-183, ORC-367). */
export const READ_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

/**
 * The built-in tools of a step that writes in its worktree (ORC-383): edit, shell, its skills (`factory:tdd`…) and its to-do list.
 * No subagent (ORC-155: the only separate agents are the reviewers and the answer agent), no web tool by default.
 */
export const WRITE_TOOLS: readonly string[] = [...READ_TOOLS, 'Edit', 'Write', 'NotebookEdit', 'Bash', 'TodoWrite', 'Skill'];

/** Fetches a URL from the sandbox: given only on request, to a step whose network reaches past the Claude API. */
const WEB_FETCH = 'WebFetch';

const isReadOnly = (s: Step): boolean => (s.type === 'agent_step' || s.type === 'review') && !!s.readOnly;

/** The default tools of an agent step: the read tools when it is read-only, the write tools otherwise; none for a step with no agent. */
export function stepTools(s: Step): readonly string[] | undefined {
  if (s.type !== 'agent_step' && s.type !== 'fix' && s.type !== 'review') return undefined;
  return isReadOnly(s) ? READ_TOOLS : WRITE_TOOLS;
}

/**
 * Why `tool` cannot be given to the agent step `s` at `network` (its own by default), or undefined: a configuration narrows a
 * step's tools, never past what its preset step and its network allow. WebSearch is refused by the pack's settings and hook.
 */
export function toolRefusal(s: Step, tool: string, network: NetworkLevel = s.network ?? 'none'): string | undefined {
  if (tool === 'WebSearch') return `${tool}: never given, the factory refuses web searches in a run`;
  if (tool === WEB_FETCH) {
    if (isReadOnly(s)) return `${tool}: the step ${s.id} is read-only (${READ_TOOLS.join(', ')})`;
    return network === 'limited' ? undefined : `${tool}: needs network limited, the step ${s.id} runs at ${network}`;
  }
  if (!WRITE_TOOLS.includes(tool)) return `${tool}: not a tool the factory gives (${[...WRITE_TOOLS, WEB_FETCH].join(', ')})`;
  return isReadOnly(s) && !READ_TOOLS.includes(tool) ? `${tool}: the step ${s.id} is read-only (${READ_TOOLS.join(', ')})` : undefined;
}

/**
 * The tools a run gets (ORC-383): its job's, kept to the repository's list for its step, which only restricts, and without WebFetch
 * where the run's network does not reach. A job without tools (every tool: a version frozen before ORC-383) takes the repository's list.
 */
export function narrowTools(tools: readonly string[] | undefined, repo: readonly string[] | undefined, network: NetworkLevel): readonly string[] | undefined {
  const kept = tools && repo ? tools.filter((t) => repo.includes(t)) : (tools ?? repo);
  return kept && network !== 'limited' && network !== 'full' ? kept.filter((t) => t !== WEB_FETCH) : kept;
}
