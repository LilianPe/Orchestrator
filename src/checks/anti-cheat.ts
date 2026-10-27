// Deterministic scan of the diff `baseSha..SHA` against the four forms of cheating (ORC-158). No model: a finding is
// a pattern on an ADDED line, so a removed line never blocks. Every finding blocks `factory/anti-triche`.
import { parseDiff, type DiffFile } from './diff.js';
import { isTestFile, isTestHarnessFile } from './test-files.js';
import type { CheckResult } from './types.js';

export const ANTI_CHEAT_CHECK = 'factory/anti-triche';

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

interface Rule {
  form: Exclude<CheatForm, 'frozen-test'>;
  langs: Lang[];
  pattern: RegExp;
  /** `tests`: only in test files; `code`: only outside test files and the test runner's configuration. */
  only?: 'tests' | 'code';
}

const RULES: Rule[] = [
  // 2. Disabling.
  { form: 'disabled-test', langs: ['js'], pattern: /\b(?:it|test|describe|suite|context|bench)(?:\.\w+)*\.(?:skip|only|todo|skipIf|runIf)\b/ },
  { form: 'disabled-test', langs: ['js'], pattern: /\b(?:ctx|t|this)\.skip\s*\(/ },
  { form: 'disabled-test', langs: ['js'], pattern: /(?<![\w.$])x(?:it|describe|test)\s*\(/ },
  // `fit` and `fdescribe` focus like `.only`; outside tests, `fit(` is too often a real function.
  { form: 'disabled-test', langs: ['js'], pattern: /(?<![\w.$])f(?:it|describe)\s*\(/, only: 'tests' },
  { form: 'disabled-test', langs: ['py'], pattern: /\bpytest\.mark\.(?:skip|skipif|xfail)\b/ },
  { form: 'disabled-test', langs: ['py'], pattern: /\bpytest\.(?:skip|xfail)\s*\(/ },
  { form: 'disabled-test', langs: ['py'], pattern: /\bunittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|^\s*@(?:skip|skipIf|skipUnless|expectedFailure)\b|\bself\.skipTest\s*\(/ },
  // 3. Bypasses. All three TypeScript directives silence the type checker; `@ts-expect-error` included.
  { form: 'bypass', langs: ['js', 'py', 'other'], pattern: /--no-verify\b/ },
  { form: 'bypass', langs: ['js', 'other'], pattern: /\beslint-disable\b/ },
  { form: 'bypass', langs: ['js', 'other'], pattern: /@ts-(?:ignore|nocheck|expect-error)\b/ },
  { form: 'bypass', langs: ['py'], pattern: /#\s*(?:type|pyright):\s*ignore\b/ },
  { form: 'bypass', langs: ['py'], pattern: /#\s*noqa\b/i },
  // Emptied assertions: an assertion on a constant, true whatever the code does.
  { form: 'bypass', langs: ['js'], pattern: /\bexpect\s*\(\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`$]*`)\s*\)/ },
  { form: 'bypass', langs: ['js'], pattern: /(?<![\w.$])assert(?:\.ok)?\s*\(\s*(?:true|1|!0)\s*[,)]/ },
  { form: 'bypass', langs: ['py'], pattern: /^\s*assert\s+(?:True|1|not\s+(?:False|None|0)|'[^']*'|"[^"]*")\s*(?:,|#|$)|\bself\.assertTrue\s*\(\s*True\s*[,)]/ },
  // Leaving with success before the tests can fail. Shell `exit 0` is not scanned: too common in real scripts.
  { form: 'bypass', langs: ['js', 'py'], pattern: /(?<![\w.$])(?:process\.|sys\.|os\._)?exit\s*\(\s*0?\s*\)/ },
  // 4. Code that behaves differently under test, outside tests only: a pattern list, false negatives accepted.
  { form: 'test-only-behaviour', langs: ['js', 'py'], only: 'code', pattern: /\b(?:NODE_ENV|env\.MODE)\b.*(['"`])test\1|(['"`])test\2.*\b(?:NODE_ENV|env\.MODE)\b/ },
  { form: 'test-only-behaviour', langs: ['js', 'py'], only: 'code', pattern: /\b(?:VITEST(?:_[A-Z_]+)?|JEST_WORKER_ID|PYTEST_CURRENT_TEST)\b/ },
  { form: 'test-only-behaviour', langs: ['py'], only: 'code', pattern: /\bsys\.modules\b.*(['"])pytest\1|(['"])pytest\2.*\bsys\.modules\b/ },
];

const FORM_LABEL: Record<CheatForm, string> = {
  'frozen-test': "test d'acceptation gelé modifié",
  'disabled-test': 'test désactivé',
  bypass: 'contournement',
  'test-only-behaviour': 'comportement différent sous test',
};

// Documentation may quote any of the patterns: it is never scanned.
const PROSE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;

function lang(path: string): Lang {
  if (/\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/.test(path)) return 'js';
  if (/\.pyi?$/.test(path)) return 'py';
  return 'other';
}

const norm = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');

function frozenChange(file: DiffFile, frozen: Set<string>): CheatFinding | undefined {
  const old = file.oldPath ?? file.path;
  if (!frozen.has(file.path) && !frozen.has(old)) return undefined;
  if (file.status === 'deleted') return { file: file.path, form: 'frozen-test', match: 'supprimé' };
  if (file.status === 'renamed' && frozen.has(old)) return { file: old, form: 'frozen-test', match: `renommé en ${file.path}` };
  const first = file.added[0]?.line;
  return { file: file.path, ...(first !== undefined ? { line: first } : {}), form: 'frozen-test', match: 'modifié' };
}

export function scanDiff(diff: string, options: AntiCheatOptions = {}): CheatFinding[] {
  const frozen = new Set([...(options.frozenTests ?? [])].map(norm));
  const findings: CheatFinding[] = [];
  for (const file of parseDiff(diff)) {
    const frozenFinding = frozenChange(file, frozen);
    if (frozenFinding) findings.push(frozenFinding);
    if (PROSE.test(file.path)) continue;
    const l = lang(file.path);
    const test = isTestFile(file.path);
    const code = !test && !isTestHarnessFile(file.path);
    const rules = RULES.filter((r) => r.langs.includes(l) && (r.only === undefined || (r.only === 'tests' ? test : code)));
    for (const { line, text } of file.added) {
      for (const rule of rules) {
        const m = rule.pattern.exec(text);
        if (m) findings.push({ file: file.path, line, form: rule.form, match: m[0].trim() });
      }
    }
  }
  return findings;
}

// Markdown code span that survives a backtick in the matched text.
const code = (s: string): string => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);

function describeFinding(f: CheatFinding): string {
  const where = f.line === undefined ? f.file : `${f.file}:${f.line}`;
  return `- ${code(where)} : ${FORM_LABEL[f.form]} (${f.form === 'frozen-test' ? f.match : code(f.match)})`;
}

/** The `factory/anti-triche` check run: success only when the diff shows none of the four forms. */
export function antiCheatCheck(diff: string, options: AntiCheatOptions = {}): AntiCheatResult {
  const findings = scanDiff(diff, options);
  if (findings.length === 0) return { check: ANTI_CHEAT_CHECK, ok: true, summary: 'aucun test désactivé, aucun contournement', findings };
  const head = findings.length === 1 ? '1 constat' : `${findings.length} constats`;
  return { check: ANTI_CHEAT_CHECK, ok: false, summary: [`${head} :`, ...findings.map(describeFinding)].join('\n'), findings };
}
