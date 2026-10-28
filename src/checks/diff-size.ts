// Size of the diff `baseSha..SHA` outside tests against `max_diff` (ORC-145): over the bound, the factory opens no PR.
// Pure and deterministic, like the other checks: the caller produces the diff text.
//
// What counts, per file of the diff:
// - a file counts once, its lines are added + removed lines: a deleted file counts with every removed line;
// - a test file (the shared rule of test-files.ts) does not count, nor does a file a tool writes whole and nobody
//   reviews line by line: a lockfile (one added dependency rewrites hundreds of its lines) or a drizzle-kit migration
//   snapshot (a 4-line migration comes with a 1,000-line snapshot). Both are known by name only, like tests. What a
//   lockfile installs is not a size question: no check reads lockfiles yet (deps.ts reads the manifests);
// - a renamed file is left out only when both its paths are: moving code into `test/` still counts. A copy is judged
//   by its new path: the original does not change;
// - a pure rename counts as one file with no line, a binary file as one file with no line.
// Other generated files count: nothing in the diff says a file is generated.
import { parseDiff, type DiffFile } from './diff.js';
import { mdCode } from './markdown.js';
import { isTestFile, normalizePath } from './test-files.js';
import type { CheckResult } from './types.js';

export const DIFF_SIZE_CHECK = 'factory/taille-du-diff';

export interface MaxDiff {
  /** Changed files outside tests and generated files. */
  files: number;
  /** Added + removed lines outside tests and generated files. */
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
export function resolveMaxDiff(config?: Partial<MaxDiff> | null): MaxDiff {
  const limits: MaxDiff = { ...MAX_DIFF };
  // `max_diff:` with no value reads as null in YAML: no tightening.
  if (config === undefined || config === null) return limits;
  if (typeof config !== 'object' || Array.isArray(config)) throw new MaxDiffConfigError('max_diff : un objet `{ files, lines }` est attendu.');
  const unknown = Object.keys(config).filter((k) => k !== 'files' && k !== 'lines');
  if (unknown.length > 0) throw new MaxDiffConfigError(`max_diff : clé(s) inconnue(s) ${unknown.join(', ')} ; seules \`files\` et \`lines\` existent.`);
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
  'pylock.toml',
  'deno.lock',
]);

/** A lockfile (`package-lock.json`, `uv.lock`, `pylock.toml`, `pylock.<name>.toml`…), or drizzle-kit's `meta/NNNN_snapshot.json` and `meta/_journal.json`. */
export function isGeneratedFile(path: string): boolean {
  const segments = normalizePath(path).split('/');
  const name = segments.at(-1) ?? '';
  if (LOCKFILES.has(name) || /^pylock\.[^/]+\.toml$/.test(name)) return true;
  return segments.at(-2) === 'meta' && (/^\d+_snapshot\.json$/.test(name) || name === '_journal.json');
}

type FileKind = 'code' | 'test' | 'generated';

function kindOf(file: DiffFile): FileKind {
  const paths = [file.path, ...(file.status === 'renamed' && file.oldPath !== undefined ? [file.oldPath] : [])];
  if (paths.some((p) => !isTestFile(p) && !isGeneratedFile(p))) return 'code';
  return paths.some(isGeneratedFile) ? 'generated' : 'test';
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
  /** Files left out. */
  tests: number;
  generated: number;
}

/** `diff`: the text of `git diff`, or its files already parsed (`verify` parses once for every check). */
export function measureDiff(diff: string | DiffFile[]): DiffMeasure {
  const counted: CountedFile[] = [];
  let tests = 0;
  let generated = 0;
  for (const file of typeof diff === 'string' ? parseDiff(diff) : diff) {
    const kind = kindOf(file);
    if (kind === 'test') tests++;
    else if (kind === 'generated') generated++;
    else counted.push({ path: file.path, lines: file.added.length + file.removed });
  }
  counted.sort((a, b) => b.lines - a.lines);
  return { size: { files: counted.length, lines: counted.reduce((n, f) => n + f.lines, 0) }, counted, tests, generated };
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
  const parts: string[] = [];
  if (m.tests > 0) parts.push(`${m.tests} fichier(s) de test non compté(s)`);
  if (m.generated > 0) parts.push(`${m.generated} fichier(s) généré(s) non compté(s)`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function blockedSummary(m: DiffMeasure, limits: MaxDiff): string {
  const over: string[] = [];
  if (m.size.files > limits.files) over.push(`${m.size.files} fichiers hors tests, au-delà de ${limits.files}`);
  if (m.size.lines > limits.lines) over.push(`${m.size.lines} lignes hors tests, au-delà de ${limits.lines}`);
  const biggest = m.counted.slice(0, LISTED).map((f) => `- ${mdCode(f.path)} : ${f.lines} ligne(s)`);
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
export function diffSizeCheck(diff: string | DiffFile[], options: DiffSizeOptions = {}): DiffSizeResult {
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
