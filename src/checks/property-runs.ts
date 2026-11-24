// The rerun of the property tests by `verify` (ORC-261): the factory's number of runs and a seed it draws, whatever the
// repository sets. A setting written in the test wins over any global one, in fast-check as in Hypothesis, so the
// factory writes its own after the file's (fast-check) or sets it on each test once collected (Hypothesis).
import { randomInt, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { VerifyFailure } from '../core/types.js';
import { readTests, type ReadTest } from './flaky.js';
import { escape, quote, type Runner } from './red.js';
import { isPython, parse, stringValue, ts } from './ts-ast.js';

/** The factory's number of runs of each property, `numRuns` in fast-check, `max_examples` in Hypothesis. */
export const PROPERTY_RUNS = 1000;

/** A seed both take: a positive 32-bit integer. */
export const drawSeed = (): number => randomInt(1, 2 ** 31);

export interface PropertySettings {
  runs: number;
  seed: number;
}

/**
 * What the rerun found, in the check and the measures. `unsettled`: files the factory found no call of fast-check in, or no
 * Hypothesis test of, run as they are. `notRun`: files of a language no test command of the repository runs, or that its run
 * did not report. `found`: a test of the rerun that counts failed while the repository's commands had passed: a defect a
 * property found that the examples did not.
 */
export interface PropertyRerun extends PropertySettings {
  files: string[];
  unsettled: string[];
  notRun: string[];
  found: boolean;
}

const FAST_CHECK = 'fast-check';
/**
 * fast-check's parameters that end the runs before their number, skip some, or hide a failure: set to their defaults, over the
 * file's and `configureGlobal`'s. Plugins stay, the test's own (`plugins`) and those `installGlobalPlugin` installed: a property
 * may need its life-cycle ones (`fc.beforeEach`), and no API of fast-check tells them from one that ends the runs early.
 */
export const UNCUT =
  'path: undefined, interruptAfterTimeLimit: undefined, skipAllAfterTimeLimit: undefined, ignoreEqualValues: false, skipEqualValues: false, reporter: undefined, asyncReporter: undefined';
/**
 * Type checking off in a rewritten file, past its shebang and its leading comments (jest reads its docblock only at the top):
 * `undefined` cannot be set to an optional parameter under `exactOptionalPropertyTypes`.
 */
const NO_CHECK = '// @ts-nocheck\n';
const PROP_PACKAGES = new Set(['@fast-check/vitest', '@fast-check/jest']);
/** fast-check's runners: their parameters come second, as those of `test.prop`. */
const RUNNERS = new Set(['assert', 'check']);

/** The names a file binds to fast-check: the module itself, its runners, and the `test` or `it` of its test packages. */
function bindings(sf: ts.SourceFile): { modules: Set<string>; runners: Set<string>; props: Set<string> } {
  const found = { modules: new Set<string>(), runners: new Set<string>(), props: new Set<string>() };
  const named = (module: string, imported: string, local: string) => {
    if (module === FAST_CHECK && RUNNERS.has(imported)) found.runners.add(local);
    if (PROP_PACKAGES.has(module) && imported === 'fc') found.modules.add(local);
    if (PROP_PACKAGES.has(module) && (imported === 'test' || imported === 'it')) found.props.add(local);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const module = stringValue(node.moduleSpecifier);
      const { name, namedBindings } = node.importClause;
      if (module === FAST_CHECK && name) found.modules.add(name.text);
      if (module === FAST_CHECK && namedBindings && ts.isNamespaceImport(namedBindings)) found.modules.add(namedBindings.name.text);
      if (module && namedBindings && ts.isNamedImports(namedBindings)) for (const e of namedBindings.elements) named(module, (e.propertyName ?? e.name).text, e.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'require') {
      const module = node.initializer.arguments.length === 1 ? stringValue(node.initializer.arguments[0]) : undefined;
      if (module === FAST_CHECK && ts.isIdentifier(node.name)) found.modules.add(node.name.text);
      if (module && ts.isObjectBindingPattern(node.name)) {
        for (const e of node.name.elements) if (ts.isIdentifier(e.name)) named(module, e.propertyName && ts.isIdentifier(e.propertyName) ? e.propertyName.text : e.name.text, e.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Whether a call is fast-check's: `fc.assert(p, params)`, `assert(p, params)`, `test.prop(arbs, params)`, a modifier between the
 * test and its `prop` included (`test.skip.prop`, `it.concurrent.prop`).
 */
function isFastCheckCall(call: ts.CallExpression, b: ReturnType<typeof bindings>): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return b.runners.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const owner = callee.expression;
  if (ts.isIdentifier(owner) && b.modules.has(owner.text) && RUNNERS.has(callee.name.text)) return true;
  const test = ts.isPropertyAccessExpression(owner) ? owner.expression : owner;
  return callee.name.text === 'prop' && ts.isIdentifier(test) && b.props.has(test.text);
}

/**
 * A JS or TS property test with the factory's settings after those of each fast-check call, so that they win: `{ ...(theirs),
 * numRuns, seed, … }`, with `UNCUT`, what else would cut the runs short or hide a failure, from the file or from `configureGlobal`
 * (a setup file, the code under test). Type checking is off in the file it rewrites. `calls`: how many it changed. Pure.
 */
export function underFactorySettings(path: string, source: string, at: PropertySettings): { source: string; calls: number } {
  const sf = parse(path, source);
  const b = bindings(sf);
  const set = `numRuns: ${at.runs}, seed: ${at.seed}, ${UNCUT}`;
  const edits: { from: number; to: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    let theirs: ts.Expression | undefined;
    if (ts.isCallExpression(node) && node.arguments.length && isFastCheckCall(node, b)) {
      const first = node.arguments[0]!;
      theirs = node.arguments[1];
      if (theirs) edits.push({ from: theirs.getStart(sf), to: theirs.end, text: `{ ...(${theirs.getText(sf)}), ${set} }` });
      else edits.push({ from: first.end, to: first.end, text: `, { ${set} }` });
    }
    // Not into the parameters replaced: their text goes as it is, and no edit overlaps another.
    ts.forEachChild(node, (child) => (child === theirs ? undefined : visit(child)));
  };
  visit(sf);
  // From the end: an edit never moves the positions of those before it.
  const out = edits.sort((x, y) => y.from - x.from).reduce((s, e) => s.slice(0, e.from) + e.text + s.slice(e.to), source);
  if (!edits.length) return { source, calls: 0 };
  const shebang = /^#![^\n]*\n/.exec(out)?.[0].length ?? 0;
  const last = ts.getLeadingCommentRanges(out, shebang)?.at(-1);
  if (!last) return { source: out.slice(0, shebang) + NO_CHECK + out.slice(shebang), calls: edits.length };
  // On a line of its own after the last leading comment, before any code that shares that comment's line.
  const eol = /^[ \t]*(?:\r?\n|$)/.exec(out.slice(last.end))?.[0];
  const cut = eol === undefined ? last.end : last.end + eol.length;
  const lead = eol?.endsWith('\n') ? '' : '\n';
  return { source: out.slice(0, cut) + lead + NO_CHECK + out.slice(cut), calls: edits.length };
}

/**
 * The pytest plugin of the factory (`-p factory_properties`): on each Hypothesis test once collected, its runs and seed, with no
 * database to replay and every phase, over what `@settings`, `@seed` or `@reproduce_failure` set. It writes the names of the files
 * it settled where `FACTORY_PROPERTY_SETTLED` says. Without Hypothesis installed, it settles nothing, and the tests run as written.
 */
export const HYPOTHESIS_PLUGIN = `import os

try:
    from hypothesis import Phase, settings
except ImportError:
    settings = None


def pytest_collection_modifyitems(items):
    runs = int(os.environ["FACTORY_PROPERTY_RUNS"])
    seed = int(os.environ["FACTORY_PROPERTY_SEED"])
    settled = set()
    for item in items if settings else []:
        obj = getattr(item, "obj", None)
        test = getattr(obj, "__func__", obj)
        if not getattr(test, "is_hypothesis_test", False):
            continue
        test._hypothesis_internal_use_settings = settings(test._hypothesis_internal_use_settings, max_examples=runs, derandomize=False, database=None, phases=tuple(Phase))
        test._hypothesis_internal_use_seed = seed
        test._hypothesis_internal_use_reproduce_failure = None
        settled.add(os.path.basename(str(getattr(item, "path", None) or item.fspath)))
    with open(os.environ["FACTORY_PROPERTY_SETTLED"], "w") as out:
        out.write("\\n".join(sorted(settled)))
`;

/** What the rerun needs of the sandbox the commands ran in. */
export interface RerunDeps {
  write(path: string, content: string): Promise<void>;
  /** `line` run with its runner's report asked for (`REPORT_FLAGS`), and read back. */
  run(line: string, runner: Runner, env: Record<string, string>): Promise<{ exitCode: number | null; output: string; report?: string }>;
  /** A file the run wrote, empty if none. */
  read(path: string): Promise<string>;
  /** Whether a failing test counts: a known flaky one does not (ORC-164). */
  counts(test: ReadTest): boolean;
}

/** The first line of a failure of the rerun: what the agent needs to reproduce it. */
const said = (at: PropertySettings): string =>
  `Property tests rerun by the factory: ${at.runs} runs, seed ${at.seed}, whatever the repository sets but its fast-check plugins. Reproduce with fast-check's \`{ numRuns: ${at.runs}, seed: ${at.seed} }\` or Hypothesis' \`@settings(max_examples=${at.runs})\` and \`@seed(${at.seed})\`.`;

/** Whether a report names `file`: from the repository's root, or from a sub-root (pytest's rootdir). */
const names = (tests: readonly ReadTest[], file: string): boolean => tests.some((t) => t.file === file || file.endsWith(`/${t.file}`));

/**
 * The property tests run again with the factory's settings, `sources` their text at the commit (none read for Python), by `lines`:
 * the repository's test command of each language, vitest or jest for JS and TS, pytest for Python, the files appended. The JS and
 * TS files are rewritten where they are checked out. Each run is judged by its report: a failing test that counts fails it, a
 * run without a readable report (it did not load, a hook failed) fails it on any exit but 0, and an exit
 * no test carries (a coverage threshold missed on these few files) does not; a file its report does not name is not run again.
 * No rerun when no file ran again and none failed.
 */
export async function rerunProperties(
  sources: ReadonlyMap<string, string | undefined>,
  lines: { js?: { line: string; runner: Runner }; py?: string },
  deps: RerunDeps,
  at: PropertySettings = { runs: PROPERTY_RUNS, seed: drawSeed() },
): Promise<{ rerun?: PropertyRerun; failures: VerifyFailure[] }> {
  const files = [...sources.keys()];
  const failures: VerifyFailure[] = [];
  const [py, js] = [files.filter(isPython), files.filter((f) => !isPython(f))];
  const notRun = [...(lines.js ? [] : js), ...(lines.py ? [] : py)];
  const run = async (line: string, runner: Runner, of: readonly string[], env: Record<string, string> = {}) => {
    const r = await deps.run(line, runner, env);
    const tests = readTests(r.report);
    const failed = tests?.filter((t) => t.status === 'failed' && deps.counts(t));
    if (tests) notRun.push(...of.filter((f) => !names(tests, f)));
    if (failed ? failed.length : r.exitCode !== 0) failures.push({ command: line, exitCode: r.exitCode, output: `${said(at)}\n${r.output}` });
  };
  const unsettled: string[] = [];
  if (js.length && lines.js) {
    for (const file of js) {
      const settled = underFactorySettings(file, sources.get(file) ?? '', at);
      if (settled.calls) await deps.write(file, settled.source);
      else unsettled.push(file);
    }
    // jest reads its files as patterns. A file the command's configuration leaves out is no failure: its report says it did not run.
    const runner = lines.js.runner;
    await run(`${lines.js.line} --passWithNoTests ${js.map((f) => quote(runner === 'jest' ? escape(f) : f)).join(' ')}`, runner, js);
  }
  if (py.length && lines.py) {
    const dir = `/tmp/factory-properties-${randomUUID()}`;
    const report = `${dir}/settled`;
    await deps.write(`${dir}/factory_properties.py`, HYPOTHESIS_PLUGIN);
    const env = { FACTORY_PROPERTY_RUNS: String(at.runs), FACTORY_PROPERTY_SEED: String(at.seed), FACTORY_PROPERTY_SETTLED: report };
    await run(`export PYTHONPATH=${dir}\${PYTHONPATH:+:$PYTHONPATH}; ${lines.py} -p factory_properties ${py.map(quote).join(' ')}`, 'pytest', py, env);
    const settled = new Set((await deps.read(report)).split('\n'));
    unsettled.push(...py.filter((f) => !settled.has(posix.basename(f))));
  }
  if (!failures.length && files.every((f) => notRun.includes(f))) return { failures };
  return { rerun: { ...at, files, unsettled, notRun, found: failures.length > 0 }, failures };
}
