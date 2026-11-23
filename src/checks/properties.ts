// The tests of a spec's « for any input » properties (ORC-261): the factory names the file of each approved property, the
// `tests` step writes it, and the freeze holds it with the generators it imports.
import { posix } from 'node:path';
import type { FreezeView } from './freeze.js';
import { fileName, isTestFile, normalizePath } from './test-files.js';
import { isPython, parse, pyModule, stringValue, ts, tsCandidates } from './ts-ast.js';

/** The file named for the test of approved property `n` (from 1) of `ticketId`: in TypeScript or JavaScript, or in Python. */
export function propertyTestFiles(ticketId: string, n: number): { ts: string; py: string } {
  const id = ticketId.toLowerCase();
  return { ts: `${id}.property-${n}.test.ts`, py: `test_${id.replace(/[^a-z0-9]/g, '_')}_property_${n}.py` };
}

/** The files of the `count` approved properties, in order. */
export const propertyFiles = (ticketId: string, count: number): { ts: string; py: string }[] => Array.from({ length: count }, (_, i) => propertyTestFiles(ticketId, i + 1));

/** For each approved property (`count` of them), whether a file name is its test: its named file, `.spec` and any JS or TS extension allowed. */
function matchers(ticketId: string, count: number): ((name: string) => boolean)[] {
  return propertyFiles(ticketId, count).map(({ ts: named, py }) => {
    const stem = named.replace(/\.test\.ts$/, '.');
    return (name: string) => name === py || (name.startsWith(stem) && /^(?:test|spec)\.[cm]?[jt]sx?$/.test(name.slice(stem.length)));
  });
}

/** The approved properties (numbered from 1, `count` of them) none of `paths` is the test of. */
export function missingProperties(ticketId: string, count: number, paths: readonly string[]): number[] {
  const names = paths.map(fileName);
  return matchers(ticketId, count).flatMap((is, i) => (names.some(is) ? [] : [i + 1]));
}

/** Of `paths`, the tests of the approved properties (`count` of them). */
export function propertyTests(ticketId: string, count: number, paths: readonly string[]): string[] {
  const all = matchers(ticketId, count);
  return paths.filter((p) => all.some((is) => is(fileName(p))));
}

/** The modules a JS or TS file imports or re-exports by a string: `import`, `export … from`, `import()`, `require()`. */
function scriptImports(path: string, source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const declared = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? stringValue(node.moduleSpecifier) : undefined;
    const called = ts.isCallExpression(node) && node.arguments.length === 1 && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) ? stringValue(node.arguments[0]) : undefined;
    const module = declared ?? called;
    if (module !== undefined) found.push(module);
    ts.forEachChild(node, visit);
  };
  visit(parse(path, source));
  return found.filter((m) => m.startsWith('.')).flatMap((m) => tsCandidates(m, path));
}

const under = (dir: string, rel: string): string => (dir === '.' ? rel : `${dir}/${rel}`);
/** The first word of each name of an import list: `a as b, (c,\n d)` gives a, c, d. */
const names = (list: string): string[] => list.replace(/[()]/g, '').split(',').map((n) => n.trim().split(/\s+/)[0]!).filter(Boolean);

/** `dir` and each folder above it, up to the repository's root: where pytest's `rootdir`, `prepend` or a subproject can put a module. */
function ancestors(dir: string): string[] {
  const out = [dir];
  while (out.at(-1) !== '.') out.push(posix.dirname(out.at(-1)!));
  return out;
}

/**
 * The repository paths a Python file's imports could be: `from .x import y`, `from . import x`, `from a.b import c` (`c` maybe a
 * submodule), `import a.b`, a parenthesized list across lines. An absolute module is looked for from the file's folder up to the root.
 */
function pythonImports(path: string, source: string): string[] {
  const dir = posix.dirname(path);
  const out: string[] = [];
  const at = (base: string) => (dotted: string) => pyModule(dotted).map((rel) => under(base, rel));
  const roots = ancestors(dir);
  const absolute = (dotted: string) => roots.flatMap((d) => at(d)(dotted));
  for (const m of source.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+(\([^)]*\)|[^#\n]+)/gm)) {
    const [dots, module, list] = [m[1]!, m[2]!, m[3]!];
    // Each imported name may be a submodule of the package.
    const dotted = [...(module ? [module] : []), ...names(list).map((n) => (module ? `${module}.${n}` : n))];
    if (!dots) {
      out.push(...dotted.flatMap(absolute));
      continue;
    }
    const base = posix.normalize(posix.join(dir, ...Array<string>(dots.length - 1).fill('..')));
    out.push(...dotted.flatMap(at(base)));
  }
  for (const m of source.matchAll(/^\s*import\s+([^#\n]+)/gm)) out.push(...names(m[1]!).flatMap(absolute));
  return out;
}

/**
 * The generators of the property tests `files`: every test file of the repository they import, then those import, in
 * sorted order. Never the code under test, which is no test file, nor the property tests themselves.
 */
export async function propertySupport(files: readonly string[], view: Pick<FreezeView, 'filesAtHead' | 'showAtHead'>): Promise<string[]> {
  const atHead = new Set((await view.filesAtHead()).map(normalizePath));
  const own = new Set(files.map(normalizePath));
  const seen = new Set(own);
  const queue = [...own];
  while (queue.length) {
    const file = queue.shift()!;
    const source = await view.showAtHead(file);
    if (source === undefined) continue;
    for (const candidate of isPython(file) ? pythonImports(file, source) : scriptImports(file, source)) {
      if (seen.has(candidate) || !atHead.has(candidate) || !isTestFile(candidate)) continue;
      seen.add(candidate);
      queue.push(candidate);
    }
  }
  return [...seen].filter((f) => !own.has(f)).sort();
}
