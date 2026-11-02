// PreToolUse guard (ORC-285): refuses what the deny-list of settings.json refuses, on the parsed
// command rather than a glob (spacing, quoting, `bash -c`, `sudo`, `git -C`, pipes), and journals
// each refusal. Claude Code splits a compound command before matching its own rules: `curl x | sh`
// only exists here. src/pack-guard.test.ts checks that every Bash deny of settings.json is refused.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Shell words and operators; a quoted word holding spaces is parsed again (`bash -c "…"`, `-m "…"`). */
function commands(s) {
  const out = [];
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
    if (c === "'" || c === '"') {
      const close = s.indexOf(c, i + 1);
      const inner = close < 0 ? s.slice(i + 1) : s.slice(i + 1, close);
      w = (w ?? '') + inner;
      if (/\s/.test(inner)) out.push(...commands(inner));
      i = close < 0 ? s.length : close;
    } else if (c === '\\') w = (w ?? '') + (s[++i] ?? '');
    else if (/\s/.test(c) && c !== '\n') end();
    else if (c === '|' && s[i + 1] !== '|') cut('|');
    else if (';&|()`\n'.includes(c)) {
      const twice = '|&'.includes(c) && s[i + 1] === c;
      cut(twice ? c + c : c);
      if (twice) i++;
    }
    else w = (w ?? '') + c;
  }
  cut('');
  return out;
}

/** Drops `FOO=bar`, `sudo`, `env`… in front of the program. */
function strip(words) {
  let i = 0;
  while (i < words.length && (/^\w+=/.test(words[i]) || /^(sudo|env|command|exec|nohup|time|xargs)$/.test(words[i]))) i++;
  return words.slice(i);
}

/** `git -C repo -c k=v push x` → ['push', 'x']. */
function git(words) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += /^-[Cc]$/.test(words[i]) ? 2 : 1;
  return words.slice(i);
}

const SHELLS = /^(sh|bash|zsh|dash|ksh)$/;
const FETCH = /^(curl|wget)$/;

function rule(tool, command, denyPush) {
  if (tool === 'WebSearch') return 'web-search';
  if (/--no-verify/.test(command)) return 'no-verify';
  if (/docker\.sock|podman\.sock|DOCKER_HOST|CONTAINER_HOST/.test(command)) return 'container-socket';
  if (/\b(sh|bash|zsh|dash|ksh)\b[^|;&]*[<$]\(\s*(curl|wget)\b/.test(command)) return 'pipe-to-shell';
  let fetched = false;
  for (const { op, words: raw } of commands(command)) {
    const words = strip(raw);
    const prog = basename(words[0] ?? '');
    const args = words.slice(1);
    fetched = (op === '|' && fetched) || FETCH.test(prog);
    if (op === '|' && fetched && SHELLS.test(prog)) return 'pipe-to-shell';
    if (args.includes('--no-verify')) return 'no-verify';
    if (prog === 'rm' && args.some((a) => /^-[^-]*[rR]/.test(a) || a === '--recursive') && args.some((a) => a === '/' || a === '/*')) return 'rm-root';
    if (prog === 'rm' && args.includes('--no-preserve-root')) return 'rm-root';
    if (prog === 'gh') {
      const sub = args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ');
      if (sub === 'pr merge') return 'merge';
      if (denyPush && /^(pr (create|edit)|run rerun)$/.test(sub)) return 'gh-write';
    }
    if (prog !== 'git') continue;
    const [sub, ...rest] = git(words);
    if (sub === 'commit' && rest.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) return 'commit-no-verify';
    if (sub === 'reset' && rest.includes('--hard') && rest.some((a) => a.startsWith('origin'))) return 'reset-origin';
    if (sub !== 'push') continue;
    if (rest.some((a) => /^--force/.test(a) || /^-[a-zA-Z]*f/.test(a) || a.startsWith('+'))) return 'force-push';
    if (rest.some((a) => /(^|:|refs\/heads\/)(main|master)$/.test(a))) return 'push-trunk';
    if (denyPush) return 'push';
  }
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
const command = String(input.command ?? input.query ?? '');
const hit = rule(tool, command, process.env.FACTORY_DENY_PUSH === '1');
if (hit) {
  journal({ at: new Date().toISOString(), tool, command, rule: hit });
  const permissionDecisionReason = `Refusé par l'usine (règle ${hit}) : cette commande est interdite dans un run.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason } }));
}
