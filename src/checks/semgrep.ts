// Semgrep on the lines a branch adds (ORC-333): the factory's base of security rules, which docker/runner.Dockerfile
// copies into the image from docker/semgrep/, and the repository's own, read on its default branch. Pure: the caller
// runs the argv in a sandbox without network, on the commit's checkout, and hands back what it returned.
//
// What the branch could write to silence it is not read: a `nosemgrep` comment (`--disable-nosem`), a `.semgrepignore`
// (each file is named on the command line, which Semgrep 1.182.1 scans whatever its ignore files say), a `.gitignore`
// (`--no-git-ignore`), a file slow enough to time out (no timeout per file: the sandbox's own cap ends the run, a
// breakdown, never a green). Its size cap per file is the caller's read cap, past which a file blocks as a binary anyway.
// A part of an added line Semgrep could not parse blocks too: what it does not read, it does not judge.
import type { ExecResult } from '../adapters/exec.js';
import type { DiffFile } from './diff.js';
import { mdCode } from './markdown.js';
import type { CheckResult } from './types.js';

export const SEMGREP_CHECK = 'factory/semgrep';

/** Where docker/runner.Dockerfile copies docker/semgrep/: every rule file of the directory applies. */
export const FACTORY_RULES = '/usr/local/share/factory/semgrep';

/** The repository's rules, YAML files under this directory of its default branch, which the agent cannot change (a forbidden path). */
export const REPO_RULES_DIR = '.factory/semgrep/';

export const isRepoRuleFile = (path: string): boolean => path.startsWith(REPO_RULES_DIR) && /\.ya?ml$/.test(path);

/** Where the repository's rules are mounted, read-only, in the sandbox that runs Semgrep: their paths under `REPO_RULES_DIR`, the same here. */
export const REPO_RULES_TARGET = '/factory/semgrep';

/** `semgrep scan` with the factory's flags, its rules and the repository's (`repoRules`, paths under `REPO_RULES_DIR`), on `targets`, under `timeoutS`: its report as JSON on stdout. */
export function semgrepArgv(repoRules: readonly string[], targets: readonly string[], opts: { maxBytes: number; timeoutS: number }): string[] {
  return [
    'timeout', String(opts.timeoutS), 'semgrep', 'scan',
    ...[FACTORY_RULES, ...repoRules.map((r) => `${REPO_RULES_TARGET}/${r}`)].flatMap((c) => ['--config', c]),
    '--metrics=off', '--disable-version-check', '--disable-nosem', '--no-git-ignore',
    '--timeout', '0', '--max-target-bytes', String(opts.maxBytes), '--json', '--quiet',
    // A path may start with a dash.
    '--', ...targets,
  ];
}

/** The lines each file of the diff adds, by its path after the change: a file that adds none (deleted, renamed only, binary) is not there. */
export function addedLines(files: readonly DiffFile[]): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  for (const f of files) if (f.added.length) added.set(f.path, new Set(f.added.map((l) => l.line)));
  return added;
}

export interface SemgrepFinding {
  path: string;
  line: number;
  rule: string;
  message: string;
}

/** A part of a file Semgrep could not parse, on lines the branch adds. */
export interface SemgrepUnread {
  path: string;
  message: string;
}

/** What a run of Semgrep says of the lines the branch adds. */
export interface SemgrepRead {
  found: SemgrepFinding[];
  unread: SemgrepUnread[];
}

type Span = { start: { line: number }; end: { line: number } };

interface Report {
  results: ({ check_id: string; path: string; extra?: { message?: string } } & Span)[];
  errors?: { message?: string; long_msg?: string; short_msg?: string; path?: string; spans?: Span[] }[];
}

/**
 * What Semgrep found on the lines the branch adds (`added`): a finding on a line it did not write is the base's, not the
 * branch's; so is a part of a file it could not parse. Anything but a clean exit with a readable report is a breakdown,
 * never a green: it throws.
 */
export function semgrepFindings({ code, stdout, stderr }: ExecResult, added: ReadonlyMap<string, ReadonlySet<number>>): SemgrepRead {
  let report: Report | undefined;
  try {
    report = JSON.parse(stdout) as Report;
  } catch {
    // Read below: no report at all.
  }
  const said = (e: NonNullable<Report['errors']>[number]) => e.long_msg ?? e.message ?? e.short_msg ?? '';
  if (code !== 0) throw new Error(`semgrep could not run (code ${code}): ${report?.errors?.map(said).filter(Boolean).join('; ') || stderr.trim().slice(-2000)}`);
  if (!Array.isArray(report?.results)) throw new Error(`semgrep returned no readable report (code ${code})`);
  // The first added line in `span`, if any.
  const addedIn = (path: string, span: Span) => {
    const lines = added.get(path);
    for (let l = span.start.line; lines && l <= span.end.line; l++) if (lines.has(l)) return l;
    return undefined;
  };
  const found: SemgrepFinding[] = [];
  for (const r of report.results) {
    const line = addedIn(r.path, r);
    if (line !== undefined) found.push({ path: r.path, line, rule: r.check_id, message: r.extra?.message ?? '' });
  }
  // An error with no span on a scanned file blocks: where it did not read is unknown.
  const unread = (report.errors ?? [])
    .filter((e) => e.path !== undefined && added.has(e.path) && (!e.spans?.length || e.spans.some((s) => addedIn(e.path!, s) !== undefined)))
    .map((e) => ({ path: e.path!, message: said(e).split('\n')[0]! }));
  return { found, unread };
}

/** The `factory/semgrep` check run on what was found. */
export function semgrepCheck({ found, unread }: SemgrepRead): CheckResult {
  if (!found.length && !unread.length) return { check: SEMGREP_CHECK, ok: true, summary: 'No security rule broken on the lines the branch adds.' };
  const parts = [];
  if (found.length) {
    parts.push('Security rule broken on lines the branch adds, publication blocked. Fix the code: a `nosemgrep` comment is not read.', ...found.map((f) => `- ${mdCode(f.path)}:${f.line} (${f.rule}): ${f.message}`));
  }
  if (unread.length) parts.push('Lines the branch adds that Semgrep could not parse, publication blocked: what it does not read, it cannot judge. Write them so they parse.', ...unread.map((u) => `- ${mdCode(u.path)}: ${u.message}`));
  return { check: SEMGREP_CHECK, ok: false, summary: parts.join('\n') };
}
