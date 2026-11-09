import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff.js';
import { addedLines, isRepoRuleFile, semgrepArgv, semgrepCheck, semgrepFindings } from './semgrep.js';

const result = (path: string, start: number, end = start) => ({ check_id: 'r', path, start: { line: start }, end: { line: end }, extra: { message: 'm' } });
const ran = (results: unknown[]) => ({ stdout: JSON.stringify({ results, errors: [] }), stderr: '', code: 0 });

describe('semgrep (ORC-333)', () => {
  it('reads the lines each file adds, by its path after the change, and leaves out a file that adds none', () => {
    const diff = parseDiff(
      [
        'diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -2,0 +3,2 @@', '+x', '+y',
        'diff --git a/gone.js b/gone.js', 'deleted file mode 100644', '--- a/gone.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-z',
        'diff --git a/old.js b/new.js', 'similarity index 100%', 'rename from old.js', 'rename to new.js',
      ].join('\n'),
    );
    expect(addedLines(diff)).toEqual(new Map([['a.js', new Set([3, 4])]]));
  });

  it('keeps a finding only when one of its lines is added, at the first of them', () => {
    const added = new Map([['a.js', new Set([3, 4])]]);
    const found = semgrepFindings(ran([result('a.js', 1), result('a.js', 2, 4), result('b.js', 3)]), added);
    expect(found).toEqual([{ path: 'a.js', line: 3, rule: 'r', message: 'm' }]);
    expect(semgrepCheck(found)).toMatchObject({ check: 'factory/semgrep', ok: false, summary: expect.stringContaining('- `a.js`:3 (r): m') });
    expect(semgrepCheck([]).ok).toBe(true);
  });

  it("throws on anything but a clean exit with a report, with Semgrep's own errors", () => {
    expect(() => semgrepFindings({ stdout: JSON.stringify({ results: [], errors: [{ long_msg: 'Invalid rule schema' }] }), stderr: '', code: 7 }, new Map())).toThrow('semgrep could not run (code 7): Invalid rule schema');
    expect(() => semgrepFindings({ stdout: '', stderr: 'semgrep: not found', code: 127 }, new Map())).toThrow('semgrep: not found');
    expect(() => semgrepFindings({ stdout: '{}', stderr: '', code: 0 }, new Map())).toThrow('no readable report');
  });

  it('turns off what the branch could write to silence it, and ends the options before the paths', () => {
    const argv = semgrepArgv(['/rules'], ['-a.js'], { maxBytes: 9, timeoutS: 5 });
    expect(argv.slice(0, 4)).toEqual(['timeout', '5', 'semgrep', 'scan']);
    expect(argv).toEqual(expect.arrayContaining(['--disable-nosem', '--no-git-ignore', '--metrics=off', '--disable-version-check', '--json']));
    expect(argv.slice(-2)).toEqual(['--', '-a.js']);
  });

  it('takes YAML files under .factory/semgrep/ as the repository\'s rules', () => {
    expect(['.factory/semgrep/a.yml', '.factory/semgrep/x/b.yaml', '.factory/semgrep/notes.md', '.semgrep.yml'].filter(isRepoRuleFile)).toEqual(['.factory/semgrep/a.yml', '.factory/semgrep/x/b.yaml']);
  });
});
