// The anti-cheat forms in JS and TS, read on the syntax tree (ORC-342): a rewrite reads the same as the plain form. An
// alias (`const later = it.skip`, `import { test as check }`, `const { exit } = process`), another syntax (`it['skip']`,
// `test(name, { skip: true }, fn)`, `switch (process.env.NODE_ENV)`), a constant spelled in parts (`'te' + 'st'`).
// Aliases are read file-wide, by name, in the order of the file: no scopes, no other file.
import { boundNames, lineOf, parse, stringValue, ts } from './ts-ast.js';

/** A test file, the test runner's configuration and global setup, or anything else. */
export type FileKind = 'test' | 'harness' | 'code';

export type ScriptForm = 'disabled-test' | 'bypass' | 'test-only-behaviour';

export interface ScriptFinding {
  form: ScriptForm;
  /** First and last line of what was found, 1-based, and its column for the order of a line. */
  line: number;
  last: number;
  column: number;
  match: string;
}

const TEST_API = new Set(['it', 'test', 'describe', 'suite', 'context', 'bench']);
const SUITES = new Set(['describe', 'suite', 'context', 'xdescribe', 'fdescribe']);
const MODIFIERS = new Set(['skip', 'only', 'todo', 'skipIf', 'runIf']);
const OPTIONS = new Set(['skip', 'only', 'todo']);
// Disabled wherever they are; focused in a test file only: outside tests, `fit(` is too often a real function.
const DISABLED = new Set(['xit', 'xdescribe', 'xtest']);
const FOCUSED = new Set(['fit', 'fdescribe']);
/** The globals whose aliases are followed. */
const KNOWN = new Set([...TEST_API, ...DISABLED, ...FOCUSED, 'expect', 'assert', 'process', 'exit']);
// A module whose namespace or default import holds the test API, and the modules of the assertions and of `process`.
const TEST_MODULES = new Set(['vitest', '@jest/globals', 'node:test', 'bun:test', '@playwright/test']);
const ASSERT_MODULES = new Set(['assert', 'node:assert', 'assert/strict', 'node:assert/strict', 'chai']);
const PROCESS_MODULES = new Set(['process', 'node:process']);
const NAMESPACE = '@ns';
// An assertion on one value, and one of two: true on constants whatever the code does.
const ASSERT_ONE = new Set(['assert', 'assert.ok', 'assert.isOk', 'assert.isTrue', 'assert.true']);
const ASSERT_TWO = new Set(['assert.equal', 'assert.strictEqual', 'assert.deepEqual', 'assert.deepStrictEqual']);
const RUNNER_ENV = /\b(?:VITEST(?:_[A-Z_]+)?|JEST_WORKER_ID|PYTEST_CURRENT_TEST)\b/;
// A checker directive at the start of a comment, or of a line of one: all three TypeScript ones silence the type checker;
// an ESLint configuration comment turns a rule off.
const DIRECTIVE = /^[\s/*]*(eslint-disable\b|@ts-(?:ignore|nocheck|expect-error)\b|eslint\s+[\w/@-]+\s*:\s*(?:(["'])off\2|off\b|0\b))/;
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

/** Parentheses, type assertions and `!` changed nothing. */
function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

/** What a file binds, read once before its rules. */
class Bindings {
  /** A local name for a known global: `check` for `test`, `assert.equal` for an imported `equal`. */
  readonly aliases = new Map<string, string>();
  /** `const` names of a constant value. */
  readonly constants = new Map<string, ts.Expression>();
  /** Names bound to the test mode (`NODE_ENV`, Vite's `env.MODE`). */
  readonly modes = new Set<string>();
  /** Names a function parameter binds: a test's context (`context.skip()`, `({ skip }) => skip()`). */
  readonly params = new Set<string>();

  constructor(sf: ts.SourceFile) {
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) this.importOf(node);
      else if (ts.isVariableDeclaration(node) && node.initializer) this.declare(node, node.initializer);
      else if (ts.isParameter(node)) for (const n of boundNames(node.name)) this.params.add(n);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  private moduleAlias(module: string, imported: string): string | undefined {
    if (ASSERT_MODULES.has(module)) return ['default', 'strict', 'ok', 'assert'].includes(imported) ? 'assert' : `assert.${imported}`;
    if (PROCESS_MODULES.has(module)) return imported === 'default' ? 'process' : imported === 'exit' ? 'exit' : undefined;
    if (imported === 'default') return module === 'node:test' ? 'test' : TEST_MODULES.has(module) ? NAMESPACE : undefined;
    return KNOWN.has(imported) ? imported : undefined;
  }

  private importOf(node: ts.ImportDeclaration): void {
    const module = stringValue(node.moduleSpecifier);
    const clause = node.importClause;
    if (module === undefined || !clause) return;
    const set = (local: string, canonical: string | undefined) => canonical && this.aliases.set(local, canonical);
    if (clause.name) set(clause.name.text, this.moduleAlias(module, 'default'));
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) set(bindings.name.text, TEST_MODULES.has(module) ? NAMESPACE : this.moduleAlias(module, 'default'));
    else if (bindings) for (const e of bindings.elements) set(e.name.text, this.moduleAlias(module, (e.propertyName ?? e.name).text));
  }

  private declare(node: ts.VariableDeclaration, init: ts.Expression): void {
    if (ts.isIdentifier(node.name)) {
      const canonical = this.canonical(init);
      if (canonical !== undefined && (KNOWN.has(canonical) || canonical === NAMESPACE || canonical.startsWith('assert'))) this.aliases.set(node.name.text, canonical);
      if (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const && this.isConstant(init)) this.constants.set(node.name.text, init);
      if (this.containsMode(init)) this.modes.add(node.name.text);
      return;
    }
    if (!ts.isObjectBindingPattern(node.name)) return;
    const from = this.canonical(init);
    for (const e of node.name.elements) {
      const prop = e.propertyName ? (ts.isIdentifier(e.propertyName) ? e.propertyName.text : stringValue(e.propertyName)) : ts.isIdentifier(e.name) ? e.name.text : undefined;
      if (prop === undefined || !ts.isIdentifier(e.name)) continue;
      const local = e.name.text;
      const canonical = from === NAMESPACE ? (KNOWN.has(prop) ? prop : undefined) : from === 'process' && prop === 'exit' ? 'exit' : from === 'assert' ? this.moduleAlias('assert', prop) : undefined;
      if (canonical) this.aliases.set(local, canonical);
      if (prop === 'NODE_ENV' || (prop === 'MODE' && this.nameOf(unwrap(init)) === 'env')) this.modes.add(local);
    }
  }

  /** The value of a constant string: a literal, a sum of them, a `const` bound to one. */
  constString(e: ts.Expression, depth = 0): string | undefined {
    e = unwrap(e);
    const literal = stringValue(e);
    if (literal !== undefined || depth > 8) return literal;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const [l, r] = [this.constString(e.left, depth + 1), this.constString(e.right, depth + 1)];
      return l === undefined || r === undefined ? undefined : l + r;
    }
    const bound = ts.isIdentifier(e) ? this.constants.get(e.text) : undefined;
    return bound ? this.constString(bound, depth + 1) : undefined;
  }

  /** The name a property access reads: `a.b`, `a['b']`, `a['' + 'b']`. */
  nameOf(e: ts.Node): string | undefined {
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    if (ts.isElementAccessExpression(e)) return this.constString(e.argumentExpression);
    return undefined;
  }

  /** The known global an expression is: an alias followed, `vitest.it`, `globalThis.process`, `process.exit`, `require('assert')`. */
  canonical(e: ts.Expression): string | undefined {
    e = unwrap(e);
    if (ts.isIdentifier(e)) return this.aliases.get(e.text) ?? e.text;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require') {
      const module = stringValue(e.arguments[0]);
      return module === undefined ? undefined : TEST_MODULES.has(module) ? NAMESPACE : this.moduleAlias(module, 'default');
    }
    if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return undefined;
    const name = this.nameOf(e);
    const of = this.canonical(e.expression);
    if (name === undefined || of === undefined) return undefined;
    if (of === NAMESPACE) return KNOWN.has(name) ? name : undefined;
    if (of === 'globalThis' || of === 'global' || of === 'window') return name;
    if (of === 'assert') return name === 'strict' ? 'assert' : `assert.${name}`;
    if (of === 'process') return name === 'exit' ? 'exit' : undefined;
    if (of === 'expect') return name === 'soft' ? 'expect' : undefined;
    return undefined;
  }

  /** The test function a call chain starts from: `it` of `it.each(rows)(name, fn)`, `describe` of `v.describe.skip`. */
  testRoot(e: ts.Expression): string | undefined {
    for (let depth = 0; depth < 16; depth++) {
      e = unwrap(e);
      if (ts.isCallExpression(e)) e = e.expression;
      else if (ts.isTaggedTemplateExpression(e)) e = e.tag;
      else if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
        const canonical = this.canonical(e);
        if (canonical !== undefined && KNOWN.has(canonical)) return canonical;
        e = e.expression;
      } else return ts.isIdentifier(e) ? this.canonical(e) : undefined;
    }
    return undefined;
  }

  /** A value the code under test cannot change: literals and what is made of them only, a `const` of one. */
  isConstant(e: ts.Expression, depth = 0): boolean {
    e = unwrap(e);
    if (depth > 8) return false;
    const constant = (x: ts.Expression) => this.isConstant(x, depth + 1);
    switch (e.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NumericLiteral:
      case ts.SyntaxKind.BigIntLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
      case ts.SyntaxKind.NullKeyword:
      case ts.SyntaxKind.VoidExpression:
        return true;
    }
    if (ts.isIdentifier(e)) {
      // A `const` array or object can still be filled: only a primitive one is a constant.
      const bound = this.constants.get(e.text);
      const primitive = bound !== undefined && !ts.isArrayLiteralExpression(unwrap(bound)) && !ts.isObjectLiteralExpression(unwrap(bound));
      return ['undefined', 'NaN', 'Infinity'].includes(e.text) || (primitive && constant(bound));
    }
    if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => constant(s.expression));
    if (ts.isPrefixUnaryExpression(e) || ts.isTypeOfExpression(e)) return constant(ts.isTypeOfExpression(e) ? e.expression : e.operand);
    if (ts.isBinaryExpression(e)) return constant(e.left) && constant(e.right);
    if (ts.isConditionalExpression(e)) return constant(e.condition) && constant(e.whenTrue) && constant(e.whenFalse);
    if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => !ts.isSpreadElement(x) && constant(x));
    if (ts.isObjectLiteralExpression(e)) return e.properties.every((p) => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && constant(p.initializer));
    return false;
  }

  /** A read of the test mode: `process.env.NODE_ENV`, `import.meta.env.MODE`, a name bound to one. */
  isMode(e: ts.Expression): boolean {
    e = unwrap(e);
    if (ts.isIdentifier(e)) return this.modes.has(e.text);
    const name = this.nameOf(e);
    return name === 'NODE_ENV' || (name === 'MODE' && this.nameOf(unwrap((e as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)) === 'env');
  }

  /** An expression that reads the test mode, outside the functions it holds. */
  containsMode(e: ts.Node): boolean {
    if (ts.isFunctionLike(e)) return false;
    if (ts.isExpression(e) && this.isMode(e)) return true;
    return !!ts.forEachChild(e, (c) => this.containsMode(c) || undefined);
  }

  isTest(e: ts.Expression): boolean {
    return this.constString(e) === 'test';
  }

  /** `'test'`, a list holding it, a regex reading it. */
  holdsTest(e: ts.Expression): boolean {
    e = unwrap(e);
    return this.isTest(e) || (ts.isArrayLiteralExpression(e) && e.elements.some((x) => this.isTest(x))) || (ts.isRegularExpressionLiteral(e) && /test/.test(e.text));
  }
}

/** An identifier read as a value: not a property's name, not the name a declaration gives. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === id) return false;
  if ((ts.isBindingElement(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === id) return false;
  return ts.isShorthandPropertyAssignment(p) || !('name' in p) || (p as { name?: ts.Node }).name !== id;
}

/** The comments of a file, each once: the trivia around every token (but JSX text, which is not trivia). */
function commentsOf(sf: ts.SourceFile): ts.CommentRange[] {
  const seen = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node): void => {
    // A JSDoc node sits inside its comment: read from there, its text would pass for trivia.
    if (node.kind === ts.SyntaxKind.JsxText || (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)) return;
    // Leading trivia starts at the next line: the end of a line is the trailing trivia of the token before.
    for (const r of [...(ts.getLeadingCommentRanges(sf.text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(sf.text, node.end) ?? [])]) seen.set(r.pos, r);
    if (node.kind >= ts.SyntaxKind.FirstNode) for (const c of node.getChildren(sf)) visit(c);
  };
  visit(sf);
  return [...seen.values()];
}

/** The anti-cheat findings of a JS or TS file, wherever they are in it: the caller keeps those on its added lines. */
export function scanScript(path: string, text: string, kind: FileKind): ScriptFinding[] {
  const sf = parse(path, text);
  const b = new Bindings(sf);
  const findings: ScriptFinding[] = [];
  const at = (node: ts.Node, form: ScriptForm, match = node.getText(sf), last = node.end): void => {
    const start = node.getStart(sf);
    findings.push({ form, line: lineOf(sf, start), last: lineOf(sf, last), column: sf.getLineAndCharacterOfPosition(start).character, match });
  };
  const test = kind === 'test';

  const visit = (node: ts.Node): void => {
    // 2. Disabling, in a test file: a modifier of the test API, an options object, a test context's `skip()`.
    if (test && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const name = b.nameOf(node);
      if (name !== undefined && MODIFIERS.has(name) && TEST_API.has(b.testRoot(node.expression) ?? '')) at(node, 'disabled-test');
    }
    if (test && ts.isBindingElement(node) && ts.isVariableDeclaration(node.parent.parent) && node.parent.parent.initializer) {
      const prop = node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName.text : ts.isIdentifier(node.name) ? node.name.text : '';
      if (MODIFIERS.has(prop) && TEST_API.has(b.canonical(node.parent.parent.initializer) ?? '')) at(node, 'disabled-test');
    }
    if (ts.isIdentifier(node) && isReference(node)) {
      const canonical = b.canonical(node) ?? '';
      if (DISABLED.has(canonical) || (test && FOCUSED.has(canonical))) at(node, 'disabled-test');
    }
    if (ts.isCallExpression(node)) call(node);
    // Tests left out by the runner: jest's ignore list, pytest's `--deselect`. Vitest's `exclude` is not read: the same
    // key leaves files out of coverage.
    if (kind !== 'test' && ts.isIdentifier(node) && node.text === 'testPathIgnorePatterns') at(node, 'disabled-test');
    const literal = stringValue(node) ?? (ts.isTemplateLiteralToken(node) ? node.text : undefined);
    if (literal !== undefined) strings(node, literal);
    // 4. Code that behaves differently under test, outside tests and their harness only.
    if (kind === 'code') mode(node);
    ts.forEachChild(node, visit);
  };

  const call = (node: ts.CallExpression): void => {
    const callee = unwrap(node.expression);
    const [first, second] = node.arguments;
    if (test) {
      const receiver = (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && b.nameOf(callee) === 'skip' ? unwrap(callee.expression) : undefined;
      const context = receiver && (receiver.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(receiver) && b.params.has(receiver.text))) && !TEST_API.has(b.testRoot(receiver) ?? '');
      if (context || (ts.isIdentifier(callee) && callee.text === 'skip' && b.params.has('skip'))) at(callee, 'disabled-test');
      if (TEST_API.has(b.testRoot(callee) ?? '')) {
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) continue;
          for (const p of arg.properties) {
            const name = (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) ? p.name.text : '';
            const off = ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.FalseKeyword;
            if (OPTIONS.has(name) && !off) at(p, 'disabled-test');
          }
        }
      }
    }
    // 3. Bypasses: an assertion on constants, leaving with success before the tests can fail.
    const canonical = b.canonical(callee) ?? '';
    const constantFirst = first !== undefined && b.isConstant(first);
    const assertion = canonical === 'expect' ? constantFirst && matchedOnConstants(node) : ASSERT_ONE.has(canonical) ? constantFirst : ASSERT_TWO.has(canonical) && constantFirst && second !== undefined && b.isConstant(second);
    if (assertion) at(node, 'bypass');
    if (canonical === 'exit' && (node.arguments.length === 0 || (node.arguments.length === 1 && first !== undefined && ts.isNumericLiteral(unwrap(first)) && Number(unwrap(first).getText(sf)) === 0))) at(node, 'bypass');
  };

  // `expect(c).toBe(d)`, `.not.toEqual(d)`, `.toBeTruthy()`: the matcher compares with constants only, or with nothing.
  // `expect(1).toBe(count())` is an assertion written backwards, not a constant one.
  const matchedOnConstants = (expectCall: ts.CallExpression): boolean => {
    let chain: ts.Node = expectCall;
    while (ts.isPropertyAccessExpression(chain.parent) && chain.parent.expression === chain) chain = chain.parent;
    const matcher = chain.parent;
    return !(ts.isCallExpression(matcher) && matcher.expression === chain) || matcher.arguments.every((a) => b.isConstant(a));
  };

  const strings = (node: ts.Node, value: string): void => {
    if (kind === 'test') return;
    // Tests run `git commit --no-verify` in throwaway repositories: not a bypass of this one.
    if (value.includes('--no-verify')) at(node, 'bypass', '--no-verify');
    if (value.includes('--deselect')) at(node, 'disabled-test', '--deselect');
    if (value.includes('testPathIgnorePatterns')) at(node, 'disabled-test', 'testPathIgnorePatterns');
  };

  const mode = (node: ts.Node): void => {
    const literal = stringValue(node);
    const env = ts.isIdentifier(node) ? (RUNNER_ENV.test(node.text) ? node.text : undefined) : literal !== undefined ? RUNNER_ENV.exec(literal)?.[0] : undefined;
    if (env !== undefined && (!ts.isIdentifier(node) || node.text === env)) at(node, 'test-only-behaviour', env);
    if (ts.isElementAccessExpression(node) && stringValue(node.argumentExpression) === undefined) {
      const spelled = RUNNER_ENV.exec(b.constString(node.argumentExpression) ?? '')?.[0];
      if (spelled) at(node.argumentExpression, 'test-only-behaviour', spelled);
    }
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      if ((b.containsMode(node.left) && b.isTest(node.right)) || (b.isTest(node.left) && b.containsMode(node.right))) at(node, 'test-only-behaviour');
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const parts = [...(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? [callee.expression] : []), ...node.arguments];
      if (parts.some((p) => b.containsMode(p)) && parts.some((p) => b.holdsTest(p) && !b.containsMode(p))) at(node, 'test-only-behaviour');
    } else if (ts.isSwitchStatement(node) && b.containsMode(node.expression)) {
      const clause = node.caseBlock.clauses.find((c) => ts.isCaseClause(c) && b.isTest(c.expression)) as ts.CaseClause | undefined;
      if (clause) at(node, 'test-only-behaviour', `switch (${node.expression.getText(sf)}) case ${clause.expression.getText(sf)}`, clause.expression.end);
    } else if (ts.isElementAccessExpression(node) && b.containsMode(node.argumentExpression)) {
      const table = unwrap(node.expression);
      const keys = ts.isObjectLiteralExpression(table) ? table.properties.map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined)) : [];
      if (keys.includes('test')) at(node, 'test-only-behaviour');
    }
  };

  visit(sf);
  for (const c of commentsOf(sf)) {
    sf.text.slice(c.pos, c.end).split('\n').forEach((line, i) => {
      const m = DIRECTIVE.exec(line);
      if (!m) return;
      const lineNo = lineOf(sf, c.pos) + i;
      findings.push({ form: 'bypass', line: lineNo, last: lineNo, column: i === 0 ? sf.getLineAndCharacterOfPosition(c.pos).character : 0, match: m[1]! });
    });
  }
  return findings.sort((x, y) => x.line - y.line || x.column - y.column);
}

/**
 * The tests a JS or TS test file declares, by name, nested under their suites (`scores > rounds`): a title that is not a
 * constant reads as its source. A name declared twice counts twice.
 */
export function scriptTests(path: string, text: string): string[] {
  const sf = parse(path, text);
  const b = new Bindings(sf);
  const names: string[] = [];
  const visit = (node: ts.Node, suites: string[]): void => {
    if (ts.isCallExpression(node)) {
      const root = b.testRoot(node.expression) ?? '';
      if (TEST_API.has(root) || DISABLED.has(root) || FOCUSED.has(root)) {
        const [title] = node.arguments;
        const name = [...suites, title ? (b.constString(title) ?? title.getText(sf)) : ''];
        if (SUITES.has(root)) for (const arg of node.arguments) visit(arg, name);
        else names.push(name.join(' > '));
        return;
      }
    }
    ts.forEachChild(node, (c) => visit(c, suites));
  };
  visit(sf, []);
  return names;
}
