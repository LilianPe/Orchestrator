// The rerun of the property tests by `verify` (ORC-261): the factory's number of runs and a seed it draws, whatever the
// repository sets. A setting written in the test wins over any global one, in fast-check as in Hypothesis, so the
// factory writes its own after the file's (fast-check) or sets it on each test once collected (Hypothesis).
import { randomInt, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { VerifyFailure } from '../core/types.js';
import { quote } from './red.js';
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
 * Hypothesis test of, run as they are. `notRun`: files of a language no test command of the repository runs. `found`: a
 * rerun failed while the repository's commands had passed: a defect a property found that the examples did not.
 */
export interface PropertyRerun extends PropertySettings {
  files: string[];
  unsettled: string[];
  notRun: string[];
  found: boolean;
}

const FAST_CHECK = 'fast-check';
/** fast-check's parameters that end the runs before their number: set to their defaults, over any global configuration. */
export const UNCUT = 'path: undefined, interruptAfterTimeLimit: undefined, skipAllAfterTimeLimit: undefined, ignoreEqualValues: false';
const PROP_PACKAGES = new Set(['@fast-check/vitest', '@fast-check/jest']);
/** fast-check's runners and the place of their parameters. */
const RUNNERS: Record<string, number> = { assert: 1, check: 1 };

/** The names a file binds to fast-check: the module itself, its runners, and the `test` or `it` of its test packages. */
function bindings(sf: ts.SourceFile): { modules: Set<string>; runners: Set<string>; props: Set<string> } {
  const found = { modules: new Set<string>(), runners: new Set<string>(), props: new Set<string>() };
  const named = (module: string, imported: string, local: string) => {
    if (module === FAST_CHECK && imported in RUNNERS) found.runners.add(local);
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
      if (module && ts.isIdentifier(node.name) && module === FAST_CHECK) found.modules.add(node.name.text);
      if (module && ts.isObjectBindingPattern(node.name)) {
        for (const e of node.name.elements) if (ts.isIdentifier(e.name)) named(module, e.propertyName && ts.isIdentifier(e.propertyName) ? e.propertyName.text : e.name.text, e.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Where a call takes fast-check's parameters, when it is a call of fast-check: `fc.assert(p, params)`, `assert(p, params)`, `test.prop(arbs, params)`. */
function paramsAt(call: ts.CallExpression, b: ReturnType<typeof bindings>): number | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return b.runners.has(callee.text) ? RUNNERS.assert : undefined;
  if (ts.isPropertyAccessExpression(callee) && ts.isPropertyAccessExpression(callee.expression)) return modifiedProp(call, b);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;
  const [owner, method] = [callee.expression.text, callee.name.text];
  if (b.modules.has(owner) && method in RUNNERS) return RUNNERS[method];
  return b.props.has(owner) && method === 'prop' ? 1 : undefined;
}

/** `test.skip.prop(arbs, params)`, `it.concurrent.prop(…)`: a modifier between the test and its `prop`. */
function modifiedProp(call: ts.CallExpression, b: ReturnType<typeof bindings>): number | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'prop' || !ts.isPropertyAccessExpression(callee.expression)) return undefined;
  const owner = callee.expression.expression;
  return ts.isIdentifier(owner) && b.props.has(owner.text) ? 1 : undefined;
}

/**
 * A JS or TS property test with the factory's settings after those of each fast-check call, so that they win: `{ ...(theirs),
 * numRuns, seed, … }`, with what else would cut the runs short, from the file or from `configureGlobal` anywhere (a setup file,
 * the code under test): a replay `path`, a time limit, equal values skipped. `calls`: how many it changed. Pure.
 */
export function underFactorySettings(path: string, source: string, at: PropertySettings): { source: string; calls: number } {
  const sf = parse(path, source);
  const b = bindings(sf);
  const set = `numRuns: ${at.runs}, seed: ${at.seed}, ${UNCUT}`;
  const edits: { from: number; to: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    const i = ts.isCallExpression(node) ? paramsAt(node, b) : undefined;
    let theirs: ts.Expression | undefined;
    if (i !== undefined && ts.isCallExpression(node) && node.arguments.length >= i) {
      theirs = node.arguments[i];
      if (theirs) edits.push({ from: theirs.getStart(sf), to: theirs.end, text: `{ ...(${theirs.getText(sf)}), ${set} }` });
      else edits.push({ from: node.arguments[i - 1]!.end, to: node.arguments[i - 1]!.end, text: `, { ${set} }` });
    }
    // Not into the parameters replaced: their text goes as it is, and no edit overlaps another.
    ts.forEachChild(node, (child) => (child === theirs ? undefined : visit(child)));
  };
  visit(sf);
  // From the end: an edit never moves the positions of those before it.
  const out = [...edits].sort((x, y) => y.from - x.from).reduce((s, e) => s.slice(0, e.from) + e.text + s.slice(e.to), source);
  return { source: out, calls: edits.length };
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
        settled.add(os.path.basename(str(item.path)))
    with open(os.environ["FACTORY_PROPERTY_SETTLED"], "w") as out:
        out.write("\\n".join(sorted(settled)))
`;

/** What the rerun needs of the sandbox the commands ran in. */
export interface RerunDeps {
  /** A file of the commit, as checked out. */
  show(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
  run(line: string, env: Record<string, string>): Promise<{ exitCode: number | null; output: string }>;
  /** A file the run wrote, empty if none. */
  read(path: string): Promise<string>;
}

/** The first line of a failure of the rerun: what the agent needs to reproduce it. */
const said = (at: PropertySettings): string =>
  `Property tests rerun by the factory: ${at.runs} runs, seed ${at.seed}, whatever the repository sets. Reproduce with fast-check's \`{ numRuns: ${at.runs}, seed: ${at.seed} }\` or Hypothesis' \`@settings(max_examples=${at.runs})\` and \`@seed(${at.seed})\`.`;

/**
 * The property tests `files` run again with the factory's settings, by `lines`: the repository's test command of each language
 * (vitest or jest for JS and TS, pytest for Python), the files appended. The JS and TS files are rewritten where they are checked out.
 */
export async function rerunProperties(files: readonly string[], lines: { js?: string; py?: string }, deps: RerunDeps, at: PropertySettings = { runs: PROPERTY_RUNS, seed: drawSeed() }): Promise<{ rerun: PropertyRerun; failures: VerifyFailure[] }> {
  const rerun: PropertyRerun = { ...at, files: [...files], unsettled: [], notRun: [], found: false };
  const failures: VerifyFailure[] = [];
  const run = async (line: string, env: Record<string, string> = {}) => {
    const r = await deps.run(line, { FACTORY_PROPERTY_RUNS: String(at.runs), FACTORY_PROPERTY_SEED: String(at.seed), ...env });
    if (r.exitCode !== 0) failures.push({ command: line, exitCode: r.exitCode, output: `${said(at)}\n${r.output}` });
  };
  const args = (paths: readonly string[]) => paths.map(quote).join(' ');
  const [py, js] = [files.filter(isPython), files.filter((f) => !isPython(f))];
  if (js.length && !lines.js) rerun.notRun.push(...js);
  if (js.length && lines.js) {
    for (const file of js) {
      const settled = underFactorySettings(file, (await deps.show(file)) ?? '', at);
      if (settled.calls) await deps.write(file, settled.source);
      else rerun.unsettled.push(file);
    }
    await run(`${lines.js} ${args(js)}`);
  }
  if (py.length && !lines.py) rerun.notRun.push(...py);
  if (py.length && lines.py) {
    const dir = `/tmp/factory-properties-${randomUUID()}`;
    const report = `${dir}/settled`;
    await deps.write(`${dir}/factory_properties.py`, HYPOTHESIS_PLUGIN);
    await run(`export PYTHONPATH=${dir}\${PYTHONPATH:+:$PYTHONPATH}; ${lines.py} -p factory_properties ${args(py)}`, { FACTORY_PROPERTY_SETTLED: report });
    const settled = new Set((await deps.read(report)).split('\n'));
    rerun.unsettled.push(...py.filter((f) => !settled.has(posix.basename(f))));
  }
  rerun.found = failures.length > 0;
  return { rerun, failures };
}
