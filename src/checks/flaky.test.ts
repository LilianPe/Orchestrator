import { describe, expect, it } from 'vitest';
import { MAX_BASE_RERUNS, needsBase, readTests, rerunLine, rerunOnBase, runAndRerun, settle, withoutLine, type CommandRun, type Run, type TestRun } from './flaky.js';

type Status = 'passed' | 'failed';

/** A vitest or jest JSON report, the file as a sandbox names it, under `/work`. */
const json = (tests: Record<string, Status>, file = '/work/src/a.test.ts'): string =>
  JSON.stringify({
    testResults: [
      {
        name: file,
        assertionResults: Object.entries(tests).map(([fullName, status]) => ({
          fullName,
          title: fullName.split(' ').at(-1),
          status,
          duration: 12,
          failureMessages: status === 'failed' ? [`\u001b[31mAssertionError: ${fullName} broke\u001b[39m`] : [],
        })),
      },
    ],
  });

const JUNIT = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="2" tests="3">
<testcase classname="tests.test_cart.TestCart" name="test_total[2-3]" file="tests/test_cart.py" line="4" time="0.031"><failure message="assert 4 == 5">E assert 4 == 5</failure></testcase>
<testcase classname="tests.test_cart" name="test_empty" file="tests/test_cart.py" line="12" time="0.002"><failure message="assert False">E assert False</failure></testcase>
<testcase classname="tests.test_cart" name="test_ok" file="tests/test_cart.py" line="20" time="0.001" />
</testsuite></testsuites>`;

describe('readTests', () => {
  it("names each test of a vitest or jest report by its file under the workspace and its full name, with its failure's cause", () => {
    const read = readTests(json({ 'cart total': 'failed', 'cart empty': 'passed' }));
    expect(read).toEqual([
      { id: 'src/a.test.ts > cart total', file: 'src/a.test.ts', name: 'cart total', status: 'failed', durationMs: 12, message: 'AssertionError: cart total broke' },
      { id: 'src/a.test.ts > cart empty', file: 'src/a.test.ts', name: 'cart empty', status: 'passed', durationMs: 12, message: '' },
    ]);
  });

  it('names a pytest test by its node id, from the JUnit report the factory asks for (`xunit1`, which gives the file)', () => {
    const read = readTests(JUNIT)!;
    expect(read.map((t) => [t.id, t.status, t.durationMs])).toEqual([
      ['tests/test_cart.py::TestCart::test_total[2-3]', 'failed', 31],
      ['tests/test_cart.py::test_empty', 'failed', 2],
      ['tests/test_cart.py::test_ok', 'passed', 1],
    ]);
    expect(read[0]!.message).toContain('assert 4 == 5');
  });

  it('names nothing when a file did not load, a test has no file, or the report is unreadable: nothing is then rerun', () => {
    expect(readTests(JSON.stringify({ testResults: [{ name: '/work/src/a.test.ts', message: 'Transform failed', assertionResults: [] }] }))).toBeUndefined();
    expect(readTests('<testsuites><testcase classname="tests.test_cart" name="test_empty"><failure message="x"/></testcase></testsuites>')).toBeUndefined();
    expect(readTests('<testsuites><testcase classname="" name="tests/test_cart.py" file="tests/test_cart.py"><error message="collection failure">ImportError</error></testcase></testsuites>')).toBeUndefined();
    expect(readTests('{not json')).toBeUndefined();
    expect(readTests(undefined)).toBeUndefined();
  });
});


describe('rerunLine and withoutLine', () => {
  const total = { id: 'src/a.test.ts > cart (total)', file: 'src/a.test.ts', name: 'cart (total)' };
  const empty = { id: 'src/b.test.ts > cart empty', file: 'src/b.test.ts', name: 'cart empty' };

  it("reruns failing tests together with the repository's own command: their files and names for vitest and jest, their node ids for pytest", () => {
    expect(rerunLine('npx vitest run', 'vitest', [total])).toBe(`npx vitest run 'src/a.test.ts' -t 'cart \\(total\\)'`);
    expect(rerunLine('npx vitest run', 'vitest', [total, empty, { ...total, name: 'x' }])).toBe(`npx vitest run 'src/a.test.ts' 'src/b.test.ts' -t 'cart \\(total\\)|cart empty|x'`);
    expect(rerunLine('npx jest', 'jest', [total])).toBe(`npx jest 'src/a\\.test\\.ts' -t 'cart \\(total\\)'`);
    expect(rerunLine('pytest -q', 'pytest', [{ id: "tests/t.py::test_it's", file: 'tests/t.py', name: "test_it's" }, { id: 'tests/t.py::test_b', file: 'tests/t.py', name: 'test_b' }])).toBe(`pytest -q 'tests/t.py::test_it'\\''s' 'tests/t.py::test_b'`);
  });

  it('runs the command without given tests: a pattern none of their full names matches, pytest deselecting them', () => {
    const line = withoutLine('npx vitest run', 'vitest', [total, empty]);
    expect(line).toBe(`npx vitest run -t '^(?!(?:.* )?(?:cart \\(total\\)|cart empty)$)'`);
    const pattern = new RegExp(line.slice(line.indexOf("'") + 1, -1));
    expect(['cart (total)', 'src/a.test.ts cart empty', 'cart ok', 'cart totally'].map((n) => pattern.test(n))).toEqual([false, false, true, true]);
    expect(withoutLine('pytest', 'pytest', [{ id: 'tests/t.py::test_a', name: 'test_a' }])).toBe(`pytest --deselect 'tests/t.py::test_a'`);
  });
});

/** A run whose report says `tests`, failing when one does. */
const ran = (tests: Record<string, Status>, output = 'output'): TestRun => ({
  exitCode: Object.values(tests).includes('failed') ? 1 : 0,
  output,
  report: json(tests),
  ms: 40,
});

/** Runs by the line asked: `by` names a run per line, the others get `first`. */
function fakeRun(first: TestRun, by: Record<string, TestRun> = {}): Run & { lines: string[] } {
  const lines: string[] = [];
  const run = async (line: string) => {
    lines.push(line);
    return by[line] ?? first;
  };
  return Object.assign(run, { lines });
}

const NONE = { known: [] };
const knownTotal = { known: [{ test: 'src/a.test.ts > cart total', coversFrozen: false }] };

describe('runAndRerun', () => {
  it('reruns the failing tests once on the commit, in one run, and records the cause of each attempt: outcome, duration, output', async () => {
    const rerun = `npx vitest run 'src/a.test.ts' -t 'cart total|cart empty'`;
    const run = fakeRun(ran({ 'cart total': 'failed', 'cart empty': 'failed', 'cart ok': 'passed' }, 'whole run'), { [rerun]: ran({ 'cart total': 'passed', 'cart empty': 'failed' }) });
    const res = await runAndRerun('npx vitest run', 'vitest', run, NONE);
    expect(run.lines).toEqual(['npx vitest run', rerun]);
    expect(res).toMatchObject({ command: 'npx vitest run', exitCode: 1, output: 'whole run', notRerun: 0 });
    expect(res!.withoutIndicative).toBeUndefined();
    expect(res!.tests).toEqual([
      {
        command: 'npx vitest run', test: 'src/a.test.ts > cart total', file: 'src/a.test.ts', name: 'cart total',
        attempts: [
          { on: 'head', attempt: 1, outcome: 'failed', durationMs: 12, output: 'AssertionError: cart total broke' },
          { on: 'head', attempt: 2, outcome: 'passed', durationMs: 12, output: '' },
        ],
      },
      {
        command: 'npx vitest run', test: 'src/a.test.ts > cart empty', file: 'src/a.test.ts', name: 'cart empty',
        attempts: [
          { on: 'head', attempt: 1, outcome: 'failed', durationMs: 12, output: 'AssertionError: cart empty broke' },
          { on: 'head', attempt: 2, outcome: 'failed', durationMs: 12, output: 'AssertionError: cart empty broke' },
        ],
      },
    ]);
  });

  it('reruns nothing for a passing command, a command without a runner or a report naming its failing tests', async () => {
    expect(await runAndRerun('npx vitest run', 'vitest', fakeRun(ran({ 'cart ok': 'passed' })), NONE)).toBeUndefined();
    const plain = fakeRun({ exitCode: 2, output: 'lint error', ms: 5 });
    expect(await runAndRerun('npm run lint', undefined, plain, NONE)).toEqual({ command: 'npm run lint', exitCode: 2, output: 'lint error', tests: [], notRerun: 0 });
    expect(plain.lines).toEqual(['npm run lint']);
    const unloaded = fakeRun({ exitCode: 1, output: 'Transform failed', report: '{}', ms: 5 });
    expect((await runAndRerun('npx vitest run', 'vitest', unloaded, NONE))!.tests).toEqual([]);
    expect(unloaded.lines).toHaveLength(1);
  });

  it('a test absent from its rerun reads `absent`, never as passed', async () => {
    const run = fakeRun(ran({ 'cart total': 'failed' }), { [`npx vitest run 'src/a.test.ts' -t 'cart total'`]: { exitCode: 1, output: 'No test found', report: json({}), ms: 3 } });
    const res = await runAndRerun('npx vitest run', 'vitest', run, NONE);
    expect(res!.tests[0]!.attempts[1]).toMatchObject({ outcome: 'absent', durationMs: 3, output: 'No test found' });
  });

  it('runs the command once more without its failing tests when all are indicative: the report alone never spares it', async () => {
    const without = withoutLine('npx vitest run', 'vitest', [{ id: 'src/a.test.ts > cart total', name: 'cart total' }]);
    const passing = fakeRun(ran({ 'cart total': 'failed', 'cart ok': 'passed' }), { [without]: ran({ 'cart ok': 'passed' }) });
    expect((await runAndRerun('npx vitest run', 'vitest', passing, knownTotal))!.withoutIndicative).toBe(0);
    expect(passing.lines.at(-1)).toBe(without);
    const failing = fakeRun(ran({ 'cart total': 'failed' }), { [without]: { exitCode: 1, output: 'coverage under threshold', ms: 9 } });
    expect((await runAndRerun('npx vitest run', 'vitest', failing, knownTotal))!.withoutIndicative).toBe(1);
    // A failing test that counts: no such run.
    const mixed = fakeRun(ran({ 'cart total': 'failed', 'cart empty': 'failed' }));
    expect((await runAndRerun('npx vitest run', 'vitest', mixed, knownTotal))!.withoutIndicative).toBeUndefined();
    expect(mixed.lines).toHaveLength(2);
  });
});

const failing = (names: string[], command = 'npx vitest run'): CommandRun => ({
  command,
  runner: 'vitest',
  exitCode: 1,
  output: 'whole run',
  notRerun: 0,
  tests: names.map((name) => ({
    command, test: `src/a.test.ts > ${name}`, file: 'src/a.test.ts', name,
    attempts: [{ on: 'head' as const, attempt: 1, outcome: 'failed' as const, durationMs: 12, output: 'boom' }],
  })),
});

describe('rerunOnBase', () => {
  it(`reruns at most ${MAX_BASE_RERUNS} failing tests that count on the base commit, a command's together, each command saying how many it left`, async () => {
    const a = failing(['t1', 't2', 't3', 't4']);
    const b = failing(['t5', 't6', 't7'], 'npx vitest run --project b');
    const base = fakeRun(ran({ t1: 'failed', t2: 'passed', t3: 'passed', t4: 'passed', t5: 'passed' }));
    await rerunOnBase([a, b], base, NONE);
    expect(base.lines).toEqual([`npx vitest run 'src/a.test.ts' -t 't1|t2|t3|t4'`, `npx vitest run --project b 'src/a.test.ts' -t 't5'`]);
    expect(a.tests[0]!.attempts[1]).toEqual({ on: 'base', attempt: 1, outcome: 'failed', durationMs: 12, output: 'AssertionError: t1 broke' });
    expect(a.tests[1]!.attempts[1]).toMatchObject({ on: 'base', outcome: 'passed' });
    expect(b.tests[1]!.attempts).toHaveLength(1);
    expect([a.notOnBase, b.notOnBase]).toEqual([0, 2]);
  });

  it('spends nothing of it on indicative tests, and is not needed when only they failed', async () => {
    const only = failing(['cart total']);
    expect(needsBase([only], knownTotal)).toBe(false);
    const run = failing(['cart total', 'cart empty']);
    expect(needsBase([run], knownTotal)).toBe(true);
    const base = fakeRun(ran({ 'cart empty': 'failed' }));
    await rerunOnBase([run], base, knownTotal);
    expect(base.lines).toEqual([`npx vitest run 'src/a.test.ts' -t 'cart empty'`]);
    expect(run.tests[0]!.attempts).toHaveLength(1);
  });
});

describe('settle', () => {
  it('a known flaky test is indicative: it does not count, and a command it alone failed, passing without it, is no failure', () => {
    const run = { ...failing(['cart total']), withoutIndicative: 0 };
    const { failures, flaky } = settle([run], knownTotal);
    expect(failures).toEqual([]);
    expect(flaky).toEqual([expect.objectContaining({ test: 'src/a.test.ts > cart total', indicative: true })]);
  });

  it('a command that still fails without its known flaky tests stays a failure', () => {
    const { failures, flaky } = settle([{ ...failing(['cart total']), withoutIndicative: 1 }], knownTotal);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.output).toContain('Without its known flaky tests, the command still fails: something else failed it.');
    expect(flaky[0]!.indicative).toBe(true);
  });

  it('a command with a failing test that is not known flaky still fails, the known one named indicative in what the agent reads', () => {
    const { failures, flaky } = settle([failing(['cart total', 'cart empty'])], knownTotal);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ command: 'npx vitest run', exitCode: 1 });
    expect(failures[0]!.output).toMatch(/^whole run\n/);
    expect(failures[0]!.output).toContain('`src/a.test.ts > cart total`: known flaky in this repository, indicative: it does not count');
    expect(flaky.map((t) => t.indicative)).toEqual([true, undefined]);
  });

  it('says what the reruns found: passed on its rerun, failing on the base too, and what was not rerun', () => {
    const run = failing(['a', 'b', 'c']);
    run.tests[0]!.attempts.push({ on: 'head', attempt: 2, outcome: 'passed', durationMs: 1, output: '' });
    run.tests[1]!.attempts.push({ on: 'head', attempt: 2, outcome: 'failed', durationMs: 1, output: 'boom' }, { on: 'base', attempt: 1, outcome: 'failed', durationMs: 1, output: 'boom' });
    run.notRerun = 3;
    run.notOnBase = 4;
    const output = settle([run], NONE).failures[0]!.output;
    expect(output).toContain('`src/a.test.ts > a`: failed, then passed on its rerun: flaky on this commit');
    expect(output).toContain('`src/a.test.ts > b`: failed again on its rerun; fails on the base commit too: not caused by this ticket');
    expect(output).toContain('`src/a.test.ts > c`: failed');
    expect(output).toContain('3 more failing tests were not rerun');
    expect(output).toContain(`4 failing tests were not rerun on the base commit (at most ${MAX_BASE_RERUNS} in all)`);
  });

  it('criterion 4: a frozen test is never indicative without the human decision that its known-flaky entry covers frozen tests', () => {
    const known = (coversFrozen: boolean) => [{ test: 'src/a.test.ts > cart total', coversFrozen }];
    const run = { ...failing(['cart total']), withoutIndicative: 0 };
    for (const frozenPath of ['src/a.test.ts', 'web/src/a.test.ts']) {
      const frozen = { sha: 'f', files: { [frozenPath]: 'h' } };
      const without = settle([run], { known: known(false), frozen });
      expect(without.failures).toHaveLength(1);
      expect(without.failures[0]!.output).toContain('known flaky, but frozen for this ticket: it counts until a human decides otherwise');
      expect(without.flaky[0]!.indicative).toBeUndefined();
      // Frozen, it counts: no run without it is made, so none can spare it.
      expect(settle([{ ...run, withoutIndicative: undefined }], { known: known(false), frozen }).failures).toHaveLength(1);
      const decided = settle([run], { known: known(true), frozen });
      expect(decided.failures).toEqual([]);
      expect(decided.flaky[0]!.indicative).toBe(true);
    }
  });

  it('keeps a failure without tests as it is', () => {
    const plain: CommandRun = { command: 'npm run lint', exitCode: 2, output: 'lint error', tests: [], notRerun: 0 };
    expect(settle([plain], NONE)).toEqual({ failures: [{ command: 'npm run lint', exitCode: 2, output: 'lint error' }], flaky: [] });
  });
});
