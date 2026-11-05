// The output of a failed check, cut to what helps (ORC-151): it goes back to the agent, and into the journal.

/** Characters, in all: what the prompt carried before, as a plain tail. */
export const LOG_EXCERPT_MAX = 8000;
/** What the two lines saying how much went may take of it. */
const MARKS = 60;

// eslint-disable-next-line no-control-regex -- the escape sequences a test runner prints in colour are what it removes.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const USEFUL = /\b(?:errors?|fail|failed|failures?|failing|fatal|panic|exception|traceback|assert\w*|expected|received)\b|[✗✕×]/i;

/** As many of `lines` as fit in `budget`, a first line too long kept up to it. */
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
 * and between them the lines that look like an error. A line says how many went. An excerpt read again does not change.
 */
export function logExcerpt(output: string, max = LOG_EXCERPT_MAX): string {
  const text = output.replace(ANSI, '');
  if (text.length <= max) return text;
  const room = max - MARKS;
  // A runner can print everything on one line: cut in pieces, its end stays reachable.
  const piece = Math.floor(room / 8);
  const lines = text.split('\n').flatMap((l) => (l.length <= piece ? [l] : (l.match(new RegExp(`[\\s\\S]{1,${piece}}`, 'g')) ?? [])));
  const head = fit(lines, Math.floor(room / 8));
  const rest = lines.slice(head.kept.length);
  const tail = fit([...rest].reverse(), Math.floor(room / 2));
  const middle = rest.slice(0, rest.length - tail.kept.length);
  const useful = fit(middle.filter((l) => USEFUL.test(l)), room - head.used - tail.used);
  const went = middle.length - useful.kept.length;
  return [...head.kept, ...(went ? [`[… ${went} lignes coupées …]`] : []), ...useful.kept, ...tail.kept.reverse()].join('\n');
}
