import { describe, expect, it } from 'vitest';
import { MAX_BASE_RERUNS, readTests, rerunLine, rerunOnBase, runAndRerun, settle, type CommandRun, type Run, type TestRun } from './flaky.js';

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

describe('rerunLine', () => {
  it("runs one test with the repository's own command: its file and its name for vitest and jest, its node id for pytest", () => {
    const test = { id: 'src/a.test.ts > cart (total)', file: 'src/a.test.ts', name: 'cart (total)' };
    expect(rerunLine('npx vitest run', 'vitest', test)).toBe(`npx vitest run 'src/a.test.ts' -t 'cart \\(total\\)'`);
    expect(rerunLine('npx jest', 'jest', test)).toBe(`npx jest 'src/a\\.test\\.ts' -t 'cart \\(total\\)'`);
    expect(rerunLine('pytest -q', 'pytest', { id: "tests/t.py::test_it's", file: 'tests/t.py', name: "test_it's" })).toBe(`pytest -q 'tests/t.py::test_it'\\''s'`);
  });
});

/** A run of `line` whose report says `tests`, failing when one does. */
const ran = (tests: Record<string, Status>, output = 'output'): TestRun => ({
  exitCode: Object.values(tests).includes('failed') ? 1 : 0,
  output,
  report: json(tests),
  ms: 40,
});

/** Runs by the line asked: the command itself first, then each rerun by the test it names. */
function fakeRun(first: TestRun, reruns: Record<string, TestRun>): Run & { lines: string[] } {
  const lines: string[] = [];
  const run = async (line: string) => {
    lines.push(line);
    const named = Object.keys(reruns).find((name) => line.includes(`-t '${name}'`));
    return named ? reruns[named]! : first;
  };
  return Object.assign(run, { lines });
}

describe('runAndRerun', () => {
  it('reruns each failing test once on the commit, and records the cause of each attempt: outcome, duration, output', async () => {
    const run = fakeRun(ran({ 'cart total': 'failed', 'cart empty': 'failed', 'cart ok': 'passed' }, 'whole run'), {
      'cart total': ran({ 'cart total': 'passed' }),
      'cart empty': ran({ 'cart empty': 'failed' }),
    });
    const res = await runAndRerun('npx vitest run', 'vitest', run);
    expect(run.lines).toEqual(['npx vitest run', `npx vitest run 'src/a.test.ts' -t 'cart total'`, `npx vitest run 'src/a.test.ts' -t 'cart empty'`]);
    expect(res).toMatchObject({ command: 'npx vitest run', exitCode: 1, output: 'whole run' });
    expect(res!.tests).toEqual([
      {
        command: 'npx vitest run', test: 'src/a.test.ts > cart total', file: 'src/a.test.ts', name: 'cart total',
        attempts: [
          { on: 'head', attempt: 1, outcome: 'failed', durationMs: 12, output: 'AssertionError: cart total broke' },
          { on: 'head', attempt: 2, outcome: 'passed', durationMs: 40, output: '' },
        ],
      },
      {
        command: 'npx vitest run', test: 'src/a.test.ts > cart empty', file: 'src/a.test.ts', name: 'cart empty',
        attempts: [
          { on: 'head', attempt: 1, outcome: 'failed', durationMs: 12, output: 'AssertionError: cart empty broke' },
          { on: 'head', attempt: 2, outcome: 'failed', durationMs: 40, output: 'AssertionError: cart empty broke' },
        ],
      },
    ]);
  });

  it('reruns nothing for a passing command, a command without a runner or a report naming its failing tests', async () => {
    expect(await runAndRerun('npx vitest run', 'vitest', fakeRun(ran({ 'cart ok': 'passed' }), {}))).toBeUndefined();
    const plain = fakeRun({ exitCode: 2, output: 'lint error', ms: 5 }, {});
    expect(await runAndRerun('npm run lint', undefined, plain)).toEqual({ command: 'npm run lint', exitCode: 2, output: 'lint error', tests: [], notRerun: 0 });
    expect(plain.lines).toEqual(['npm run lint']);
    const unloaded = fakeRun({ exitCode: 1, output: 'Transform failed', report: '{}', ms: 5 }, {});
    expect((await runAndRerun('npx vitest run', 'vitest', unloaded))!.tests).toEqual([]);
    expect(unloaded.lines).toHaveLength(1);
  });

  it('a test absent from its rerun reads `absent`, never as passed', async () => {
    const run = fakeRun(ran({ 'cart total': 'failed' }), { 'cart total': { exitCode: 1, output: 'No test found', report: json({}), ms: 3 } });
    const res = await runAndRerun('npx vitest run', 'vitest', run);
    expect(res!.tests[0]!.attempts[1]).toMatchObject({ outcome: 'absent', output: 'No test found' });
  });
});

const failing = (names: string[]): CommandRun => ({
  command: 'npx vitest run',
  runner: 'vitest',
  exitCode: 1,
  output: 'whole run',
  notRerun: 0,
  tests: names.map((name) => ({
    command: 'npx vitest run', test: `src/a.test.ts > ${name}`, file: 'src/a.test.ts', name,
    attempts: [{ on: 'head' as const, attempt: 1, outcome: 'failed' as const, durationMs: 12, output: 'boom' }],
  })),
});

describe('rerunOnBase', () => {
  it(`reruns at most ${MAX_BASE_RERUNS} failing tests on the base commit, and says how many it left`, async () => {
    const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
    const runs = [failing(names)];
    const base = fakeRun(ran({}), Object.fromEntries(names.map((n) => [n, ran({ [n]: n === 't1' ? 'failed' : 'passed' })])));
    expect(await rerunOnBase(runs, base)).toBe(2);
    expect(base.lines).toHaveLength(MAX_BASE_RERUNS);
    expect(runs[0]!.tests[0]!.attempts[1]).toEqual({ on: 'base', attempt: 1, outcome: 'failed', durationMs: 40, output: 'AssertionError: t1 broke' });
    expect(runs[0]!.tests[1]!.attempts[1]).toMatchObject({ on: 'base', outcome: 'passed' });
    expect(runs[0]!.tests[6]!.attempts).toHaveLength(1);
  });
});

describe('settle', () => {
  it('a known flaky test is indicative: it does not count, and a command it alone failed is no failure', () => {
    const { failures, flaky } = settle([failing(['cart total'])], { known: [{ test: 'src/a.test.ts > cart total', coversFrozen: false }], notOnBase: 0 });
    expect(failures).toEqual([]);
    expect(flaky).toEqual([expect.objectContaining({ test: 'src/a.test.ts > cart total', indicative: true })]);
  });

  it('a command with a failing test that is not known flaky still fails, the known one named indicative in what the agent reads', () => {
    const { failures, flaky } = settle([failing(['cart total', 'cart empty'])], { known: [{ test: 'src/a.test.ts > cart total', coversFrozen: false }], notOnBase: 0 });
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
    const output = settle([run], { known: [], notOnBase: 4 }).failures[0]!.output;
    expect(output).toContain('`src/a.test.ts > a`: failed, then passed on its rerun: flaky on this commit');
    expect(output).toContain('`src/a.test.ts > b`: failed again on its rerun; fails on the base commit too: not caused by this ticket');
    expect(output).toContain('`src/a.test.ts > c`: failed');
    expect(output).toContain('3 more failing tests were not rerun');
    expect(output).toContain(`4 failing tests were not rerun on the base commit (at most ${MAX_BASE_RERUNS})`);
  });

  it('a frozen test is never indicative without the human decision that its known-flaky entry covers frozen tests', () => {
    const frozen = { sha: 'f', files: { 'src/a.test.ts': 'h' } };
    const known = (coversFrozen: boolean) => [{ test: 'src/a.test.ts > cart total', coversFrozen }];
    const without = settle([failing(['cart total'])], { known: known(false), frozen, notOnBase: 0 });
    expect(without.failures).toHaveLength(1);
    expect(without.failures[0]!.output).toContain('known flaky, but frozen for this ticket: it counts until a human decides otherwise');
    expect(without.flaky[0]!.indicative).toBeUndefined();
    const decided = settle([failing(['cart total'])], { known: known(true), frozen, notOnBase: 0 });
    expect(decided.failures).toEqual([]);
    expect(decided.flaky[0]!.indicative).toBe(true);
  });

  it('keeps a failure without tests as it is', () => {
    const plain: CommandRun = { command: 'npm run lint', exitCode: 2, output: 'lint error', tests: [], notRerun: 0 };
    expect(settle([plain], { known: [], notOnBase: 0 })).toEqual({ failures: [{ command: 'npm run lint', exitCode: 2, output: 'lint error' }], flaky: [] });
  });
});
