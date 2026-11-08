// The `red` factory check (ORC-123): the tests the `tests` step added must fail, and for the right reason. The
// factory runs them itself and reads the runner's machine report (vitest, jest, pytest, ORC-342), its text output
// when the runner wrote none; it never takes the agent's word.
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { ANSI } from './log-excerpt.js';
import { isTestFile, isTestSpec, normalizePath } from './test-files.js';
import { exportedNames, importedFrom, parse } from './ts-ast.js';

/**
 * Why the red is verified or not. Verified: an `assertion`; a `missing_module` the build will create (absent at
 * baseSha); a `missing_export` of a module that exists, the symbol absent at baseSha. Not verified: a module that
 * exists at baseSha (`module_at_base`), a package (`missing_package`: the build installs none), a compilation or
 * load error, a runtime error, no test, tests that pass, a step outside the tests (`scope`). `infra`: the check
 * could not run, no verdict on the tests.
 */
export type RedCause =
  | 'assertion' | 'missing_module' | 'missing_export'
  | 'module_at_base' | 'missing_package' | 'compile' | 'error' | 'no_tests' | 'passing' | 'scope' | 'infra';

export const RED_VERIFIED: ReadonlySet<RedCause> = new Set<RedCause>(['assertion', 'missing_module', 'missing_export']);

/** What a test needs and does not find: a module, or a `symbol` of one (whose module the output may not name). */
export interface Missing {
  module?: string;
  symbol?: string;
  /** The test file that imported it, as the runner printed it (TypeScript). */
  importer?: string;
  /** A dotted Python module name. */
  python?: true;
}

export type TestRunReading = { kind: 'assertion' | 'compile' | 'error' | 'no_tests' | 'passing' } | { kind: 'missing'; missing: Missing[] };

type Pattern = [RegExp, (m: RegExpMatchArray) => Missing];
// TS2305/TS2307 and Node's export SyntaxError are what a red test of new code prints: read before the generic errors.
const MISSING: Pattern[] = [
  [/(\S+?):\d+:\d+ - error TS2305: Module '"([^"]+)"' has no exported member '([^']+)'/g, (m) => ({ module: m[2]!, symbol: m[3]!, importer: m[1]! })],
  [/(\S+?):\d+:\d+ - error TS2307: Cannot find module '([^']+)'/g, (m) => ({ module: m[2]!, importer: m[1]! })],
  [/Cannot find module '([^']+)' from '([^']+)'/g, (m) => ({ module: m[1]!, importer: m[2]! })],
  [/Failed to resolve import "([^"]+)" from "([^"]+)"/g, (m) => ({ module: m[1]!, importer: m[2]! })],
  [/Failed to load url (\S+) \(resolved id: [^)]*\) in (\S+?)\.? Does/g, (m) => ({ module: m[1]!, importer: m[2]! })],
  // Node's ESM loader, and vitest 5.
  [/Cannot find module '([^']+)' imported from (\S+)/g, (m) => ({ module: m[1]!, importer: m[2]! })],
  [/The requested module '([^']+)' does not provide an export named '([^']+)'/g, (m) => ({ module: m[1]!, symbol: m[2]! })],
  // `(0 , __vi_import_0__.f)` (vitest before 5), `__vite_ssr_import_1__.f` (vitest 5), `f`.
  [/TypeError: (?:\(0 , )?(?:[\w$]+\.)?([\w$]+)\)? is not a function/g, (m) => ({ symbol: m[1]! })],
  [/ModuleNotFoundError: No module named '([^']+)'/g, (m) => ({ module: m[1]!, python: true })],
  [/ImportError: cannot import name '([^']+)' from '([\w.]+)'/g, (m) => ({ module: m[2]!, symbol: m[1]!, python: true })],
];
// A syntax or type error anywhere wins: the export SyntaxError and the two TS codes above are not ones.
const SYNTAX = [/SyntaxError(?!: (?:\[vite\] )?The requested module)/, /Transform failed/, /error TS(?!2305:|2307:)\d+:/];
// Anything else that kept the tests from loading: after the missing modules, which pytest and jest report so too.
const COLLECTION = [/Test suite failed to run/, /ERROR collecting/, /errors? during collection/, /Failed to load/];
// Only once no error was read: pytest prints `collected 0 items / 1 error` before its import errors.
const NO_TESTS = [/No test files found/, /No tests found/, /collected 0 items/, /no tests ran/];
const ASSERTION = [/AssertionError/, /expect\(received\)/, /^E\s+assert /m];

/** The modules and symbols `text` says are missing: one entry per module and symbol, the first pattern, the most precise, wins. */
function readMissing(text: string): Missing[] {
  const found = new Map<string, Missing>();
  for (const [re, read] of MISSING) {
    for (const m of text.matchAll(re)) {
      const missing = read(m);
      const key = `${missing.module ?? ''}|${missing.symbol ?? ''}`;
      if (!found.has(key)) found.set(key, missing);
    }
  }
  return [...found.values()];
}

/**
 * What a test run says, from its exit code and text output alone: the reading when the runner wrote no report. A word of
 * a test's name can change it (ORC-342). Pure.
 */
export function readTestRun(exitCode: number | null, output: string): TestRunReading {
  if (exitCode === 0) return { kind: 'passing' };
  // A timeout (no exit code) is not a red: the tests never finished.
  if (exitCode === null) return { kind: 'error' };
  if (SYNTAX.some((re) => re.test(output))) return { kind: 'compile' };
  const missing = readMissing(output);
  if (missing.length > 0) return { kind: 'missing', missing };
  if (COLLECTION.some((re) => re.test(output))) return { kind: 'compile' };
  if (NO_TESTS.some((re) => re.test(output))) return { kind: 'no_tests' };
  return { kind: ASSERTION.some((re) => re.test(output)) ? 'assertion' : 'error' };
}

/** What a runner's report says: the files that did not load, the failure of each failing test, how many tests ran. */
interface Report {
  loadErrors: string[];
  failures: string[];
  ran: number;
}

const stripAnsi = (s: string): string => s.replace(ANSI, '');

// An assertion library's error: chai's and node's `AssertionError`, jest's `expect(received)`, pytest's rewritten `assert`.
const ASSERTION_FAILURE = [/^(?:\w+\.)*AssertionError\b/, /^(?:Error: )?expect[.(]/, /^assert /, /^E\s+(?:AssertionError\b|assert )/m];

/**
 * A report read on its structure: the failure messages of the tests that failed and the errors of the files that did not
 * load, never a test's name. Only those messages are read with the patterns, so a passing test named after a failure
 * changes nothing. Pure.
 */
export function readReport(report: Report): TestRunReading {
  const loading = report.loadErrors.join('\n');
  if (SYNTAX.some((re) => re.test(loading))) return { kind: 'compile' };
  const missing = readMissing([loading, ...report.failures].join('\n'));
  if (missing.length > 0) return { kind: 'missing', missing };
  if (report.loadErrors.length > 0) return { kind: 'compile' };
  if (report.ran === 0) return { kind: 'no_tests' };
  if (report.failures.length === 0) return { kind: 'passing' };
  return { kind: report.failures.some((f) => ASSERTION_FAILURE.some((re) => re.test(f))) ? 'assertion' : 'error' };
}

interface JsonReport {
  testResults: { message?: string; assertionResults?: { status?: string; failureMessages?: string[] }[] }[];
}

/** The JSON report of vitest or jest (the same shape): a file with no test and a message did not load. */
function fromJson(json: JsonReport): Report {
  const report: Report = { loadErrors: [], failures: [], ran: 0 };
  for (const file of json.testResults) {
    const tests = file.assertionResults ?? [];
    if (tests.length === 0 && file.message) report.loadErrors.push(stripAnsi(file.message));
    for (const t of tests) {
      if (t.status !== 'passed' && t.status !== 'failed') continue;
      report.ran++;
      if (t.status === 'failed') report.failures.push(stripAnsi((t.failureMessages ?? []).join('\n')));
    }
  }
  return report;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unescapeXml = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) => (e[0] === '#' ? String.fromCodePoint(Number(e[1] === 'x' || e[1] === 'X' ? `0${e.slice(1)}` : e.slice(1))) : (ENTITIES[e] ?? all)));
const attribute = (attrs: string, name: string): string => unescapeXml(new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? '');

/**
 * The JUnit report of pytest: a `testcase` per test, its `failure`, `error` or `skipped`. A collection failure is an
 * `error` of its own `testcase`: the module did not load.
 */
function fromJUnit(xml: string): Report {
  const report: Report = { loadErrors: [], failures: [], ran: 0 };
  for (const tc of xml.matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const outcome = /<(failure|error|skipped)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(tc[1] ?? '');
    if (outcome?.[1] === 'skipped') continue;
    const message = outcome ? `${attribute(outcome[2]!, 'message')}\n${unescapeXml(outcome[3] ?? '')}` : '';
    if (outcome?.[1] === 'error' && /collection failure/.test(message)) {
      report.loadErrors.push(message);
      continue;
    }
    report.ran++;
    if (outcome) report.failures.push(message);
  }
  return report;
}

/** A report as a runner wrote it, JSON or JUnit XML; undefined when it is neither. */
function parseReport(text: string): Report | undefined {
  if (text.startsWith('<')) return /<testsuites?\b/.test(text) ? fromJUnit(text) : undefined;
  try {
    const json = JSON.parse(text) as Partial<JsonReport> | null;
    return Array.isArray(json?.testResults) ? fromJson(json as JsonReport) : undefined;
  } catch {
    return undefined;
  }
}

type Runner = 'vitest' | 'jest' | 'pytest';

// The report of each runner, written to `$f` (set by the command that runs it): the default output stays as it was.
const REPORT_FLAGS: Record<Runner, string> = {
  vitest: '--reporter=default --reporter=json --outputFile.json="$f"',
  jest: '--json --outputFile="$f"',
  pytest: '--junitxml="$f"',
};

/** The runner the last command of a shell line runs, which the arguments appended to the line reach. */
function runnerOf(line: string): Runner | undefined {
  const last = line.split(/&&|\|\||[;|]/).at(-1) ?? '';
  for (const word of last.trim().split(/\s+/)) {
    const name = word.split('/').at(-1);
    if (name === 'vitest' || name === 'jest' || name === 'pytest') return name;
  }
  return undefined;
}

// `npm test --`, `pnpm run test --`: the arguments after `--` reach the script.
const PACKAGE_SCRIPT = /^(?:npm|pnpm)\s+(?:run(?:-script)?\s+)?([\w:.-]+)\s+(?:.*\s)?--(?:\s|$)/;

/**
 * The runner of the repository's test command: named in it, or in the `package.json` script it runs through npm or pnpm
 * past a `--`. Undefined when the flags would reach another program: the text output is read.
 */
async function runnerOfCommand(command: string, deps: RedDeps): Promise<Runner | undefined> {
  const script = PACKAGE_SCRIPT.exec(`${command} `)?.[1];
  if (!script) return runnerOf(command);
  try {
    const scripts = (JSON.parse((await deps.showAtHead('package.json')) ?? '{}') as { scripts?: Record<string, unknown> }).scripts;
    const body = scripts?.[script === 't' ? 'test' : script];
    return typeof body === 'string' ? runnerOf(body) : undefined;
  } catch {
    return undefined;
  }
}

const TS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'];
// ponytail: Python reads modules from the root or `src/`; other layouts read as packages, and are refused.
const PY_ROOTS = ['', 'src/'];

/** The test file of the step a runner's printed importer names: printed relative to a sub-root, or absolute. */
function testOf(importer: string | undefined, tests: readonly string[]): string | undefined {
  if (!importer) return tests.length === 1 ? tests[0] : undefined;
  const p = normalizePath(importer);
  return tests.find((t) => t === p || t.endsWith(`/${p}`) || p.endsWith(`/${t}`));
}

/** The repository paths a relative TS module imported by `test` could be. */
function tsCandidates(module: string, test: string): string[] {
  const path = posix.normalize(posix.join(posix.dirname(test), module));
  // ESM TypeScript imports `./x.js` for `./x.ts`.
  const stem = path.replace(/\.[cm]?jsx?$/, '');
  return [path, ...TS_EXT.map((e) => stem + e), ...TS_EXT.map((e) => `${stem}/index${e}`)];
}

const pyCandidates = (module: string): string[] => PY_ROOTS.flatMap((r) => [`${r}${module.replace(/\./g, '/')}.py`, `${r}${module.replace(/\./g, '/')}/__init__.py`]);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The module the test file `path` imports `symbol` from: on the syntax tree for TS and JS (ORC-342), on the source for
 * Python, which has no parser here: a `from <module> import ...` line naming it.
 */
function importOf(path: string, source: string, symbol: string): { module: string; python?: true } | undefined {
  if (!path.endsWith('.py')) {
    const module = importedFrom(parse(path, source), symbol);
    return module === undefined ? undefined : { module };
  }
  const py = new RegExp(`^\\s*from\\s+([\\w.]+)\\s+import\\s+[^\\n]*\\b${escape(symbol)}\\b`, 'm').exec(source);
  return py ? { module: py[1]!, python: true } : undefined;
}

/**
 * Whether the module at `path` (at baseSha) has `symbol`: a TS or JS module exports it (on the syntax tree, ORC-342); a
 * Python one defines, assigns or imports it at its top level (a line starting with it: no Python parser here).
 */
function hasSymbol(path: string, source: string, symbol: string): boolean {
  if (!path.endsWith('.py')) return exportedNames(parse(path, source)).has(symbol);
  const s = escape(symbol);
  return new RegExp(`^(?:(?:async\\s+)?def\\s+${s}\\b|class\\s+${s}\\b|${s}\\s*(?::[^=\\n]*)?=|(?:from\\s+\\S+\\s+)?import\\s+[^\\n#]*\\b${s}\\b)`, 'm').test(source);
}

export interface RedDeps {
  /** Files the step's commits changed, from the head the step started on (baseSha) to its head. */
  changed: readonly { path: string; deleted: boolean }[];
  /** Files changed in the worktree and not committed, untracked ones included. */
  uncommitted: readonly string[];
  run(command: string): Promise<{ exitCode: number | null; output: string }>;
  /** Of `paths`, those that exist at baseSha (a file, or a directory). */
  existsAtBase(paths: readonly string[]): Promise<Set<string>>;
  showAtBase(path: string): Promise<string | undefined>;
  /** A test file of the step, at its head. */
  showAtHead(path: string): Promise<string | undefined>;
}

export interface RedResult {
  verified: boolean;
  cause: RedCause;
  /** The command run, empty when nothing ran. */
  command: string;
  exitCode: number | null;
  /** In French: why, for the journal and the agent's next attempt. */
  detail: string;
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Runs the tests the step added with the repository's test command, and says whether they are red for the right reason. */
export async function checkRed(command: string, deps: RedDeps): Promise<RedResult> {
  const verdict = (cause: RedCause, detail: string, ran = '', exitCode: number | null = null): RedResult => ({
    verified: RED_VERIFIED.has(cause),
    cause,
    command: ran,
    exitCode,
    detail,
  });
  const outside = [...deps.changed.map((f) => f.path), ...deps.uncommitted].filter((p) => !isTestFile(p));
  if (outside.length > 0) return verdict('scope', `The tests step changed files that are not tests: ${[...new Set(outside)].join(', ')}.`);
  const tests = deps.changed.filter((f) => !f.deleted && isTestSpec(f.path)).map((f) => normalizePath(f.path));
  if (tests.length === 0) return verdict('no_tests', 'The tests step committed no test.');

  const ran = `${command} ${tests.map(quote).join(' ')}`;
  const { exitCode, output, report } = await runWithReport(ran, await runnerOfCommand(command, deps), deps);
  const read = exitCode === null || exitCode === 0 || report === undefined ? undefined : parseReport(report);
  const reading = read ? readReport(read) : readTestRun(exitCode, output);
  const tail = output.slice(-4000);
  if (reading.kind !== 'missing') return verdict(reading.kind, `${DETAIL[reading.kind]}\n${tail}`, ran, exitCode);
  let cause: keyof typeof DETAIL = 'missing_module';
  for (const m of reading.missing) {
    const judged = await judge(m, tests, deps);
    if (judged !== 'missing_module' && judged !== 'missing_export') return verdict(judged, `${DETAIL[judged]}\n${tail}`, ran, exitCode);
    if (judged === 'missing_export') cause = judged;
  }
  return verdict(cause, `${DETAIL[cause]} (${reading.missing.map((m) => m.symbol ?? m.module).join(', ')})`, ran, exitCode);
}

/**
 * Runs `ran`, with the flags that make `runner` write its report to a file of its own, printed after the output behind a
 * marker no test can know. Without a runner, `ran` as it is.
 */
async function runWithReport(ran: string, runner: Runner | undefined, deps: RedDeps): Promise<{ exitCode: number | null; output: string; report?: string }> {
  if (!runner) return deps.run(ran);
  const id = randomUUID();
  const marker = `@@factory-report-${id}@@`;
  const script = [`f="\${TMPDIR:-/tmp}/factory-report-${id}"`, `${ran} ${REPORT_FLAGS[runner]}`, 's=$?', `printf '\\n%s\\n' '${marker}'`, 'cat "$f" 2>/dev/null', 'rm -f "$f"', 'exit $s'].join('\n');
  const { exitCode, output } = await deps.run(script);
  const at = output.indexOf(`\n${marker}\n`);
  if (at === -1) return { exitCode, output };
  return { exitCode, output: output.slice(0, at), report: output.slice(at + marker.length + 2).trim() };
}

/** What one missing module or symbol is: something the build will create, or a broken test. */
async function judge(m: Missing, tests: readonly string[], deps: RedDeps): Promise<keyof typeof DETAIL> {
  let { module, python } = m;
  let test = testOf(m.importer, tests);
  if (module === undefined) {
    // An undefined function (vitest): its module is the one a test file imports it from.
    for (const t of tests) {
      const found = importOf(t, (await deps.showAtHead(t)) ?? '', m.symbol!);
      if (found) [module, python, test] = [found.module, found.python, t];
    }
    if (module === undefined) return 'error';
  }
  let candidates: string[];
  if (python) {
    // A module of a package the repository has: not an installed package.
    const top = module.split('.')[0]!;
    const roots = await deps.existsAtBase(PY_ROOTS.flatMap((r) => [`${r}${top}`, `${r}${top}.py`]));
    if (module.startsWith('.') || roots.size === 0) return 'missing_package';
    candidates = pyCandidates(module);
  } else {
    if (!module.startsWith('.')) return 'missing_package';
    if (!test) return 'compile';
    candidates = tsCandidates(module, test);
  }
  const atBase = await deps.existsAtBase(candidates);
  if (m.symbol === undefined) return atBase.size === 0 ? 'missing_module' : 'module_at_base';
  // A missing export of a module the build creates is a missing module; of one that exists, the symbol must be new.
  const existing = candidates.find((c) => atBase.has(c));
  if (!existing) return 'missing_module';
  return hasSymbol(existing, (await deps.showAtBase(existing)) ?? '', m.symbol) ? 'compile' : 'missing_export';
}

const DETAIL: Record<Exclude<RedCause, 'scope' | 'infra'>, string> = {
  assertion: 'The tests fail on an assertion: red verified.',
  missing_module: 'The tests fail on a module the ticket has to create: red verified',
  missing_export: 'The tests fail on what an existing module does not export yet: red verified',
  module_at_base: 'A module the tests cannot find exists before the ticket: the import is broken.',
  missing_package: 'The tests import a package that is not installed: the ticket does not create packages.',
  compile: 'The tests do not compile (syntax, compilation or loading error, or a symbol that already exists).',
  error: 'The tests fail without an assertion (runtime error, timeout).',
  no_tests: 'No test ran.',
  passing: 'The tests already pass: they do not test what the ticket asks for.',
};
