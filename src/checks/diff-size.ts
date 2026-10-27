// Size of the diff `baseSha..SHA` outside tests against `max_diff` (ORC-145): over the bound, the factory opens no PR.
// Pure and deterministic, like the other checks: the caller produces the diff text.
//
// What counts, per file of the diff:
// - a file counts once, its lines are added + removed lines: a deleted file counts with every removed line;
// - a test file (the shared rule of test-files.ts) does not count, nor does a lockfile: the installer writes it, one
//   added dependency rewrites hundreds of its lines, and what it adds is the dependency check's business (ORC-165);
// - a rename or a copy is left out only when both its paths are left out: moving code into `test/` still counts;
// - a pure rename counts as one file with no line, a binary file as one file with no line.
// Other generated files count: nothing in the diff says a file is generated.
import { parseDiff, type DiffFile } from './diff.js';
import { isTestFile, normalizePath } from './test-files.js';
import type { CheckResult } from './types.js';

export const DIFF_SIZE_CHECK = 'factory/taille-du-diff';

export interface MaxDiff {
  /** Changed files outside tests and lockfiles. */
  files: number;
  /** Added + removed lines outside tests and lockfiles. */
  lines: number;
}

/** Base thresholds; ORC-142 adjusts them after measuring the golden tickets and the replay. */
export const MAX_DIFF: Readonly<MaxDiff> = Object.freeze({ files: 15, lines: 400 });

/** A `max_diff` the repository configuration cannot take: it would loosen the base, or it is not a positive integer. */
export class MaxDiffConfigError extends Error {
  override name = 'MaxDiffConfigError';
}

/**
 * The thresholds of a run: the base, tightened by the repository's `max_diff` (`.factory/config.yml`, read and
 * validated by ORC-209, which can reuse this). A bound left out keeps its base value. Throws `MaxDiffConfigError`
 * on a bound above the base: the configuration can only tighten.
 */
export function resolveMaxDiff(config: Partial<MaxDiff> = {}): MaxDiff {
  const limits: MaxDiff = { ...MAX_DIFF };
  for (const key of ['files', 'lines'] as const) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new MaxDiffConfigError(`max_diff.${key} = ${String(value)} : un entier strictement positif est attendu.`);
    }
    if (value > MAX_DIFF[key]) {
      throw new MaxDiffConfigError(`max_diff.${key} = ${value} dépasse le socle ${MAX_DIFF[key]} : la configuration du dépôt ne peut que resserrer \`max_diff\`.`);
    }
    limits[key] = value;
  }
  return limits;
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'pdm.lock',
]);

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(normalizePath(path).split('/').at(-1) ?? '');
}

type FileKind = 'code' | 'test' | 'lockfile';

function kindOf(file: DiffFile): FileKind {
  const paths = [file.path, ...(file.oldPath !== undefined ? [file.oldPath] : [])];
  if (paths.some((p) => !isTestFile(p) && !isLockfile(p))) return 'code';
  return paths.some(isLockfile) ? 'lockfile' : 'test';
}

export interface CountedFile {
  path: string;
  /** Added + removed lines. */
  lines: number;
}

export interface DiffMeasure {
  size: MaxDiff;
  /** Files that count, biggest first. */
  counted: CountedFile[];
  /** Paths left out. */
  tests: string[];
  lockfiles: string[];
}

export function measureDiff(diff: string): DiffMeasure {
  const counted: CountedFile[] = [];
  const tests: string[] = [];
  const lockfiles: string[] = [];
  for (const file of parseDiff(diff)) {
    const kind = kindOf(file);
    if (kind === 'test') tests.push(file.path);
    else if (kind === 'lockfile') lockfiles.push(file.path);
    else counted.push({ path: file.path, lines: file.added.length + file.removed });
  }
  counted.sort((a, b) => b.lines - a.lines);
  return { size: { files: counted.length, lines: counted.reduce((n, f) => n + f.lines, 0) }, counted, tests, lockfiles };
}

export interface DiffSizeOptions {
  /** The repository's `max_diff`: it can only tighten the base. */
  maxDiff?: Partial<MaxDiff>;
}

export interface DiffSizeResult extends CheckResult {
  size: MaxDiff;
  /** Thresholds applied: the base when the configuration is refused. */
  limits: MaxDiff;
}

/** Files named in a blocking summary, biggest first: where a split would start. */
const LISTED = 10;

function leftOut(m: DiffMeasure): string {
  const parts = [
    ...(m.tests.length > 0 ? [`${m.tests.length} fichier(s) de test non compté(s)`] : []),
    ...(m.lockfiles.length > 0 ? [`${m.lockfiles.length} fichier(s) de verrouillage non compté(s)`] : []),
  ];
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function blockedSummary(m: DiffMeasure, limits: MaxDiff): string {
  const over = [
    ...(m.size.files > limits.files ? [`${m.size.files} fichiers hors tests, au-delà de ${limits.files}`] : []),
    ...(m.size.lines > limits.lines ? [`${m.size.lines} lignes hors tests, au-delà de ${limits.lines}`] : []),
  ];
  const biggest = m.counted.slice(0, LISTED).map((f) => `- \`${f.path}\` : ${f.lines} ligne(s)`);
  return [
    `Diff trop gros pour une PR : ${over.join(' ; ')}${leftOut(m)}.`,
    '',
    `Plus gros fichiers hors tests${m.counted.length > LISTED ? ` (${LISTED} sur ${m.counted.length})` : ''} :`,
    ...biggest,
    '',
    `Proposition : découper le ticket en sous-tickets qui tiennent chacun sous \`max_diff\` (${limits.files} fichiers, ${limits.lines} lignes hors tests), par exemple un par module touché.`,
    'Question : quelle partie livrer en premier, ou le ticket peut-il être réduit ?',
  ].join('\n');
}

/** The `factory/taille-du-diff` check run: success only when the diff outside tests stays within `max_diff`. */
export function diffSizeCheck(diff: string, options: DiffSizeOptions = {}): DiffSizeResult {
  const measure = measureDiff(diff);
  let limits: MaxDiff;
  try {
    limits = resolveMaxDiff(options.maxDiff);
  } catch (err) {
    if (!(err instanceof MaxDiffConfigError)) throw err;
    return { check: DIFF_SIZE_CHECK, ok: false, size: measure.size, limits: { ...MAX_DIFF }, summary: `Configuration \`max_diff\` refusée : ${err.message}` };
  }
  const ok = measure.size.files <= limits.files && measure.size.lines <= limits.lines;
  const summary = ok
    ? `${measure.size.files} fichier(s), ${measure.size.lines} ligne(s) hors tests${leftOut(measure)}, dans \`max_diff\` (${limits.files} fichiers, ${limits.lines} lignes).`
    : blockedSummary(measure, limits);
  return { check: DIFF_SIZE_CHECK, ok, summary, size: measure.size, limits };
}
