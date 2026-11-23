// The tests of a spec's « for any input » properties (ORC-261): the factory names the file of each approved property, the
// `tests` step writes it, and the freeze holds it with the generators it imports.
import { posix } from 'node:path';
import { isTestFile, normalizePath } from './test-files.js';
import { isPython, parse, ts } from './ts-ast.js';

/** The file named for the test of approved property `n` (from 1) of `ticketId`: in TypeScript or JavaScript, or in Python. */
export function propertyTestFiles(ticketId: string, n: number): { ts: string; py: string } {
  const id = ticketId.toLowerCase();
  return { ts: `${id}.property-${n}.test.ts`, py: `test_${id.replace(/[^a-z0-9]/g, '_')}_property_${n}.py` };
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `path` is the test of property `n`: its named file, in any directory, `.spec` and any JS or TS extension allowed. */
function isPropertyTest(ticketId: string, n: number, path: string): boolean {
  const name = normalizePath(path).split('/').at(-1) ?? '';
  const { ts: named, py } = propertyTestFiles(ticketId, n);
  const stem = escape(named.replace(/\.test\.ts$/, ''));
  return name === py || new RegExp(`^${stem}\\.(?:test|spec)\\.[cm]?[jt]sx?$`).test(name);
}

/** The approved properties (numbered from 1, `count` of them) none of `paths` is the test of. */
export function missingProperties(ticketId: string, count: number, paths: readonly string[]): number[] {
  return Array.from({ length: count }, (_, i) => i + 1).filter((n) => !paths.some((p) => isPropertyTest(ticketId, n, p)));
}

/** Of `paths`, the tests of the approved properties (`count` of them). */
export function propertyTests(ticketId: string, count: number, paths: readonly string[]): string[] {
  return paths.filter((p) => Array.from({ length: count }, (_, i) => i + 1).some((n) => isPropertyTest(ticketId, n, p)));
}

const TS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** The repository paths the relative module `module`, imported by `from`, could be. */
function scriptCandidates(module: string, from: string): string[] {
  if (!module.startsWith('.')) return [];
  const path = posix.normalize(posix.join(posix.dirname(from), module));
  const stem = path.replace(/\.[cm]?jsx?$/, '');
  return [path, ...TS_EXT.map((e) => stem + e), ...TS_EXT.map((e) => `${stem}/index${e}`)];
}

/** The modules a JS or TS file imports or re-exports by a string: `import`, `export … from`, `import()`, `require()`. */
function scriptImports(path: string, source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(path, source));
  return found.flatMap((m) => scriptCandidates(m, path));
}

const pyModule = (dotted: string): string[] => [`${dotted.replace(/\./g, '/')}.py`, `${dotted.replace(/\./g, '/')}/__init__.py`];

/** The repository paths a Python file's imports could be: `from .x import y`, `from . import x`, `from a.b import c`, `import a.b`. */
function pythonImports(path: string, source: string): string[] {
  const dir = posix.dirname(path);
  const out: string[] = [];
  for (const m of source.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+([^#\n]+)/gm)) {
    const [dots, module, names] = [m[1]!, m[2]!, m[3]!];
    if (!dots) {
      out.push(...pyModule(module));
      continue;
    }
    const base = posix.normalize(posix.join(dir, ...Array<string>(dots.length - 1).fill('..')));
    const at = (rel: string) => (base === '.' ? rel : `${base}/${rel}`);
    if (module) out.push(...pyModule(module).map(at));
    // `from . import cells`: each name may be a module of the package.
    else for (const name of names.replace(/[()]/g, '').split(',')) out.push(...pyModule(name.trim().split(/\s+/)[0]!).map(at));
  }
  for (const m of source.matchAll(/^\s*import\s+([^#\n]+)/gm)) {
    for (const part of m[1]!.split(',')) out.push(...pyModule(part.trim().split(/\s+/)[0]!));
  }
  return out;
}

/** A commit of the branch as the freeze reads it. */
export interface SupportView {
  filesAtHead(): Promise<string[]>;
  showAtHead(path: string): Promise<string | undefined>;
}

/**
 * The generators of the property tests `files`: every test file of the repository they import, then those import, in
 * sorted order. Never the code under test, which is no test file, nor the property tests themselves.
 */
export async function propertySupport(files: readonly string[], view: SupportView): Promise<string[]> {
  const atHead = new Set((await view.filesAtHead()).map(normalizePath));
  const own = new Set(files.map(normalizePath));
  const seen = new Set(own);
  const queue = [...own];
  const support = new Set<string>();
  while (queue.length) {
    const file = queue.shift()!;
    const source = await view.showAtHead(file);
    if (source === undefined) continue;
    for (const candidate of isPython(file) ? pythonImports(file, source) : scriptImports(file, source)) {
      if (seen.has(candidate) || !atHead.has(candidate) || !isTestFile(candidate)) continue;
      seen.add(candidate);
      support.add(candidate);
      queue.push(candidate);
    }
  }
  return [...support].sort();
}
