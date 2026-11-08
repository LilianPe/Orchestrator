import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff.js';

const diff = (...lines: string[]): string => lines.join('\n') + '\n';

describe('parseDiff', () => {
  it('numbers added and kept lines in the new file, removed and kept lines in the old one, across hunks', () => {
    const [f] = parseDiff(
      diff(
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1111111..2222222 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,3 +1,4 @@',
        ' one',
        '-two',
        '+deux',
        '+trois',
        ' four',
        '@@ -20,2 +21,2 @@ function f() {',
        ' keep',
        '-old',
        '+new',
        '\\ No newline at end of file',
      ),
    );
    expect(f).toEqual({
      path: 'src/a.ts',
      status: 'modified',
      added: [
        { line: 2, text: 'deux' },
        { line: 3, text: 'trois' },
        { line: 22, text: 'new' },
      ],
      removed: [
        { line: 2, text: 'two' },
        { line: 21, text: 'old' },
      ],
      kept: [
        { line: 1, old: 1, text: 'one' },
        { line: 4, old: 3, text: 'four' },
        { line: 21, old: 20, text: 'keep' },
      ],
    });
  });

  it('reads added, deleted, renamed and binary files', () => {
    const files = parseDiff(
      diff(
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1 @@',
        '+export {};',
        'diff --git a/gone.ts b/gone.ts',
        'deleted file mode 100644',
        '--- a/gone.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-x',
        'diff --git a/old name.ts b/new name.ts',
        'similarity index 100%',
        'rename from old name.ts',
        'rename to new name.ts',
        'diff --git a/logo.png b/logo.png',
        'Binary files a/logo.png and b/logo.png differ',
      ),
    );
    expect(files.map(({ path, oldPath, status, added, removed }) => ({ path, oldPath, status, added: added.length, removed: removed.length }))).toEqual([
      { path: 'new.ts', oldPath: undefined, status: 'added', added: 1, removed: 0 },
      { path: 'gone.ts', oldPath: undefined, status: 'deleted', added: 0, removed: 1 },
      { path: 'new name.ts', oldPath: 'old name.ts', status: 'renamed', added: 0, removed: 0 },
      { path: 'logo.png', oldPath: undefined, status: 'modified', added: 0, removed: 0 },
    ]);
  });

  it('reads an added line that looks like a header, CRLF output and quoted paths', () => {
    const [f] = parseDiff(
      [
        'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
        '--- "a/caf\\303\\251.ts"',
        '+++ "b/caf\\303\\251.ts"',
        '@@ -1,0 +1,2 @@',
        '+++ not a header',
        '+--- nor this',
        '',
      ].join('\r\n'),
    );
    expect(f!.path).toBe('café.ts');
    expect(f!.added).toEqual([
      { line: 1, text: '++ not a header' },
      { line: 2, text: '--- nor this' },
    ]);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseDiff('')).toEqual([]);
  });
});
