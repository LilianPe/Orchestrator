// The minimum on flaky tests in `verify` (ORC-164): each failing test rerun once on the commit, its cause recorded; rerun on
// the base commit, a bounded number; a known flaky test of the repository indicative, never counted against the agent, and
// a frozen one only on a human's decision. The tests are named from the runner's machine report (vitest, jest, pytest),
// which the agent's code writes: what it names only ever spares a test a human listed.
import { WORKSPACE_TARGET } from '../adapters/sandbox/types.js';
import type { VerifyFailure } from '../core/types.js';
import type { FrozenTests } from './freeze.js';
import { attribute, escape, quote, stripAnsi, unescapeXml, type Runner } from './red.js';

/** Failing tests of one command rerun on the commit, past which they are only counted. */
export const MAX_RERUNS = 20;
/** Failing tests rerun on the base commit in one check: each run there needs a sandbox set up on the base. */
export const MAX_BASE_RERUNS = 5;
/** What an attempt keeps of its output, its tail: it goes into the journal. */
const OUTPUT_MAX = 1000;

/** A test as a report names it: `id`, its key in the repository's known-flaky table. */
export interface ReadTest {
  id: string;
  /** Its file, from the repository's root. */
  file: string;
  name: string;
  status: 'passed' | 'failed';
  durationMs?: number;
  message: string;
}

/** One run of a test: the first on the commit, its rerun there, its run on the base commit. */
export interface TestAttempt {
  on: 'head' | 'base';
  attempt: number;
  /** `absent`: the run did not report it (no such test on the base, a file that did not load). */
  outcome: 'passed' | 'failed' | 'absent';
  durationMs?: number;
  output: string;
}

/** A failing test of a command, what its reruns found, and whether it counts: `indicative`, it does not. */
export interface FlakyTest {
  command: string;
  test: string;
  file: string;
  name: string;
  attempts: TestAttempt[];
  indicative?: true;
}

/** An entry of the repository's known-flaky table, a human's: `coversFrozen`, they decided it may be indicative while frozen too. */
export interface KnownFlaky {
  test: string;
  coversFrozen: boolean;
}

/** A command run with its runner's report: `ms`, how long it took. */
export interface TestRun {
  exitCode: number | null;
  output: string;
  report?: string;
  ms: number;
}

/** Runs a shell line where the commands run; with a runner, its report is asked for and read back. */
export type Run = (line: string, runner: Runner | undefined) => Promise<TestRun>;

/** A command that failed, and its failing tests with their reruns; none when its report named none. */
export interface CommandRun {
  command: string;
  runner?: Runner;
  exitCode: number | null;
  output: string;
  tests: FlakyTest[];
  /** Failing tests past `MAX_RERUNS`: not rerun, nor recorded. */
  notRerun: number;
  /** Failing tests that count, left past `MAX_BASE_RERUNS`: not rerun on the base. */
  notOnBase?: number;
  /** Its exit run without its failing tests, all indicative: only 0 spares it. */
  withoutIndicative?: number | null;
}

const tail = (s: string): string => (s.length > OUTPUT_MAX ? s.slice(-OUTPUT_MAX) : s);
const fromRoot = (file: string): string => file.replace(new RegExp(`^${escape(WORKSPACE_TARGET)}/`), '').replace(/^\.\//, '');

interface JsonReport {
  testResults: { name?: string; message?: string; assertionResults?: { fullName?: string; ancestorTitles?: string[]; title?: string; status?: string; duration?: number; failureMessages?: string[] }[] }[];
}

/** vitest's or jest's: a file whose failure no test carries (it did not load, a hook failed) names nothing. */
function fromJson(json: JsonReport): ReadTest[] | undefined {
  const tests: ReadTest[] = [];
  for (const file of json.testResults) {
    const results = file.assertionResults ?? [];
    if (file.message && !results.some((t) => t.status === 'failed')) return undefined;
    for (const t of results) {
      if (t.status !== 'passed' && t.status !== 'failed') continue;
      const name = t.fullName ?? [...(t.ancestorTitles ?? []), t.title ?? ''].join(' ');
      const path = fromRoot(file.name ?? '');
      tests.push({
        id: `${path} > ${name}`, file: path, name, status: t.status,
        ...(typeof t.duration === 'number' ? { durationMs: Math.round(t.duration) } : {}),
        message: stripAnsi((t.failureMessages ?? []).join('\n')),
      });
    }
  }
  return tests;
}

/**
 * pytest's JUnit, `xunit1`: each test named by its node id, `<file>::<class>::<name>`, its class what its `classname` holds
 * past its module. A test without its file, or a module that did not load, names nothing.
 */
function fromJUnit(xml: string): ReadTest[] | undefined {
  const tests: ReadTest[] = [];
  for (const tc of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = tc[1]!;
    const outcome = /<(failure|error|skipped)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(tc[2] ?? '');
    if (outcome?.[1] === 'skipped') continue;
    const message = outcome ? `${attribute(outcome[2]!, 'message')}\n${unescapeXml(outcome[3] ?? '')}`.trim() : '';
    const file = attribute(attrs, 'file');
    if (!file || (outcome?.[1] === 'error' && /collection failure/.test(message))) return undefined;
    const name = attribute(attrs, 'name');
    const module = file.replace(/\.py$/, '').replaceAll('/', '.');
    const classname = attribute(attrs, 'classname');
    const inClass = classname.startsWith(`${module}.`) ? classname.slice(module.length + 1).replaceAll('.', '::') : '';
    const time = Number(attribute(attrs, 'time'));
    tests.push({
      id: [file, inClass, name].filter(Boolean).join('::'), file, name, status: outcome ? 'failed' : 'passed',
      ...(attribute(attrs, 'time') && Number.isFinite(time) ? { durationMs: Math.round(time * 1000) } : {}),
      message,
    });
  }
  return tests;
}

/** The tests a runner's report names, JSON or JUnit; undefined when it names them not all, or is unreadable. */
export function readTests(report: string | undefined): ReadTest[] | undefined {
  if (!report) return undefined;
  if (report.trimStart().startsWith('<')) return fromJUnit(report);
  try {
    const json = JSON.parse(report) as Partial<JsonReport> | null;
    return Array.isArray(json?.testResults) ? fromJson(json as JsonReport) : undefined;
  } catch {
    return undefined;
  }
}

/** Each test's file, once. */
const filesOf = (tests: readonly { file: string }[]): string[] => [...new Set(tests.map((t) => t.file))];

/**
 * The repository's command on `tests`, in one run: their node ids for pytest; their files and a pattern of their names for
 * vitest and jest, whose files are patterns too for jest.
 */
export function rerunLine(command: string, runner: Runner, tests: readonly { id: string; file: string; name: string }[]): string {
  if (runner === 'pytest') return `${command} ${tests.map((t) => quote(t.id)).join(' ')}`;
  const files = filesOf(tests).map((f) => quote(runner === 'jest' ? escape(f) : f));
  return `${command} ${files.join(' ')} -t ${quote(tests.map((t) => escape(t.name)).join('|'))}`;
}

/**
 * The repository's command without `tests`: pytest's `--deselect`, a pattern that no full name ending in theirs matches for
 * vitest and jest (their full name may start with the file's).
 */
export function withoutLine(command: string, runner: Runner, tests: readonly { id: string; name: string }[]): string {
  if (runner === 'pytest') return `${command} ${tests.map((t) => `--deselect ${quote(t.id)}`).join(' ')}`;
  return `${command} -t ${quote(`^(?!(?:.* )?(?:${tests.map((t) => escape(t.name)).join('|')})$)`)}`;
}

/** What a run says of test `id`: its outcome there, absent when its report does not name it. */
function attemptOf(on: TestAttempt['on'], attempt: number, run: TestRun, id: string): TestAttempt {
  const found = readTests(run.report)?.find((t) => t.id === id);
  return { on, attempt, outcome: found?.status ?? 'absent', durationMs: found?.durationMs ?? run.ms, output: tail(found ? found.message : run.output) };
}

/** What decides whether a failing test counts: the repository's known flaky tests, and the ticket's freeze. */
export interface Standing {
  known: readonly KnownFlaky[];
  frozen?: FrozenTests;
}

/**
 * Whether `t` counts: a known flaky test does not, nor a frozen one whose entry a human made cover frozen tests. A frozen
 * path also matches a file a runner named from a sub-root (pytest's rootdir).
 */
function standing(t: { test: string; file: string }, at: Standing): 'counts' | 'indicative' | 'frozen' {
  const entry = at.known.find((k) => k.test === t.test);
  if (!entry) return 'counts';
  const frozen = at.frozen && Object.keys(at.frozen.files).some((f) => f === t.file || f.endsWith(`/${t.file}`));
  return frozen && !entry.coversFrozen ? 'frozen' : 'indicative';
}

/**
 * `command`, then the tests its report names as failing rerun once on the commit, together, up to `MAX_RERUNS`. Undefined
 * when it passed. Without a runner, an exit without a code (its cap) or a report that names no failing test, nothing is
 * rerun. When every failing test is indicative, the command runs once more without them (`withoutIndicative`): the report
 * is the agent's code's, and an exit can have a cause no test carries; only a pass then spares the command.
 */
export async function runAndRerun(command: string, runner: Runner | undefined, run: Run, at: Standing): Promise<CommandRun | undefined> {
  const first = await run(command, runner);
  if (first.exitCode === 0) return undefined;
  const failed = runner && first.exitCode !== null ? (readTests(first.report)?.filter((t) => t.status === 'failed') ?? []) : [];
  const res: CommandRun = { command, ...(runner ? { runner } : {}), exitCode: first.exitCode, output: first.output, tests: [], notRerun: Math.max(0, failed.length - MAX_RERUNS) };
  const rerun = failed.slice(0, MAX_RERUNS);
  if (!rerun.length) return res;
  const again = await run(rerunLine(command, runner!, rerun), runner);
  for (const t of rerun) {
    res.tests.push({
      command, test: t.id, file: t.file, name: t.name,
      attempts: [
        { on: 'head', attempt: 1, outcome: 'failed', ...(t.durationMs === undefined ? {} : { durationMs: t.durationMs }), output: tail(t.message) },
        attemptOf('head', 2, again, t.id),
      ],
    });
  }
  if (!res.notRerun && res.tests.every((t) => standing(t, at) === 'indicative')) {
    res.withoutIndicative = (await run(withoutLine(command, runner!, rerun), runner)).exitCode;
  }
  return res;
}

/** The failing tests of `runs` that count, those a base rerun can say something of. */
const counted = (runs: readonly CommandRun[], at: Standing) => runs.flatMap((r) => r.tests.filter((t) => standing(t, at) !== 'indicative').map((t) => ({ r, t })));

/** Whether a failing test that counts is left for the base commit. */
export const needsBase = (runs: readonly CommandRun[], at: Standing): boolean => counted(runs, at).length > 0;

/**
 * The failing tests of `runs` that count rerun on the base commit by `run`, in their order, up to `max`: those of a command
 * together. Each command says how many of its own were left (`notOnBase`).
 */
export async function rerunOnBase(runs: readonly CommandRun[], run: Run, at: Standing, max = MAX_BASE_RERUNS): Promise<void> {
  const all = counted(runs, at);
  const chosen = all.slice(0, max);
  for (const r of runs) {
    const tests = chosen.filter((c) => c.r === r).map((c) => c.t);
    r.notOnBase = all.filter((c) => c.r === r).length - tests.length;
    if (!tests.length) continue;
    const onBase = await run(rerunLine(r.command, r.runner!, tests.map((t) => ({ id: t.test, file: t.file, name: t.name }))), r.runner);
    for (const t of tests) t.attempts.push(attemptOf('base', 1, onBase, t.test));
  }
}

/** What the reruns of a counted test found, for the agent: not caused by its work, or flaky. */
function found(t: FlakyTest): string {
  const again = t.attempts.find((a) => a.on === 'head' && a.attempt === 2)?.outcome;
  const base = t.attempts.find((a) => a.on === 'base')?.outcome;
  const head = again === 'passed' ? 'failed, then passed on its rerun: flaky on this commit' : again === 'failed' ? 'failed again on its rerun' : again === 'absent' ? 'failed, and its rerun did not report it' : 'failed';
  const onBase = base === 'failed' ? '; fails on the base commit too: not caused by this ticket' : base === 'passed' ? '; passes on the base commit' : base === 'absent' ? '; not on the base commit' : '';
  return head + onBase;
}

/**
 * The verdict on the failed commands: a command whose failing tests are all indicative, and which passed without them, is
 * no failure; the others say, under their output, what the reruns found of each test.
 */
export function settle(runs: readonly CommandRun[], at: Standing): { failures: VerifyFailure[]; flaky: FlakyTest[] } {
  const failures: VerifyFailure[] = [];
  const flaky: FlakyTest[] = [];
  for (const run of runs) {
    const failure = { command: run.command, exitCode: run.exitCode };
    if (!run.tests.length) {
      failures.push({ ...failure, output: run.output });
      continue;
    }
    let spared = run.withoutIndicative === 0;
    const lines = run.tests.map((t) => {
      const s = standing(t, at);
      if (s !== 'indicative') spared = false;
      flaky.push(s === 'indicative' ? { ...t, indicative: true } : t);
      const said = s === 'indicative' ? 'known flaky in this repository, indicative: it does not count' : s === 'frozen' ? 'known flaky, but frozen for this ticket: it counts until a human decides otherwise' : found(t);
      return `- \`${t.test}\`: ${said}`;
    });
    if (spared) continue;
    if (run.withoutIndicative !== undefined && run.withoutIndicative !== 0) lines.push('Without its known flaky tests, the command still fails: something else failed it.');
    if (run.notRerun) lines.push(`${run.notRerun} more failing tests were not rerun (at most ${MAX_RERUNS}).`);
    if (run.notOnBase) lines.push(`${run.notOnBase} failing tests were not rerun on the base commit (at most ${MAX_BASE_RERUNS} in all).`);
    failures.push({ ...failure, output: `${run.output}\n\nThe failing tests, rerun by the factory:\n${lines.join('\n')}` });
  }
  return { failures, flaky };
}
