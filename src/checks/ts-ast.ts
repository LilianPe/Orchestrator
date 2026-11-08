// The TypeScript parser for the deterministic checks (ORC-342): they read the syntax tree of a JS or TS file, not its
// text, so a rewrite (an alias, another syntax) reads the same. No type checker, no other file: one file, as it is.
import ts from 'typescript';

export { ts };

/** A file the checks read as JS or TS: the script blocks of a Vue, Svelte or Astro component included. */
export const isScript = (path: string): boolean => /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/.test(path);

const COMPONENT = /\.(?:vue|svelte|astro)$/;

function kindOf(path: string): ts.ScriptKind {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.[cm]?jsx?$/.test(path)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

// A component keeps its `<script>` blocks and its Astro frontmatter; the rest is blanked, its line breaks kept, so a
// position still maps to its line.
function scriptsOf(text: string): string {
  const keep: [number, number][] = [];
  for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) keep.push([m.index + m[1]!.length, m.index + m[1]!.length + m[2]!.length]);
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front) keep.push([4, 4 + front[1]!.length]);
  let out = '';
  let at = 0;
  for (const [from, to] of keep.sort((a, b) => a[0] - b[0])) {
    out += text.slice(at, from).replace(/[^\n]/g, ' ') + text.slice(from, to);
    at = to;
  }
  return out + text.slice(at).replace(/[^\n]/g, ' ');
}

/** The syntax tree of a file, parents set. The parser recovers from any error: there is always a tree. */
export function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, COMPONENT.test(path) ? scriptsOf(text) : text, ts.ScriptTarget.Latest, true, kindOf(path));
}

/** 1-based line of a position. */
export const lineOf = (sf: ts.SourceFile, pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

/** The text of a string literal or of a template without substitutions; undefined for anything else. */
export function stringValue(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

/** The name a property access reads, `a.b` or `a['b']`; undefined for a computed one. */
export function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return stringValue(node.argumentExpression);
  return undefined;
}

/** The names a binding declares: `a`, and every name of `{ a, b: [c] }`. */
export function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : boundNames(e.name)));
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind);

/** What a module exports by name, `default` included. `export * from` names nothing: its names are another file's. */
export function exportedNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s)) {
      if (s.exportClause && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) names.add(e.name.text);
      else if (s.exportClause) names.add(s.exportClause.name.text);
    } else if (ts.isExportAssignment(s)) names.add('default');
    else if (hasModifier(s, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(s, ts.SyntaxKind.DefaultKeyword)) names.add('default');
      else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) for (const n of boundNames(d.name)) names.add(n);
      else if ('name' in s && s.name && ts.isIdentifier(s.name as ts.Node)) names.add((s.name as ts.Identifier).text);
    }
  }
  return names;
}

/** The module a file imports `symbol` from by name (`import { symbol }`, `import { symbol as other }`). */
export function importedFrom(sf: ts.SourceFile, symbol: string): string | undefined {
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const bindings = s.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((e) => (e.propertyName ?? e.name).text === symbol)) return s.moduleSpecifier.text;
  }
  return undefined;
}
