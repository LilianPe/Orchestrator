// The `red` factory check (ORC-123): the tests the `tests` step added must fail, and for the right reason. The
// factory runs them itself and reads the runner's output (vitest, jest, pytest); it never takes the agent's word.
import { posix } from 'node:path';
import { isTestFile, normalizePath } from './test-files.js';

/**
 * Why the red is verified (`assertion`, `missing_module`) or not. `missing_module` is a module the build will
 * create: absent at baseSha. `module_at_base` is one that exists there (or a package): the test is broken.
 * `scope`: the step wrote something else than tests.
 */
export type RedCause = 'assertion' | 'missing_module' | 'module_at_base' | 'compile' | 'error' | 'no_tests' | 'passing' | 'scope';

export const RED_VERIFIED: ReadonlySet<RedCause> = new Set<RedCause>(['assertion', 'missing_module']);

export interface MissingModule {
  module: string;
  /** Repository-relative file that imported it (TypeScript). */
  importer?: string;
  /** A dotted Python module name. */
  python?: true;
}

export type TestRunReading =
  | { kind: 'assertion' | 'compile' | 'error' | 'no_tests' | 'passing' }
  | { kind: 'missing_module'; modules: MissingModule[] };

const NO_TESTS = [/No test files found/, /No tests found/, /collected 0 items/, /no tests ran/];
// Checked before the missing modules: a syntax error wins over everything.
const SYNTAX = [/SyntaxError/, /Transform failed/, /error TS\d+:/];
const TS_MISSING = [
  /Cannot find module '([^']+)'(?: from '([^']+)')?/g,
  /Failed to resolve import "([^"]+)" from "([^"]+)"/g,
  /Failed to load url (\S+) \(resolved id: [^)]*\) in (\S+?)\.? Does/g,
];
const PY_MISSING = /ModuleNotFoundError: No module named '([^']+)'/g;
// Anything else that kept the tests from running.
const COLLECTION = [/Test suite failed to run/, /ERROR collecting/, /errors? during collection/, /Failed to load/];
const ASSERTION = [/AssertionError/, /expect\(received\)/, /^E\s+assert /m];

/** What a test run says, from its exit code and output alone. Pure. */
export function readTestRun(exitCode: number | null, output: string): TestRunReading {
  if (exitCode === 0) return { kind: 'passing' };
  // A timeout (no exit code) is not a red: the tests never finished.
  if (exitCode === null) return { kind: 'error' };
  if (NO_TESTS.some((re) => re.test(output))) return { kind: 'no_tests' };
  if (SYNTAX.some((re) => re.test(output))) return { kind: 'compile' };
  const modules: MissingModule[] = [];
  for (const re of TS_MISSING) for (const m of output.matchAll(re)) modules.push({ module: m[1]!, ...(m[2] ? { importer: m[2] } : {}) });
  for (const m of output.matchAll(PY_MISSING)) modules.push({ module: m[1]!, python: true });
  if (modules.length > 0) return { kind: 'missing_module', modules };
  if (COLLECTION.some((re) => re.test(output))) return { kind: 'compile' };
  // ponytail: one assertion anywhere reads the whole run as red; a per-test reading needs each runner's JSON reporter.
  return { kind: ASSERTION.some((re) => re.test(output)) ? 'assertion' : 'error' };
}

const TS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'];

/**
 * The repository paths a missing module could be. None for a package (`left-pad`, an alias): the build does not
 * create one. `tests` are the step's test files, to make an absolute importer repository-relative.
 * ponytail: Python reads the module from the root or `src/`; other layouts get no candidate, and are refused.
 */
export function moduleCandidates(m: MissingModule, tests: readonly string[]): string[] {
  if (m.python) {
    const base = m.module.replace(/\./g, '/');
    return ['', 'src/'].flatMap((root) => [`${root}${base}.py`, `${root}${base}/__init__.py`]);
  }
  if (!m.module.startsWith('.') || !m.importer) return [];
  const importer = normalizePath(m.importer);
  const rel = tests.find((t) => importer === t || importer.endsWith(`/${t}`)) ?? importer;
  const path = posix.normalize(posix.join(posix.dirname(rel), m.module));
  // ESM TypeScript imports `./x.js` for `./x.ts`.
  const stem = path.replace(/\.[cm]?jsx?$/, '');
  return [path, ...TS_EXT.map((e) => stem + e), ...TS_EXT.map((e) => `${stem}/index${e}`)];
}

export interface RedDeps {
  /** Files the step's commits changed, baseSha..HEAD. */
  changed: readonly { path: string; deleted: boolean }[];
  run(command: string): Promise<{ exitCode: number | null; output: string }>;
  /** `git cat-file -e baseSha:<path>`, on the factory's own repository. */
  existsAtBase(path: string): Promise<boolean>;
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
  const outside = deps.changed.filter((f) => !isTestFile(f.path)).map((f) => f.path);
  if (outside.length > 0) return verdict('scope', `L'étape tests a modifié des fichiers qui ne sont pas des tests : ${outside.join(', ')}.`);
  const tests = deps.changed.filter((f) => !f.deleted).map((f) => normalizePath(f.path));
  if (tests.length === 0) return verdict('no_tests', "L'étape tests n'a commité aucun test.");

  const ran = `${command} ${tests.map(quote).join(' ')}`;
  const { exitCode, output } = await deps.run(ran);
  const reading = readTestRun(exitCode, output);
  const tail = output.slice(-4000);
  if (reading.kind !== 'missing_module') return verdict(reading.kind, `${DETAIL[reading.kind]}\n${tail}`, ran, exitCode);
  for (const m of reading.modules) {
    const paths = moduleCandidates(m, tests);
    const atBase = paths.length === 0 || (await Promise.all(paths.map((p) => deps.existsAtBase(p)))).some(Boolean);
    if (atBase) return verdict('module_at_base', `Le module ${m.module} est introuvable alors qu'il existe avant le ticket (ou n'est pas un fichier du dépôt).\n${tail}`, ran, exitCode);
  }
  return verdict('missing_module', `${DETAIL.missing_module} (${reading.modules.map((m) => m.module).join(', ')})`, ran, exitCode);
}

const DETAIL: Record<Exclude<RedCause, 'module_at_base' | 'scope'>, string> = {
  assertion: 'Les tests échouent sur une assertion : rouge vérifié.',
  missing_module: 'Les tests échouent sur un module que le ticket doit créer : rouge vérifié',
  compile: 'Les tests ne compilent pas (erreur de syntaxe, de compilation ou de chargement).',
  error: "Les tests échouent sans assertion (erreur à l'exécution, délai dépassé).",
  no_tests: "Aucun test n'a tourné.",
  passing: 'Les tests passent déjà : ils ne testent pas ce que le ticket demande.',
};
