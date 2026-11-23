// `factory/qualité-diff` (ORC-280): crapper's CRAP scores and dryer's duplicate pairs on what a branch changes, a measure
// that never blocks. docker/runner.Dockerfile installs both tools, pinned, with their grammars, and copies
// docker/quality/diff_quality.py, which runs them on the commit's checkout without network and prints JSON. Pure: the
// caller runs the argv in the commands' sandbox, after the tests, and hands back what it returned.
//
// The coverage is the commit's own tests', asked for as LCOV (`coverageOf`) when their runner can write one without
// installing anything: no coverage, no CRAP, and the functions are listed by complexity.
import type { ExecResult } from '../adapters/exec.js';
import { isRecord } from '../adapters/graphql-pages.js';
import { manifestDependencies } from './deps.js';
import { logExcerpt } from './log-excerpt.js';
import { mdCode } from './markdown.js';
import type { Runner } from './red.js';

export const DIFF_QUALITY_CHECK = 'factory/qualité-diff';

/** Where docker/runner.Dockerfile installs crapper and dryer, one tool environment, and copies the script. */
const QUALITY_PYTHON = '/opt/quality/crapper/bin/python';
export const QUALITY_SCRIPT = '/usr/local/share/factory/quality/diff_quality.py';

/** Past it, a function is listed: crapper's « worth a look ». */
const CRAP_LIMIT = 10;
/** Without coverage, a function is listed past this complexity: untested, its CRAP would be over 40. */
const CC_LIMIT = 5;
/** dryer's default: two functions at least this similar in structure are a pair. */
const SIMILARITY = 0.82;
/** What the check and the event keep of each list, worst first. */
const LISTED = 20;
/** The measure's own cap: about 4 s on a repository of a thousand files, dryer comparing the diff's functions with all of them. */
export const QUALITY_TIMEOUT_S = 120;
/** Past it, the diff is not measured: the paths go on one command line, and each file's functions are compared with the whole repository. */
export const QUALITY_MAX_FILES = 500;

interface QualitySpan {
  path: string;
  start: number;
  end: number;
}

interface QualityFunction extends QualitySpan {
  name: string;
  cc: number;
  /** A percentage; null when no report names its file. */
  coverage: number | null;
  crap: number | null;
}

interface QualityPair {
  score: number;
  left: QualitySpan;
  right: QualitySpan;
}

/** What the measure found on the lines the diff adds, worst first; `unavailable`, why it could not be taken. */
export interface DiffQuality {
  functions: QualityFunction[];
  pairs: QualityPair[];
  /** How many were found past what is kept. */
  more?: number;
  unavailable?: string;
}

export const unmeasured = (why: string): DiffQuality => ({ functions: [], pairs: [], unavailable: why });

/** The commit's runner asked for an LCOV in `dir`: the language its report covers, and the flags appended to the command. */
export interface CoverageAsk {
  language: 'typescript' | 'python';
  flags: (dir: string) => string;
}

const VITEST_PROVIDERS = { '@vitest/coverage-v8': 'v8', '@vitest/coverage-istanbul': 'istanbul' } as const;
/** The root files besides `pyproject.toml` that declare a Python project's test dependencies, read line by line. */
const PYTHON_LISTS = ['setup.cfg', 'setup.py', 'Pipfile', 'requirements.txt', 'requirements-dev.txt', 'requirements-test.txt', 'dev-requirements.txt', 'test-requirements.txt'];

/** Whether the commit declares pytest-cov: in any group of `pyproject.toml`, or on a line of another manifest that is not a comment. */
async function declaresPytestCov(showAtHead: (path: string) => Promise<string | undefined>): Promise<boolean> {
  const pyproject = await showAtHead('pyproject.toml');
  if (pyproject && manifestDependencies('pyproject.toml', pyproject).names.includes('pytest-cov')) return true;
  const lists = await Promise.all(PYTHON_LISTS.map(showAtHead));
  return lists.some((text) => (text ?? '').split('\n').some((l) => /pytest[-_]cov\b/i.test(l.replace(/#.*/, ''))));
}

/**
 * How the commit's runner writes an LCOV, when it can without installing anything: vitest with a coverage package in the
 * root `package.json`, jest, which carries its own, pytest with pytest-cov declared. The thresholds a repository sets are
 * emptied, and the report written even when a test fails: a measure never fails its tests, nor needs a second run of a red
 * one. Undefined: nothing is added to the command.
 */
export async function coverageOf(runner: Runner | undefined, showAtHead: (path: string) => Promise<string | undefined>): Promise<CoverageAsk | undefined> {
  if (runner === 'jest') return { language: 'typescript', flags: (dir) => `--coverage --coverageReporters=lcov --coverageDirectory=${dir} --coverageThreshold='{}'` };
  if (runner === 'vitest') {
    const { names } = manifestDependencies('package.json', (await showAtHead('package.json')) ?? '{}');
    const provider = Object.entries(VITEST_PROVIDERS).find(([name]) => names.includes(name))?.[1];
    if (!provider) return undefined;
    const thresholds = ['lines', 'functions', 'branches', 'statements'].map((t) => `--coverage.thresholds.${t}=0`).join(' ');
    return {
      language: 'typescript',
      flags: (dir) => `--coverage.enabled --coverage.provider=${provider} --coverage.reporter=lcov --coverage.reportsDirectory=${dir} --coverage.reportOnFailure ${thresholds} --coverage.thresholds.perFile=false --coverage.thresholds.autoUpdate=false`,
    };
  }
  if (runner === 'pytest' && (await declaresPytestCov(showAtHead))) return { language: 'python', flags: (dir) => `--cov=. --cov-report=lcov:${dir}/pytest.lcov --cov-fail-under=0` };
  return undefined;
}

/** The script on `files`, under its cap, with the LCOV reports under `coverageDir` for the `covered` languages. A path may start with a dash. */
export function qualityArgv(o: { coverageDir: string; covered: readonly string[]; files: readonly string[] }): string[] {
  return ['timeout', String(QUALITY_TIMEOUT_S), QUALITY_PYTHON, '-I', QUALITY_SCRIPT, o.coverageDir, o.covered.join(','), String(SIMILARITY), '--', ...o.files];
}

/** A path or a name from the agent's code, cut so that no line of the journal, the check or the PR outgrows its room. */
const CLIPPED = 120;
const clip = (s: string): string => (s.length > CLIPPED ? `${s.slice(0, CLIPPED - 1)}…` : s);
const clipSpan = (s: QualitySpan): QualitySpan => ({ ...s, path: clip(s.path) });

const touches = (s: QualitySpan, added: ReadonlyMap<string, ReadonlySet<number>>): boolean => {
  const lines = added.get(s.path);
  if (!lines) return false;
  for (const l of lines) if (l >= s.start && l <= s.end) return true;
  return false;
};

const listed = (f: QualityFunction): boolean => (f.crap === null ? f.cc > CC_LIMIT : f.crap > CRAP_LIMIT);
/** Scored first, worst first; then the unknown ones, the most complex first. */
const worse = (a: QualityFunction, b: QualityFunction): number => (a.crap === null) !== (b.crap === null) ? (a.crap === null ? 1 : -1) : (b.crap ?? b.cc) - (a.crap ?? a.cc);

const isSpan = (s: unknown): s is QualitySpan => isRecord(s) && typeof s['path'] === 'string' && typeof s['start'] === 'number' && typeof s['end'] === 'number';
const isFunction = (f: unknown): f is QualityFunction =>
  isRecord(f) && isSpan(f) && typeof f['name'] === 'string' && typeof f['cc'] === 'number' && (f['coverage'] === null || typeof f['coverage'] === 'number') && (f['crap'] === null || typeof f['crap'] === 'number');
const isPair = (p: unknown): p is QualityPair => isRecord(p) && typeof p['score'] === 'number' && isSpan(p['left']) && isSpan(p['right']);

/**
 * What the script found on the lines the diff adds (`added`): a function with one of them in its span, listed past the
 * limits; a pair with one of them in either side. Paths and names clipped, as the journal keeps them. A breakdown is said,
 * never thrown: the measure blocks nothing.
 */
export function readQuality({ code, stdout, stderr }: ExecResult, added: ReadonlyMap<string, ReadonlySet<number>>): DiffQuality {
  if (code !== 0) return unmeasured(`crapper and dryer could not run (code ${code})${stderr.trim() ? `: ${mdCode(logExcerpt(stderr.trim(), 300))}` : ''}`);
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    report = undefined;
  }
  if (!isRecord(report) || !Array.isArray(report['functions']) || !Array.isArray(report['pairs']) || !report['functions'].every(isFunction) || !report['pairs'].every(isPair)) {
    return unmeasured('crapper and dryer returned no readable report');
  }
  const functions = report['functions'].filter((f) => touches(f, added) && listed(f)).sort(worse);
  const pairs = report['pairs'].filter((p) => touches(p.left, added) || touches(p.right, added)).sort((a, b) => b.score - a.score);
  const more = Math.max(0, functions.length - LISTED) + Math.max(0, pairs.length - LISTED);
  return {
    functions: functions.slice(0, LISTED).map((f) => ({ ...clipSpan(f), name: clip(f.name) }) as QualityFunction),
    pairs: pairs.slice(0, LISTED).map((p) => ({ ...p, left: clipSpan(p.left), right: clipSpan(p.right) })),
    ...(more ? { more } : {}),
  };
}

const at = (s: QualitySpan) => mdCode(`${s.path}:${s.start}-${s.end}`);
const functionLine = (f: QualityFunction) =>
  `${at(f)} ${mdCode(f.name)}: ${f.crap === null ? `CC ${f.cc}, coverage unknown` : `CRAP ${f.crap} (CC ${f.cc}, coverage ${f.coverage} %)`}`;
const pairLine = (p: QualityPair) => `${at(p.left)} and ${at(p.right)}: similarity ${p.score.toFixed(2)}`;

/**
 * `factory/qualité-diff`: a measure, never a failure. Neutral when it lists something, or could not measure; a success when
 * the diff adds nothing to look at.
 */
export function diffQualityCheck(q: DiffQuality): { conclusion: 'success' | 'neutral'; summary: string } {
  if (q.unavailable) return { conclusion: 'neutral', summary: `Not measured: ${q.unavailable}.` };
  if (!q.functions.length && !q.pairs.length) return { conclusion: 'success', summary: `Nothing to look at: no function the diff touches is past CRAP ${CRAP_LIMIT}, and none is a near copy of another.` };
  const parts = ['A measure, which blocks nothing.'];
  if (q.functions.length) parts.push(`**Functions the diff touches past CRAP ${CRAP_LIMIT}** (past CC ${CC_LIMIT} when the coverage is unknown), worst first:\n${q.functions.map((f) => `- ${functionLine(f)}`).join('\n')}`);
  if (q.pairs.length) parts.push(`**Near copies** (dryer, structure at least ${SIMILARITY} similar), a side in the diff:\n${q.pairs.map((p) => `- ${pairLine(p)}`).join('\n')}`);
  if (q.more) parts.push(`And ${q.more} more not listed.`);
  return { conclusion: 'neutral', summary: parts.join('\n\n') };
}

/** The two worst it found, for « Where to look first »: the worst function and the closest pair, or two of the one that found something. */
export function worstOfQuality(q: DiffQuality): string[] {
  const fns = q.functions.map(functionLine);
  const pairs = q.pairs.map(pairLine);
  const first = [fns[0], pairs[0]].filter((x): x is string => x !== undefined);
  return first.length === 2 ? first : [...fns, ...pairs].slice(0, 2);
}
