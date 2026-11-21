import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ORC-181 AC1: nothing in src/ runs the `gh` executable; the daemon reads and writes GitHub by its App alone. A call names
// the program in a string, `exec('gh', …)` or a command line `'gh pr view …'`: every string of the code is read, comments not.
const root = join(import.meta.dirname, '..');

const sourceFiles = readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && /\.(ts|mts|js|mjs)$/.test(e.name) && !/\.test\.ts$/.test(e.name))
  .map((e) => join(e.parentPath, e.name).slice(root.length + 1).split(sep).join('/'));

const GH = /^gh(\s|$)/;

/** The strings of `code` that name `gh` as a program: `'gh'` alone, or a command line starting with it. */
function ghCalls(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) && GH.test(node.text.trimStart()))
      found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.getText()}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('no gh executable in src/ (ORC-181)', () => {
  it('finds a call to gh, as an argument or a command line, and not the word in a comment or a sentence', () => {
    const probe = [
      "await execCmd('gh', ['pr', 'view']);",
      'run(`gh pr diff ${n}`);',
      'spawn("gh api repos");',
      '// gh pr view, `gh` in a comment',
      "const said = 'the gh fallback is gone';",
      "const kind = 'gh-write';",
    ].join('\n');
    expect(ghCalls('probe.ts', probe)).toHaveLength(3);
  });

  it('has none in any source file of src/', () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    expect(sourceFiles.flatMap((f) => ghCalls(f, readFileSync(join(root, f), 'utf8')))).toEqual([]);
  });

  it('has neither the gh forge nor the 30-second PR poll left', () => {
    const gone = ['src/adapters/forge/gh-cli.ts', 'src/adapters/forge/pr-poller.ts'];
    expect(gone.filter((p) => existsSync(join(root, p)))).toEqual([]);
  });
});
