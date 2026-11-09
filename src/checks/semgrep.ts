// Semgrep on the lines a branch adds (ORC-333): the factory's base of security rules, which docker/runner.Dockerfile
// copies into the image from docker/semgrep/, and the repository's own, read on its default branch. Pure: the caller
// runs the argv in a sandbox without network, on the commit's checkout, and hands back what it returned.
//
// What the branch could write to silence it is not read: a `nosemgrep` comment (`--disable-nosem`), a `.semgrepignore`
// (each file is named on the command line, which Semgrep 1.182.1 scans whatever its ignore files say), a `.gitignore`
// (`--no-git-ignore`), a file padded past Semgrep's default size cap or slow enough to time out (no cap and no timeout
// per file: the sandbox's own cap ends the run, a breakdown, never a green).
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

/** `semgrep scan` with the factory's flags on `targets`, under `timeoutS`: its report as JSON on stdout. */
export function semgrepArgv(configs: readonly string[], targets: readonly string[], opts: { maxBytes: number; timeoutS: number }): string[] {
  return [
    'timeout', String(opts.timeoutS), 'semgrep', 'scan',
    ...configs.flatMap((c) => ['--config', c]),
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

interface Report {
  results: { check_id: string; path: string; start: { line: number }; end: { line: number }; extra?: { message?: string } }[];
  errors?: { message?: string; long_msg?: string; short_msg?: string }[];
}

/**
 * What Semgrep found on the lines the branch adds (`added`): a finding on a line it did not write is the base's, not the
 * branch's. Anything but a clean exit with a readable report is a breakdown, never a green: it throws.
 */
export function semgrepFindings({ code, stdout, stderr }: ExecResult, added: ReadonlyMap<string, ReadonlySet<number>>): SemgrepFinding[] {
  let report: Report | undefined;
  try {
    report = JSON.parse(stdout) as Report;
  } catch {
    // Read below: no report at all.
  }
  if (code !== 0) {
    const said = report?.errors?.map((e) => e.long_msg ?? e.message ?? e.short_msg).filter(Boolean).join('; ') || stderr.trim().slice(-2000);
    throw new Error(`semgrep could not run (code ${code}): ${said}`);
  }
  if (!Array.isArray(report?.results)) throw new Error(`semgrep returned no readable report (code ${code})`);
  const found: SemgrepFinding[] = [];
  for (const r of report.results) {
    const lines = added.get(r.path);
    const at = [...(lines ?? [])].filter((l) => l >= r.start.line && l <= r.end.line);
    if (at.length) found.push({ path: r.path, line: Math.min(...at), rule: r.check_id, message: r.extra?.message ?? '' });
  }
  return found;
}

/** The `factory/semgrep` check run on what was found. */
export function semgrepCheck(found: readonly SemgrepFinding[]): CheckResult {
  if (!found.length) return { check: SEMGREP_CHECK, ok: true, summary: 'No security rule broken on the lines the branch adds.' };
  const lines = found.map((f) => `- ${mdCode(f.path)}:${f.line} (${f.rule}): ${f.message}`);
  return {
    check: SEMGREP_CHECK,
    ok: false,
    summary: `Security rule broken on lines the branch adds, publication blocked. Fix the code: a \`nosemgrep\` comment is not read.\n${lines.join('\n')}`,
  };
}
