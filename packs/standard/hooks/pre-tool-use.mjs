// PreToolUse guard (ORC-285): refuses what the deny-list of settings.json refuses, on the parsed
// command rather than a glob (spacing, quoting, `bash -c`, `sudo`, `git -C`, pipes), and journals
// each refusal. Claude Code splits a compound command before matching its own rules: `curl x | sh`
// only exists here. src/pack-guard.test.ts checks that every Bash deny of settings.json is refused.
// A guard against an agent's mistakes, not a barrier: a command written otherwise gets past it. A push fails for want
// of means, a sandbox without token, or on the host a git config that sends every push nowhere (ORC-349).
// It also refuses a whole read of a large file (ORC-279): a question of tokens, see fullRead.
// And any tool off the step's list (ORC-383), behind `claude --tools`: see offList.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** Shell words and operators. Quoted text is data, except a `$(…)` or `` `…` `` inside double quotes. */
function commands(s) {
  const out = [];
  const subs = [];
  let words = [];
  let op = '';
  let w = null;
  const end = () => {
    if (w !== null) words.push(w);
    w = null;
  };
  const cut = (next) => {
    end();
    if (words.length) out.push({ op, words });
    words = [];
    op = next;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      w = (w ?? '') + (close < 0 ? s.slice(i + 1) : s.slice(i + 1, close));
      i = close < 0 ? s.length : close;
    } else if (c === '"') {
      w = w ?? '';
      for (i++; i < s.length && s[i] !== '"'; i++) {
        // POSIX: inside double quotes a backslash only escapes " \ $ ` and newline (a continuation).
        if (s[i] === '\\' && '"\\$`\n'.includes(s[i + 1])) {
          if (s[++i] !== '\n') w += s[i];
        } else if (s[i] === '`' || (s[i] === '$' && s[i + 1] === '(')) {
          // The shell runs a substitution even in double quotes: its commands are judged too.
          const tick = s[i] === '`';
          let j = tick ? s.indexOf('`', i + 1) : i + 2;
          for (let depth = 1; !tick && j < s.length; j++) {
            depth += s[j] === '(' ? 1 : s[j] === ')' ? -1 : 0;
            if (!depth) break;
          }
          if (j < 0) j = s.length;
          subs.push(...commands(s.slice(i + (tick ? 1 : 2), j)));
          w += s.slice(i, j + 1);
          i = j;
        } else w += s[i];
      }
    } else if (c === '\\') {
      if (s[++i] !== '\n') w = (w ?? '') + (s[i] ?? ''); // backslash-newline joins the lines
    } else if (/\s/.test(c) && c !== '\n') end();
    else if (c === '|' && s[i + 1] === '&') {
      cut('|'); // |& pipes stdout and stderr
      i++;
    } else if (';&|()`\n'.includes(c)) {
      const twice = '|&'.includes(c) && s[i + 1] === c;
      cut(twice ? c + c : c);
      if (twice) i++;
    }
    else w = (w ?? '') + c;
  }
  cut('');
  return [...out, ...subs];
}

/** Prefix commands and their options taking a value; `timeout` also takes its duration. */
const PREFIX = {
  sudo: /^-[ugCDhprtUT]$|^--(user|group|chdir|host|prompt|role|type|other-user|close-from)$/,
  env: /^-[uCS]$|^--(unset|chdir|split-string)$/,
  command: null,
  exec: /^-a$/,
  nohup: null,
  time: null,
  nice: /^-n$|^--adjustment$/,
  timeout: /^-[sk]$|^--(signal|kill-after)$/,
  xargs: /^-[IdELnPsa]$|^--(replace|delimiter|eof|max-lines|max-args|max-procs|max-chars|arg-file)$/,
};

/** Drops `FOO=bar`, `sudo -u x`, `env -i`, `timeout 10`… in front of the program. */
function strip(words) {
  let i = 0;
  while (i < words.length) {
    if (/^\w+=/.test(words[i])) i++;
    else if (Object.hasOwn(PREFIX, basename(words[i]))) {
      const prog = basename(words[i++]);
      for (; i < words.length && words[i].startsWith('-'); i++) {
        if (words[i] === '--') { i++; break; }
        if (PREFIX[prog]?.test(words[i])) i++;
      }
      if (prog === 'timeout') i++;
    } else break;
  }
  return words.slice(i);
}

/** `git -C repo --git-dir .git push x` → ['push', 'x']. */
function git(words) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-'))
    i += /^(-[Cc]|--(git-dir|work-tree|namespace|super-prefix|config-env|attr-source))$/.test(words[i]) ? 2 : 1;
  return words.slice(i);
}

/** The ref a push refspec writes: `+HEAD:refs/heads/main` → `main`. */
const dest = (spec) => spec.replace(/^\+/, '').split(':').pop().replace(/^(refs\/)?heads\//, '');

const SHELL_NAMES = 'sh|bash|zsh|dash|ksh';
const FETCH_NAMES = 'curl|wget';
const SHELLS = new RegExp(`^(${SHELL_NAMES})$`);
const FETCH = new RegExp(`^(${FETCH_NAMES})$`);
/** `bash <(curl …)`, `sh -c "$(wget …)"`: a fetch substituted into a shell, matched on the raw command. */
const SUBST_TO_SHELL = new RegExp(String.raw`\b(${SHELL_NAMES})\b[^|;&]*[<$]\(\s*(${FETCH_NAMES})\b`);

function rule(tool, command) {
  if (tool === 'WebSearch') return 'web-search';
  if (/--no-verify/.test(command)) return 'no-verify';
  if (/docker\.sock|podman\.sock|DOCKER_HOST|CONTAINER_HOST/.test(command)) return 'container-socket';
  if (SUBST_TO_SHELL.test(command)) return 'pipe-to-shell';
  let fetched = false;
  for (const { op, words: raw } of commands(command)) {
    const words = strip(raw);
    const prog = basename(words[0] ?? '');
    const args = words.slice(1);
    fetched = (op === '|' && fetched) || FETCH.test(prog);
    if (op === '|' && fetched && SHELLS.test(prog)) return 'pipe-to-shell';
    // Only these quoted words are commands again: a shell's -c payload, eval's arguments.
    const c = SHELLS.test(prog) ? args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) : -1;
    const payload = c >= 0 ? args.slice(c + 1).find((a) => !a.startsWith('-')) : prog === 'eval' ? args.join(' ') : undefined;
    const inner = payload === undefined ? null : rule(tool, payload);
    if (inner) return inner;
    if (args.includes('--no-verify')) return 'no-verify';
    if (prog === 'rm' && (args.includes('--no-preserve-root')
      || (args.some((a) => /^-[^-]*[rR]/.test(a) || a === '--recursive') && args.some((a) => a === '/' || a === '/*')))) return 'rm-root';
    if (prog === 'gh') {
      const sub = args.filter((a, i) => !a.startsWith('-') && !/^(-R|--repo)$/.test(args[i - 1])).slice(0, 2).join(' ');
      if (sub === 'pr merge') return 'merge';
      if (/^(pr (create|edit)|run rerun)$/.test(sub)) return 'gh-write';
    }
    if (prog !== 'git') continue;
    const [sub, ...rest] = git(words);
    if (sub === 'commit' && rest.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) return 'commit-no-verify';
    if (sub === 'reset' && rest.includes('--hard') && rest.some((a) => a.startsWith('origin'))) return 'reset-origin';
    if (sub !== 'push') continue;
    if (rest.some((a) => /^--(force|mirror)/.test(a) || /^-[a-zA-Z]*f/.test(a) || a.startsWith('+'))) return 'force-push';
    // --all pushes the trunk too; a delete (-d, :main) or any refspec writing main/master reaches it.
    if (rest.includes('--all') || rest.some((a) => !a.startsWith('-') && /^(main|master)$/.test(dest(a)))) return 'push-trunk';
    // Only the factory publishes (ORC-125): the two rules above name what would have been worst, for the journal.
    return 'push';
  }
  return null;
}

const envMaxLines = Number(process.env.FACTORY_READ_MAX_LINES);
const READ_MAX_LINES = Number.isInteger(envMaxLines) && envMaxLines > 0 ? envMaxLines : 350;
/** Read gives these whole or by `pages`: `offset` and `limit` mean nothing for them. */
const NOT_BY_LINES = /\.(png|jpe?g|gif|webp|pdf|ipynb)$/i;

/** Past `max` lines? Stops reading as soon as it knows. A file with a NUL in its first block is binary: not counted. */
function longerThan(file, max) {
  const fd = openSync(file, 'r');
  try {
    const block = Buffer.alloc(65536);
    let newlines = 0;
    let last = 10; // an empty file has no line left open
    for (let first = true, n; (n = readSync(fd, block)) > 0; first = false) {
      const read = block.subarray(0, n);
      if (first && read.includes(0)) return false;
      for (let i = read.indexOf(10); i >= 0; i = read.indexOf(10, i + 1)) if (++newlines > max) return true;
      last = read[n - 1];
    }
    return newlines + (last === 10 ? 0 : 1) > max;
  } finally {
    closeSync(fd);
  }
}

/** The path behind any symlink: Claude Code's cwd is the real one, the factory's list may not be. */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * A whole read of a large file (ORC-279): it costs tokens, it breaks nothing. So this fails open, unlike
 * the commands above: whatever cannot be judged passes, and Read answers for itself. `allow_large` is
 * no targeted read. `FACTORY_FULL_READ_PATHS` is the factory's list of absolute paths read whole.
 */
function fullRead(input) {
  try {
    const file = input.file_path;
    if (typeof file !== 'string' || input.offset != null || input.limit != null || NOT_BY_LINES.test(file)) return null;
    // A FIFO would block the open; a directory is Read's to answer.
    if (!statSync(file).isFile() || !longerThan(file, READ_MAX_LINES)) return null;
    const whole = JSON.parse(process.env.FACTORY_FULL_READ_PATHS || '[]');
    if (whole.map(real).includes(real(file))) return null;
    return 'full-read';
  } catch {
    return null;
  }
}

/**
 * The run's built-in tools, comma-separated (`FACTORY_TOOLS`, ORC-383), the factory's MCP tools always beside them: any other
 * tool is refused. Unset: a run with every tool, nothing to check.
 */
const TOOLS = process.env.FACTORY_TOOLS?.split(',').filter(Boolean);
function offList(tool) {
  if (TOOLS && !tool.startsWith('mcp__factory__') && !TOOLS.includes(tool)) return 'tool-not-allowed';
  return null;
}

function journal(entry) {
  const env = process.env;
  const file =
    env.FACTORY_REFUSALS_LOG ||
    join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'factory-refusals.jsonl');
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    // ponytail: a lost journal line never blocks the session; the refusal itself still applies.
  }
}

let call = {};
try {
  call = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  // Unparseable input: nothing to judge, Claude Code's own rules still apply.
}
const tool = call.tool_name ?? '';
const input = call.tool_input ?? {};
const command = String(input.command ?? input.query ?? input.file_path ?? '');
/** The rule that refuses the call, in order: a web search, a tool off the step's list, a whole read of a large file, a forbidden command. */
function judge() {
  // Its own rule, which no step's list lifts.
  if (tool === 'WebSearch') return rule(tool, command);
  const off = offList(tool);
  if (off) return off;
  if (tool === 'Read') return fullRead(input);
  // The command rules judge a shell command: an edit's path or another tool's input is no command.
  if (tool === 'Bash') return rule(tool, command);
  return null;
}

const REASONS = {
  'full-read': () => `this file is longer than ${READ_MAX_LINES} lines. Find what you need with grep, then read the useful range with offset and limit.`,
  'tool-not-allowed': () => `${tool} is not a tool of this step, which has ${TOOLS.join(', ') || 'none'} and the factory's MCP tools.`,
};

const hit = judge();
if (hit) {
  journal({ at: new Date().toISOString(), tool, command, rule: hit, ticket: process.env.FACTORY_TICKET ?? null });
  const permissionDecisionReason = `Refused by the factory (rule ${hit}): ${REASONS[hit]?.() ?? 'this command is forbidden in a run.'}`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason } }));
}
