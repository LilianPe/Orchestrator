import { hashText } from '../../core/attempt-labels.js';
import type { Stagnation } from '../../core/types.js';

/** What changes from one run of a command to the next without being another failure. */
const NOISE: readonly (readonly [RegExp, string])[] = [
  // eslint-disable-next-line no-control-regex
  [/\u001b\[[0-9;]*[A-Za-z]/g, ''],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<date>'],
  [/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<heure>'],
  [/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|m|min)\b/g, '<durée>'],
  [/\b0x[0-9a-fA-F]+\b/g, '<adresse>'],
  [/\b[0-9a-f]{7,64}\b/g, '<hash>'],
  [/\b(pid)[ =:]+\d+/gi, '$1 <n>'],
  [/(?:\/tmp|\/var\/folders|\/var\/tmp)\/[^\s:'"]+/g, '<tmp>'],
  [/\s+/g, ' '],
];

export function normalizeFailure(output: string): string {
  return NOISE.reduce((text, [noise, by]) => text.replace(noise, by), output).trim();
}

export interface FailedCommand {
  command: string;
  output: string;
}

function toolOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b: { type?: unknown; text?: unknown }) => (b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}

/**
 * The Bash calls a line of the stream reports failed. `pending` holds the calls made and not answered yet, by
 * tool id, across the lines of an attempt. On a line already masked: neither fact carries a known secret.
 */
export function failedCommand(line: unknown, pending: Map<string, string>): FailedCommand[] {
  const { type, message } = (line ?? {}) as { type?: unknown; message?: { content?: unknown } };
  const blocks = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
  const failed: FailedCommand[] = [];
  for (const b of blocks) {
    if (type === 'assistant' && b?.['type'] === 'tool_use' && b['name'] === 'Bash') {
      const { command } = (b['input'] ?? {}) as { command?: unknown };
      if (typeof b['id'] === 'string' && typeof command === 'string') pending.set(b['id'], command);
    }
    if (type === 'user' && b?.['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
      const command = pending.get(b['tool_use_id']);
      pending.delete(b['tool_use_id']);
      if (command !== undefined && b['is_error']) failed.push({ command, output: toolOutput(b['content']) });
    }
  }
  return failed;
}

/** The command as the journal and the ticket show it. */
const COMMAND_MAX = 200;

/**
 * Same command, same normalized failure, `limit` times with no change of the worktree between them: the agent
 * turns in circles (ORC-136). Other commands in between change nothing; any change of the content starts every count
 * over, a return to an earlier content included: it was work.
 */
export class LoopDetector {
  private readonly seen = new Map<string, number>();
  private tree: string | undefined;

  constructor(private readonly limit: number) {}

  record(failed: FailedCommand, tree: string): Stagnation | undefined {
    if (tree !== this.tree) this.seen.clear();
    this.tree = tree;
    const failure = hashText(normalizeFailure(failed.output));
    const key = `${failed.command}\0${failure}`;
    const count = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, count);
    return count >= this.limit ? { kind: 'loop', command: failed.command.slice(0, COMMAND_MAX), failure, tree, count } : undefined;
  }
}

/**
 * The tree of the whole worktree (`sh`, run where the agent runs: in its sandbox when it has one, the worktree
 * being its own): what `verify.failed` calls `tree`, edits, staged or not, and untracked files in. As `worktreeTree`
 * of `core/verify.ts` does on the host: a copy of the index and a throwaway object store, the repository is only read.
 */
export const WORKTREE_TREE = `d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && i=$(git rev-parse --git-path index) && o=$(cd "$(git rev-parse --git-path objects)" && pwd) && mkdir "$d/o" && { cp "$i" "$d/i" 2>/dev/null; export GIT_INDEX_FILE="$d/i" GIT_OBJECT_DIRECTORY="$d/o" GIT_ALTERNATE_OBJECT_DIRECTORIES="$o"; git add -A . && git write-tree; }`;
