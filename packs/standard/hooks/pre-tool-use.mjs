// PreToolUse guard (ORC-285): refuses what the deny-list of settings.json refuses, on the parsed
// command rather than a glob (spacing, quoting, `bash -c`, `sudo`, `git -C`, pipes), and journals
// each refusal. Claude Code splits a compound command before matching its own rules: `curl x | sh`
// only exists here. src/pack-guard.test.ts checks that every Bash deny of settings.json is refused.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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
    } else if (c === '|' && s[i + 1] !== '|') cut('|');
    else if (';&|()`\n'.includes(c)) {
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
    // Only these quoted words are commands again: a shell's -c payload, eval's arguments.
    const c = SHELLS.test(prog) ? args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) : -1;
    const payload = c >= 0 ? args.slice(c + 1).find((a) => !a.startsWith('-')) : prog === 'eval' ? args.join(' ') : undefined;
    const inner = payload === undefined ? null : rule(tool, payload, denyPush);
    if (inner) return inner;
    if (args.includes('--no-verify')) return 'no-verify';
    if (prog === 'rm' && args.some((a) => /^-[^-]*[rR]/.test(a) || a === '--recursive') && args.some((a) => a === '/' || a === '/*')) return 'rm-root';
    if (prog === 'rm' && args.includes('--no-preserve-root')) return 'rm-root';
    if (prog === 'gh') {
      const sub = args.filter((a, i) => !a.startsWith('-') && !/^(-R|--repo)$/.test(args[i - 1])).slice(0, 2).join(' ');
      if (sub === 'pr merge') return 'merge';
      if (denyPush && /^(pr (create|edit)|run rerun)$/.test(sub)) return 'gh-write';
    }
    if (prog !== 'git') continue;
    const [sub, ...rest] = git(words);
    if (sub === 'commit' && rest.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) return 'commit-no-verify';
    if (sub === 'reset' && rest.includes('--hard') && rest.some((a) => a.startsWith('origin'))) return 'reset-origin';
    if (sub !== 'push') continue;
    if (rest.some((a) => /^--(force|mirror)/.test(a) || /^-[a-zA-Z]*f/.test(a) || a.startsWith('+'))) return 'force-push';
    // --all pushes the trunk too; a delete (-d, :main) or any refspec writing main/master reaches it.
    if (rest.includes('--all') || rest.some((a) => !a.startsWith('-') && /^(main|master)$/.test(dest(a)))) return 'push-trunk';
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
