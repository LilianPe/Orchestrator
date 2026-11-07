// Deterministic scan of the diff `baseSha..SHA` against the four forms of cheating (ORC-158). No model: a finding is
// a pattern on an ADDED line, so a removed line never blocks. Every finding blocks `factory/anti-triche`.
import { parseDiff, type DiffFile } from './diff.js';
import { mdCode } from './markdown.js';
import { isTestFile, isTestHarnessFile, normalizePath } from './test-files.js';
import type { CheckResult } from './types.js';

export const ANTI_CHEAT_CHECK = 'factory/anti-triche';
/** The check's summary when the diff shows none of the four forms. */
export const ANTI_CHEAT_OK = 'aucun test désactivé, aucun contournement';

/** 1: a frozen acceptance test changed; 2: a test disabled; 3: a check bypassed; 4: code that behaves differently under test. */
export type CheatForm = 'frozen-test' | 'disabled-test' | 'bypass' | 'test-only-behaviour';

export interface CheatFinding {
  file: string;
  /** Line in the new version of the file; absent for a deleted or renamed frozen test. */
  line?: number;
  form: CheatForm;
  /** What was found: the matched text, or what happened to the frozen test. */
  match: string;
}

export interface AntiCheatOptions {
  /** Paths of the frozen acceptance tests (ORC-131): any change to one of them is a finding, whatever the change. */
  frozenTests?: Iterable<string>;
}

export interface AntiCheatResult extends CheckResult {
  findings: CheatFinding[];
}

type Lang = 'js' | 'py' | 'other';

/** A test file, the test runner's configuration and global setup, or anything else. */
type FileKind = 'test' | 'harness' | 'code';

/** What a piece of a JS or Python line is: code, a string literal, a regex literal (JS) or a comment. */
type Kind = 'code' | 'string' | 'regex' | 'comment';
type Token = [kind: Kind, from: number, to: number];

interface Rule {
  form: Exclude<CheatForm, 'frozen-test'>;
  /** Default: every language. */
  langs?: Lang[];
  pattern: RegExp;
  /** Default: every kind of file. Test files are left out of the rules their fixtures quote. */
  in?: FileKind[];
  /**
   * In JS and Python a rule reads code only: string and regex literals and comments are blanked, so a line that
   * quotes a pattern (a fixture, a scanner's own regex, a comment stating a rule) is not a finding. `comment` also
   * reads comments, where checker directives live; `string` also reads string literals, where commands and
   * environment variable names live. Other files (JSON, shell, YAML...) are read whole.
   */
  keep?: 'comment' | 'string';
}

const RULES: Rule[] = [
  // 2. Disabling. `t.skip()` and `context.only` are common outside tests (parsers, React contexts): tests only.
  { form: 'disabled-test', langs: ['js'], in: ['test'], pattern: /\b(?:it|test|describe|suite|context|bench)(?:\.\w+)*\.(?:skip|only|todo|skipIf|runIf)\b/ },
  { form: 'disabled-test', langs: ['js'], in: ['test'], pattern: /\b(?:ctx|t|this)\.skip\s*\(/ },
  { form: 'disabled-test', langs: ['js'], pattern: /(?<![\w.$])x(?:it|describe|test)\s*\(/ },
  // `fit` and `fdescribe` focus like `.only`; outside tests, `fit(` is too often a real function.
  { form: 'disabled-test', langs: ['js'], in: ['test'], pattern: /(?<![\w.$])f(?:it|describe)\s*\(/ },
  { form: 'disabled-test', langs: ['py'], pattern: /\bpytest\.mark\.(?:skip|skipif|xfail)\b/ },
  { form: 'disabled-test', langs: ['py'], pattern: /\bpytest\.(?:skip|xfail)\s*\(/ },
  { form: 'disabled-test', langs: ['py'], pattern: /\bunittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|^\s*@(?:skip|skipIf|skipUnless|expectedFailure)\b|\bself\.skipTest\s*\(/ },
  // Tests left out by the runner: jest's ignore list, pytest's `--deselect`. Vitest's `exclude` is not read: the same
  // key leaves files out of coverage.
  { form: 'disabled-test', in: ['harness', 'code'], keep: 'string', pattern: /\btestPathIgnorePatterns\b|--deselect\b/ },
  // 3. Bypasses. Tests run `git commit --no-verify` in throwaway repositories: not a bypass of this one.
  { form: 'bypass', in: ['harness', 'code'], keep: 'string', pattern: /--no-verify\b/ },
  // A checker directive only acts at the start of a comment. All three TypeScript ones silence the type checker.
  { form: 'bypass', langs: ['js', 'other'], keep: 'comment', pattern: /(?<=(?:\/\/|\/\*|^\s*\*)\s*)eslint-disable\b/ },
  { form: 'bypass', langs: ['js', 'other'], keep: 'comment', pattern: /(?<=(?:\/\/|\/\*|^\s*\*)[\s/*]*)@ts-(?:ignore|nocheck|expect-error)\b/ },
  { form: 'bypass', langs: ['py'], keep: 'comment', pattern: /#\s*(?:type|pyright):\s*ignore\b/ },
  { form: 'bypass', langs: ['py'], keep: 'comment', pattern: /#\s*noqa\b/i },
  // Emptied assertions: an assertion on a constant, true whatever the code does.
  { form: 'bypass', langs: ['js'], pattern: /\bexpect\s*\(\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`$]*`)\s*\)/ },
  { form: 'bypass', langs: ['js'], pattern: /(?<![\w.$])assert(?:\.ok)?\s*\(\s*(?:true|1|!0)\s*[,)]/ },
  { form: 'bypass', langs: ['py'], pattern: /^\s*assert\s+(?:True|1|not\s+(?:False|None|0)|'[^']*'|"[^"]*")\s*(?:,|#|$)|\bself\.assertTrue\s*\(\s*True\s*[,)]/ },
  // Leaving with success before the tests can fail. Shell `exit 0` is not scanned: too common in real scripts.
  { form: 'bypass', langs: ['js', 'py'], pattern: /(?<![\w.$])(?:process\.|sys\.|os\._)?exit\s*\(\s*0?\s*\)/ },
  // 4. Code that behaves differently under test, outside tests only: a pattern list, false negatives accepted.
  { form: 'test-only-behaviour', langs: ['js', 'py'], in: ['code'], keep: 'string', pattern: /\b(?:NODE_ENV|env\.MODE)\b.*(['"`])test\1|(['"`])test\2.*\b(?:NODE_ENV|env\.MODE)\b/ },
  { form: 'test-only-behaviour', langs: ['js', 'py'], in: ['code'], keep: 'string', pattern: /\b(?:VITEST(?:_[A-Z_]+)?|JEST_WORKER_ID|PYTEST_CURRENT_TEST)\b/ },
  { form: 'test-only-behaviour', langs: ['py'], in: ['code'], keep: 'string', pattern: /\bsys\.modules\b.*(['"])pytest\1|(['"])pytest\2.*\bsys\.modules\b/ },
];

const FORM_LABEL: Record<CheatForm, string> = {
  'frozen-test': "test d'acceptation gelé modifié",
  'disabled-test': 'test désactivé',
  bypass: 'contournement',
  'test-only-behaviour': 'comportement différent sous test',
};

// Documentation may quote any of the patterns: it is never scanned, agent instructions (`CLAUDE.md`, `SKILL.md`)
// included. Prose cannot tell "never pass --no-verify" from "pass --no-verify", and the pack denies the command anyway.
const PROSE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;

// A Claude Code permission rule (`"Bash(git commit --no-verify:*)"`) in a settings file names a command without
// running it, and deny wins over allow at every settings level: such a rule cannot lift the pack's deny.
const CLAUDE_SETTINGS = /(?:^|\/)settings(?:\.local)?\.json$/;
const PERMISSION_RULE = /^\s*"\w+\(.*\)"\s*,?\s*$/;

function lang(path: string): Lang {
  if (/\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/.test(path)) return 'js';
  if (/\.pyi?$/.test(path)) return 'py';
  return 'other';
}

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'delete', 'throw', 'new']);

// A `/` at `i` opens a regex literal, not a division, after nothing, an operator, an opening bracket or a keyword.
// Reads back from `i` without copying the line: a minified line has thousands of `/`.
function regexMayStart(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j]!)) j--;
  if (j < 0) return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(text[j]!)) return true;
  let k = j;
  while (k >= 0 && /\w/.test(text[k]!)) k--;
  return KEYWORDS_BEFORE_REGEX.has(text.slice(k + 1, j + 1));
}

// End of the literal opened at `i`: a string or template up to its unescaped closing quote, a regex up to its
// closing `/` (outside a character class) and its flags. An unterminated literal runs to the end of the line.
function literalEnd(text: string, i: number, regex: boolean): number {
  const close = text[i]!;
  let inClass = false;
  for (i++; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\') i++;
    else if (regex && (c === '[' || c === ']')) inClass = c === '[';
    else if (c === close && !inClass) {
      i++;
      if (regex) while (i < text.length && /\w/.test(text[i]!)) i++;
      return i;
    }
  }
  return text.length;
}

/**
 * One line cut into code, literals and comments. Line by line, without state: a string or a comment spanning lines
 * reads as code on its next lines, except a JS line starting with `*` (the middle of a block comment).
 */
function tokenize(text: string, l: Exclude<Lang, 'other'>): Token[] {
  if (l === 'js' && /^\s*\*/.test(text)) return [['comment', 0, text.length]];
  const tokens: Token[] = [];
  const push = (kind: Kind, from: number, to: number): void => {
    const last = tokens.at(-1);
    if (kind === 'code' && last?.[0] === 'code') last[2] = to;
    else tokens.push([kind, from, to]);
  };
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    let kind: Kind = 'code';
    let to = i + 1;
    if ((l === 'py' && c === '#') || (l === 'js' && text.startsWith('//', i))) [kind, to] = ['comment', text.length];
    else if (l === 'js' && text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      [kind, to] = ['comment', close === -1 ? text.length : close + 2];
    } else if (c === "'" || c === '"' || (l === 'js' && c === '`')) [kind, to] = ['string', literalEnd(text, i, false)];
    else if (l === 'js' && c === '/' && regexMayStart(text, i)) [kind, to] = ['regex', literalEnd(text, i, true)];
    push(kind, i, to);
    i = to;
  }
  return tokens;
}

// The line with every literal and comment blanked but `keep`, at the same length so a match maps back to the line.
// A blanked string keeps its quotes (`expect('')` still asserts on a constant), a blanked template its `$`.
function view(text: string, tokens: Token[], keep: Kind | undefined): string {
  let out = '';
  for (const [kind, from, to] of tokens) {
    const part = text.slice(from, to);
    if (kind === 'code' || kind === keep) out += part;
    else if (kind === 'string') {
      const inner = part.slice(1, -1);
      out += part[0] + (part[0] === '`' ? inner.replace(/[^$]/g, ' ') : ' '.repeat(inner.length)) + (part.length > 1 ? part.at(-1) : '');
    }
    else out += ' '.repeat(part.length);
  }
  return out;
}

// Only a change to the frozen path itself: a copy of a frozen test leaves it as it was.
function frozenChange(file: DiffFile, frozen: Set<string>): CheatFinding | undefined {
  if (file.status === 'renamed' && frozen.has(file.oldPath!)) return { file: file.oldPath!, form: 'frozen-test', match: `renommé en ${file.path}` };
  if (!frozen.has(file.path)) return undefined;
  if (file.status === 'deleted') return { file: file.path, form: 'frozen-test', match: 'supprimé' };
  const first = file.added[0]?.line;
  return { file: file.path, ...(first !== undefined ? { line: first } : {}), form: 'frozen-test', match: 'modifié' };
}

export function scanDiff(diff: string, options: AntiCheatOptions = {}): CheatFinding[] {
  const frozen = new Set([...(options.frozenTests ?? [])].map(normalizePath));
  const findings: CheatFinding[] = [];
  for (const file of parseDiff(diff)) {
    const frozenFinding = frozenChange(file, frozen);
    if (frozenFinding) findings.push(frozenFinding);
    if (PROSE.test(file.path)) continue;
    const l = lang(file.path);
    const kind: FileKind = isTestFile(file.path) ? 'test' : isTestHarnessFile(file.path) ? 'harness' : 'code';
    const rules = RULES.filter((r) => (r.langs?.includes(l) ?? true) && (r.in?.includes(kind) ?? true));
    const settings = CLAUDE_SETTINGS.test(file.path);
    for (const { line, text } of file.added) {
      if (settings && PERMISSION_RULE.test(text)) continue;
      // Other files are read whole: no tokens, the line itself is every view.
      const tokens = l === 'other' ? undefined : tokenize(text, l);
      const views: Partial<Record<Kind, string>> = {};
      for (const rule of rules) {
        const m = rule.pattern.exec(tokens ? (views[rule.keep ?? 'code'] ??= view(text, tokens, rule.keep)) : text);
        if (m) findings.push({ file: file.path, line, form: rule.form, match: text.slice(m.index, m.index + m[0].length).trim() });
      }
    }
  }
  return findings;
}

// GitHub refuses a check run summary over 65,535 characters; a long matched line is cut as well.
const SUMMARY_LIMIT = 65_535;
const MATCH_LIMIT = 200;

function describeFinding(f: CheatFinding): string {
  const where = f.line === undefined ? f.file : `${f.file}:${f.line}`;
  const match = f.match.length > MATCH_LIMIT ? `${f.match.slice(0, MATCH_LIMIT)}…` : f.match;
  return `- ${mdCode(where)} : ${FORM_LABEL[f.form]} (${f.form === 'frozen-test' ? match : mdCode(match)})`;
}

function summarize(findings: CheatFinding[]): string {
  const lines = [findings.length === 1 ? '1 constat :' : `${findings.length} constats :`];
  let size = lines[0]!.length;
  for (const [i, f] of findings.entries()) {
    const line = describeFinding(f);
    const left = findings.length - i;
    // Keep room for the closing "… et N autres" line.
    if (size + 1 + line.length + (left > 1 ? 40 : 0) > SUMMARY_LIMIT) {
      lines.push(`… et ${left} autres`);
      break;
    }
    lines.push(line);
    size += 1 + line.length;
  }
  return lines.join('\n');
}

/** The `factory/anti-triche` check run: success only when the diff shows none of the four forms. */
export function antiCheatCheck(diff: string, options: AntiCheatOptions = {}): AntiCheatResult {
  const findings = scanDiff(diff, options);
  const ok = findings.length === 0;
  return { check: ANTI_CHEAT_CHECK, ok, summary: ok ? ANTI_CHEAT_OK : summarize(findings), findings };
}
