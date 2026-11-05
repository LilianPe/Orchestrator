// The output of a failed check, cut to what helps (ORC-151): it goes back to the agent, and into the journal.

/** Characters, in all: what the prompt carried before, as a plain tail. */
export const LOG_EXCERPT_MAX = 8000;

// eslint-disable-next-line no-control-regex -- the escape sequences a test runner prints in colour are what it removes.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const USEFUL = /\b(?:error|errors|fail|failed|failure|failures|failing|fatal|panic|exception|traceback|assert\w*|expected|received)\b|[✗✕×]/i;

const cut = (lines: number) => `[… ${lines} lignes coupées …]`;

/** As many of `lines` as fit in `budget`, a line too long kept up to it. Its count of characters comes with them. */
function fit(lines: readonly string[], budget: number): { kept: string[]; used: number } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = line.length + 1;
    if (used + size > budget) {
      if (!kept.length) return { kept: [line.slice(0, budget)], used: budget };
      break;
    }
    kept.push(line);
    used += size;
  }
  return { kept, used };
}

/**
 * Without its colours, and within `max`: its start, which names what ran; its end, where a runner writes its summary;
 * and between them the lines that look like an error. The rest is replaced by a line saying how much went.
 */
export function logExcerpt(output: string, max = LOG_EXCERPT_MAX): string {
  const text = output.replace(ANSI, '');
  if (text.length <= max) return text;
  const lines = text.split('\n');
  const head = fit(lines, Math.floor(max / 8));
  const tail = fit([...lines.slice(head.kept.length)].reverse(), Math.floor(max / 2));
  const middle = lines.slice(head.kept.length, lines.length - tail.kept.length);
  const useful = fit(middle.filter((l) => USEFUL.test(l)), max - head.used - tail.used);
  const dropped = middle.length - useful.kept.length;
  return [...head.kept, ...(dropped ? [cut(dropped)] : []), ...useful.kept, ...(useful.kept.length && dropped ? [cut(0).replace('0 lignes coupées', 'fin')] : []), ...tail.kept.reverse()].join('\n');
}
