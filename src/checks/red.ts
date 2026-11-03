// The `red` factory check (ORC-123): the tests the `tests` step added must fail, and for the right reason. The
// factory runs them itself and reads the runner's output (vitest, jest, pytest); it never takes the agent's word.
import { posix } from 'node:path';
import { isTestFile, isTestSpec, normalizePath } from './test-files.js';

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
  [/The requested module '([^']+)' does not provide an export named '([^']+)'/g, (m) => ({ module: m[1]!, symbol: m[2]! })],
  [/TypeError: (?:\(0 , [\w$]+\.)?([\w$]+)\)? is not a function/g, (m) => ({ symbol: m[1]! })],
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

/** What a test run says, from its exit code and output alone. Pure. */
export function readTestRun(exitCode: number | null, output: string): TestRunReading {
  if (exitCode === 0) return { kind: 'passing' };
  // A timeout (no exit code) is not a red: the tests never finished.
  if (exitCode === null) return { kind: 'error' };
  if (SYNTAX.some((re) => re.test(output))) return { kind: 'compile' };
  // One entry per module and symbol: the first pattern, the most precise, wins.
  const found = new Map<string, Missing>();
  for (const [re, read] of MISSING) {
    for (const m of output.matchAll(re)) {
      const missing = read(m);
      const key = `${missing.module ?? ''}|${missing.symbol ?? ''}`;
      if (!found.has(key)) found.set(key, missing);
    }
  }
  if (found.size > 0) return { kind: 'missing', missing: [...found.values()] };
  if (COLLECTION.some((re) => re.test(output))) return { kind: 'compile' };
  if (NO_TESTS.some((re) => re.test(output))) return { kind: 'no_tests' };
  // ponytail: one assertion anywhere reads the whole run as red; a per-test reading needs each runner's JSON reporter.
  return { kind: ASSERTION.some((re) => re.test(output)) ? 'assertion' : 'error' };
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

/** The module a test file imports `symbol` from, read in its source. */
function importOf(source: string, symbol: string): { module: string; python?: true } | undefined {
  const s = escape(symbol);
  const ts = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${s}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`).exec(source);
  if (ts) return { module: ts[1]! };
  const py = new RegExp(`from\\s+([\\w.]+)\\s+import\\s+[^\\n]*\\b${s}\\b`).exec(source);
  return py ? { module: py[1]!, python: true } : undefined;
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
  if (outside.length > 0) return verdict('scope', `L'étape tests a modifié des fichiers qui ne sont pas des tests : ${[...new Set(outside)].join(', ')}.`);
  const tests = deps.changed.filter((f) => !f.deleted && isTestSpec(f.path)).map((f) => normalizePath(f.path));
  if (tests.length === 0) return verdict('no_tests', "L'étape tests n'a commité aucun test.");

  const ran = `${command} ${tests.map(quote).join(' ')}`;
  const { exitCode, output } = await deps.run(ran);
  const reading = readTestRun(exitCode, output);
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

/** What one missing module or symbol is: something the build will create, or a broken test. */
async function judge(m: Missing, tests: readonly string[], deps: RedDeps): Promise<keyof typeof DETAIL> {
  let { module, python } = m;
  let test = testOf(m.importer, tests);
  if (module === undefined) {
    // An undefined function (vitest): its module is the one a test file imports it from.
    for (const t of tests) {
      const found = importOf((await deps.showAtHead(t)) ?? '', m.symbol!);
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
  const source = (await deps.showAtBase(existing)) ?? '';
  return new RegExp(`\\b${escape(m.symbol)}\\b`).test(source) ? 'compile' : 'missing_export';
}

const DETAIL: Record<Exclude<RedCause, 'scope' | 'infra'>, string> = {
  assertion: 'Les tests échouent sur une assertion : rouge vérifié.',
  missing_module: 'Les tests échouent sur un module que le ticket doit créer : rouge vérifié',
  missing_export: "Les tests échouent sur ce qu'un module existant n'exporte pas encore : rouge vérifié",
  module_at_base: "Un module introuvable pour les tests existe avant le ticket : l'import est cassé.",
  missing_package: "Les tests importent un paquet qui n'est pas installé : le ticket n'en crée pas.",
  compile: "Les tests ne compilent pas (erreur de syntaxe, de compilation ou de chargement, ou symbole qui existe déjà).",
  error: "Les tests échouent sans assertion (erreur à l'exécution, délai dépassé).",
  no_tests: "Aucun test n'a tourné.",
  passing: 'Les tests passent déjà : ils ne testent pas ce que le ticket demande.',
};
