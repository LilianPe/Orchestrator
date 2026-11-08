// Deterministic scan of the diff `baseSha..SHA` against the four forms of cheating (ORC-158), and the tests it removes
// (ORC-342). No model. JS and TS files are read on their syntax tree (ORC-342), Python and the other files line by line;
// either way a finding is something on an ADDED line, so a removed line never blocks. A test the diff removes or
// renames, by file or by case, is a finding unless a commit of the branch justifies it. Every finding blocks
// `factory/anti-triche`.
import { scanScript, scriptTests, type FileKind } from './anti-cheat-ast.js';
import { parseDiff, type DiffFile } from './diff.js';
import { mdCode } from './markdown.js';
import { isTestFile, isTestHarnessFile, isTestSpec, normalizePath } from './test-files.js';
import { isScript } from './ts-ast.js';
import type { CheckResult } from './types.js';

export const ANTI_CHEAT_CHECK = 'factory/anti-triche';
/** The check's summary when the diff shows none of the four forms. */
export const ANTI_CHEAT_OK = 'no disabled test, no workaround';

/**
 * 1: a frozen acceptance test changed; 2: a test disabled; 3: a check bypassed; 4: code that behaves differently under
 * test. And a test removed or renamed (ORC-342).
 */
export type CheatForm = 'frozen-test' | 'disabled-test' | 'bypass' | 'test-only-behaviour' | 'removed-test';

export interface CheatFinding {
  file: string;
  /** Line in the new version of the file; absent for a deleted or renamed frozen test, and a removed test. */
  line?: number;
  form: CheatForm;
  /** What was found: the matched text, what happened to the frozen test, or the removed test's name. */
  match: string;
}

export interface AntiCheatOptions {
  /** Paths of the frozen acceptance tests (ORC-131): any change to one of them is a finding, whatever the change. */
  frozenTests?: Iterable<string>;
  /** Test files the diff deletes and does not show, with their content before it: their tests are removed. */
  deletedTests?: Readonly<Record<string, string>>;
  /** Test files whose removed tests a commit of the branch justifies (`justifiedRemovals`). */
  justified?: Iterable<string>;
}

export interface AntiCheatResult extends CheckResult {
  findings: CheatFinding[];
}

/** A file read line by line: Python, or anything else (JSON, shell, YAML...), read whole. */
type Lang = 'py' | 'other';

/** What a piece of a Python line is: code, a string literal or a comment. */
type Kind = 'code' | 'string' | 'comment';
type Token = [kind: Kind, from: number, to: number];

interface Rule {
  form: Exclude<CheatForm, 'frozen-test' | 'removed-test'>;
  /** Default: every language. */
  langs?: Lang[];
  pattern: RegExp;
  /** Default: every kind of file. Test files are left out of the rules their fixtures quote. */
  in?: FileKind[];
  /**
   * In Python a rule reads code only: string literals and comments are blanked, so a line that quotes a pattern (a
   * fixture, a comment stating a rule) is not a finding. `comment` also reads comments, where checker directives live;
   * `string` also reads string literals, where commands and environment variable names live. Other files are read whole.
   */
  keep?: 'comment' | 'string';
}

// The rules of the files without a syntax tree here. JS and TS: `anti-cheat-ast.ts`.
const RULES: Rule[] = [
  // 2. Disabling.
  { form: 'disabled-test', langs: ['py'], pattern: /\bpytest\.mark\.(?:skip|skipif|xfail)\b/ },
  { form: 'disabled-test', langs: ['py'], pattern: /\bpytest\.(?:skip|xfail)\s*\(/ },
  { form: 'disabled-test', langs: ['py'], pattern: /\bunittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|^\s*@(?:skip|skipIf|skipUnless|expectedFailure)\b|\bself\.skipTest\s*\(/ },
  // Tests left out by the runner: jest's ignore list, pytest's `--deselect`.
  { form: 'disabled-test', in: ['harness', 'code'], keep: 'string', pattern: /\btestPathIgnorePatterns\b|--deselect\b/ },
  // 3. Bypasses. Tests run `git commit --no-verify` in throwaway repositories: not a bypass of this one.
  { form: 'bypass', in: ['harness', 'code'], keep: 'string', pattern: /--no-verify\b/ },
  // A checker directive only acts at the start of a comment.
  { form: 'bypass', langs: ['other'], pattern: /(?<=(?:\/\/|\/\*|^\s*\*)\s*)eslint-disable\b/ },
  { form: 'bypass', langs: ['other'], pattern: /(?<=(?:\/\/|\/\*|^\s*\*)[\s/*]*)@ts-(?:ignore|nocheck|expect-error)\b/ },
  { form: 'bypass', langs: ['py'], keep: 'comment', pattern: /#\s*type:\s*ignore\b/ },
  // The file-level ones: `# ruff: noqa`, `# flake8: noqa`; mypy's flags (`_` or `-`, several on a line) that drop its
  // errors; pyright's `ignore`, its `basic` mode and its rules turned off.
  { form: 'bypass', langs: ['py'], keep: 'comment', pattern: /#\s*(?:(?:ruff|flake8)\s*:\s*)?noqa\b/i },
  { form: 'bypass', langs: ['py'], keep: 'comment', pattern: /#\s*mypy\s*:.*?\b(?:ignore[-_]errors|disable[-_]error[-_]code)\b/ },
  { form: 'bypass', langs: ['py'], keep: 'comment', pattern: /#\s*pyright\s*:\s*(?:ignore\b|basic\b|report\w+\s*=\s*(?:false|none)\b)/ },
  // Emptied assertions: an assertion on a constant, true whatever the code does.
  { form: 'bypass', langs: ['py'], pattern: /^\s*assert\s+(?:True|1|not\s+(?:False|None|0)|'[^']*'|"[^"]*")\s*(?:,|#|$)|\bself\.assertTrue\s*\(\s*True\s*[,)]/ },
  // Leaving with success before the tests can fail. Shell `exit 0` is not scanned: too common in real scripts.
  { form: 'bypass', langs: ['py'], pattern: /(?<![\w.$])(?:sys\.|os\._)?exit\s*\(\s*0?\s*\)/ },
  // 4. Code that behaves differently under test, outside tests only: a pattern list, false negatives accepted.
  { form: 'test-only-behaviour', langs: ['py'], in: ['code'], keep: 'string', pattern: /\b(?:NODE_ENV|env\.MODE)\b.*(['"])test\1|(['"])test\2.*\b(?:NODE_ENV|env\.MODE)\b/ },
  { form: 'test-only-behaviour', langs: ['py'], in: ['code'], keep: 'string', pattern: /\b(?:VITEST(?:_[A-Z_]+)?|JEST_WORKER_ID|PYTEST_CURRENT_TEST)\b/ },
  { form: 'test-only-behaviour', langs: ['py'], in: ['code'], keep: 'string', pattern: /\bsys\.modules\b.*(['"])pytest\1|(['"])pytest\2.*\bsys\.modules\b/ },
];

const FORM_LABEL: Record<CheatForm, string> = {
  'frozen-test': 'frozen acceptance test changed',
  'disabled-test': 'disabled test',
  bypass: 'workaround',
  'test-only-behaviour': 'different behaviour under test',
  'removed-test': 'test removed or renamed',
};

/** The trailer of a commit message that justifies the tests a diff removes from a file: `Removed-test: <path>: <reason>`. */
export const REMOVED_TEST_TRAILER = 'Removed-test';

// Documentation may quote any of the patterns: it is never scanned, agent instructions (`CLAUDE.md`, `SKILL.md`)
// included. Prose cannot tell "never pass --no-verify" from "pass --no-verify", and the pack denies the command anyway.
const PROSE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;

// A Claude Code permission rule (`"Bash(git commit --no-verify:*)"`) in a settings file names a command without
// running it, and deny wins over allow at every settings level: such a rule cannot lift the pack's deny.
const CLAUDE_SETTINGS = /(?:^|\/)settings(?:\.local)?\.json$/;
const PERMISSION_RULE = /^\s*"\w+\(.*\)"\s*,?\s*$/;

const isPython = (path: string): boolean => /\.pyi?$/.test(path);

/**
 * One Python line cut into code, literals and comments. Line by line, without state: a string spanning lines reads as
 * code on its next lines.
 */
function tokenize(text: string): Token[] {
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
    if (c === '#') [kind, to] = ['comment', text.length];
    else if (c === "'" || c === '"') {
      // Up to the unescaped closing quote; an unterminated literal runs to the end of the line.
      for (to = i + 1; to < text.length && text[to] !== c; to++) if (text[to] === '\\') to++;
      [kind, to] = ['string', Math.min(to + 1, text.length)];
    }
    push(kind, i, to);
    i = to;
  }
  return tokens;
}

// The line with every literal and comment blanked but `keep`, at the same length so a match maps back to the line.
// A blanked string keeps its quotes (`assert ''` still asserts on a constant).
function view(text: string, tokens: Token[], keep: Kind | undefined): string {
  let out = '';
  for (const [kind, from, to] of tokens) {
    const part = text.slice(from, to);
    if (kind === 'code' || kind === keep) out += part;
    else if (kind === 'string') out += part[0] + ' '.repeat(Math.max(part.length - 2, 0)) + (part.length > 1 ? part.at(-1) : '');
    else out += ' '.repeat(part.length);
  }
  return out;
}

/**
 * A version of a file as its diff shows it, its other lines blank: the whole file with full context (`-U` past its
 * length), pieces of it otherwise. In pieces, a line starting with `*` is read as the middle of a block comment.
 */
function versionOf(file: DiffFile, which: 'old' | 'new'): string {
  const lines: (string | undefined)[] = [];
  const put = (n: number, text: string) => (lines[n - 1] = text);
  for (const k of file.kept) put(which === 'new' ? k.line : k.old, k.text);
  for (const l of which === 'new' ? file.added : file.removed) put(l.line, l.text);
  // `includes` reads a hole as undefined.
  const pieces = lines.includes(undefined);
  return Array.from(lines, (text) => (text === undefined ? '' : pieces && /^\s*\*(?!\/)/.test(text) ? `//${text}` : text)).join('\n');
}

// Only a change to the frozen path itself: a copy of a frozen test leaves it as it was.
function frozenChange(file: DiffFile, frozen: Set<string>): CheatFinding | undefined {
  if (file.status === 'renamed' && frozen.has(file.oldPath!)) return { file: file.oldPath!, form: 'frozen-test', match: `renamed to ${file.path}` };
  if (!frozen.has(file.path)) return undefined;
  if (file.status === 'deleted') return { file: file.path, form: 'frozen-test', match: 'deleted' };
  const first = file.added[0]?.line;
  return { file: file.path, ...(first !== undefined ? { line: first } : {}), form: 'frozen-test', match: 'changed' };
}

/**
 * The tests of a Python test file, by name: each `def test*`, under the classes that hold it (`TestScores::test_rounds`).
 * Read by indentation, line by line: no Python parser here, so a `def test` inside a multi-line string counts.
 */
function pythonTests(source: string): string[] {
  const names: string[] = [];
  const classes: { indent: number; name: string }[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    while (classes.length > 0 && classes.at(-1)!.indent >= indent) classes.pop();
    const m = /^\s*(?:class\s+(\w+)|(?:async\s+)?def\s+(test\w*))/.exec(line);
    if (m?.[1]) classes.push({ indent, name: m[1] });
    else if (m?.[2]) names.push([...classes.map((c) => c.name), m[2]].join('::'));
  }
  return names;
}

function testsOf(path: string, source: string): string[] {
  if (isPython(path)) return pythonTests(source);
  return isScript(path) ? scriptTests(path, source) : [];
}

/** The tests of `before` that `after` no longer has, a name declared twice counting twice. */
function removedTests(path: string, before: string, after: string | undefined): CheatFinding[] {
  const left = new Map<string, number>();
  for (const name of after === undefined ? [] : testsOf(path, after)) left.set(name, (left.get(name) ?? 0) + 1);
  const removed: CheatFinding[] = [];
  for (const name of testsOf(path, before)) {
    const n = left.get(name) ?? 0;
    if (n > 0) left.set(name, n - 1);
    else removed.push({ file: path, form: 'removed-test', match: name });
  }
  return removed;
}

/**
 * The test files whose removed tests the commit messages `messages` justify: a `Removed-test: <path>: <reason>` trailer
 * line, the reason not empty, the key in any case.
 */
export function justifiedRemovals(messages: string): string[] {
  const re = new RegExp(`^${REMOVED_TEST_TRAILER}:[ \\t]*(.+?):[ \\t]+\\S`, 'gim');
  return [...messages.matchAll(re)].map((m) => normalizePath(m[1]!.trim()));
}

export function scanDiff(diff: string, options: AntiCheatOptions = {}): CheatFinding[] {
  const frozen = new Set([...(options.frozenTests ?? [])].map(normalizePath));
  const justified = new Set([...(options.justified ?? [])].map(normalizePath));
  const deleted = new Map(Object.entries(options.deletedTests ?? {}).map(([p, c]) => [normalizePath(p), c]));
  const findings: CheatFinding[] = [];
  const removals = (path: string, before: string, after: string | undefined) => {
    if (isTestSpec(path) && !justified.has(path)) findings.push(...removedTests(path, before, after));
  };
  for (const file of parseDiff(diff)) {
    const frozenFinding = frozenChange(file, frozen);
    if (frozenFinding) findings.push(frozenFinding);
    // What the file was: its old path for a rename, under which its tests are gone. A frozen test changed is already refused.
    const was = file.oldPath ?? file.path;
    const after = file.status === 'deleted' ? undefined : versionOf(file, 'new');
    if (file.status !== 'added' && !frozenFinding) {
      removals(was, deleted.get(was) ?? versionOf(file, 'old'), file.status === 'modified' ? after : undefined);
      deleted.delete(was);
    }
    if (PROSE.test(file.path) || file.status === 'deleted') continue;
    const kind: FileKind = isTestFile(file.path) ? 'test' : isTestHarnessFile(file.path) ? 'harness' : 'code';
    if (isScript(file.path)) {
      const added = new Set(file.added.map((a) => a.line));
      for (const f of scanScript(file.path, after ?? versionOf(file, 'new'), kind)) {
        const line = f.lines.find((n) => added.has(n));
        if (line !== undefined) findings.push({ file: file.path, line, form: f.form, match: f.match.trim() });
      }
      continue;
    }
    const l: Lang = isPython(file.path) ? 'py' : 'other';
    const rules = RULES.filter((r) => (r.langs?.includes(l) ?? true) && (r.in?.includes(kind) ?? true));
    const settings = CLAUDE_SETTINGS.test(file.path);
    for (const { line, text } of file.added) {
      if (settings && PERMISSION_RULE.test(text)) continue;
      // Other files are read whole: no tokens, the line itself is every view.
      const tokens = l === 'py' ? tokenize(text) : undefined;
      const views: Partial<Record<Kind, string>> = {};
      for (const rule of rules) {
        const m = rule.pattern.exec(tokens ? (views[rule.keep ?? 'code'] ??= view(text, tokens, rule.keep)) : text);
        if (m) findings.push({ file: file.path, line, form: rule.form, match: text.slice(m.index, m.index + m[0].length).trim() });
      }
    }
  }
  for (const [path, before] of deleted) removals(path, before, undefined);
  return findings;
}

// GitHub refuses a check run summary over 65,535 characters; a long matched line is cut as well.
const SUMMARY_LIMIT = 65_535;
const MATCH_LIMIT = 200;
const JUSTIFY = `A test removed or renamed on purpose is justified by a \`${REMOVED_TEST_TRAILER}: <path>: <reason>\` trailer in a commit of the branch.`;

function describeFinding(f: CheatFinding): string {
  const where = f.line === undefined ? f.file : `${f.file}:${f.line}`;
  const match = f.match.length > MATCH_LIMIT ? `${f.match.slice(0, MATCH_LIMIT)}…` : f.match;
  return `- ${mdCode(where)}: ${FORM_LABEL[f.form]} (${f.form === 'frozen-test' ? match : mdCode(match)})`;
}

function summarize(findings: CheatFinding[]): string {
  const lines = [findings.length === 1 ? '1 finding:' : `${findings.length} findings:`];
  const tail = findings.some((f) => f.form === 'removed-test') ? [JUSTIFY] : [];
  let size = lines[0]!.length + tail.reduce((n, t) => n + 1 + t.length, 0);
  for (const [i, f] of findings.entries()) {
    const line = describeFinding(f);
    const left = findings.length - i;
    // Keep room for the closing "… and N more" line.
    if (size + 1 + line.length + (left > 1 ? 40 : 0) > SUMMARY_LIMIT) {
      lines.push(`… and ${left} more`);
      break;
    }
    lines.push(line);
    size += 1 + line.length;
  }
  return [...lines, ...tail].join('\n');
}

/** The `factory/anti-triche` check run: success only when the diff shows none of the four forms and removes no test. */
export function antiCheatCheck(diff: string, options: AntiCheatOptions = {}): AntiCheatResult {
  const findings = scanDiff(diff, options);
  const ok = findings.length === 0;
  return { check: ANTI_CHEAT_CHECK, ok, summary: ok ? ANTI_CHEAT_OK : summarize(findings), findings };
}
