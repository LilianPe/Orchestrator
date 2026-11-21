import { REPO_PERMISSIONS, type RepoPermission } from '../roles/types.js';
import type { PrInfo } from './types.js';

const PASSED = new Set(['pass', 'skipping']);
const FAILED = new Set(['fail', 'cancel']);
const KNOWN = new Set([...PASSED, ...FAILED, 'pending']);

/** A bucket that fails the verdict: what `ciFailures` names, as `summarizeChecks` does (ORC-459). */
export const isFailed = (bucket: string): boolean => FAILED.has(bucket);

/**
 * A bucket outside pass/skipping/fail/cancel/pending (empty, or new) is never green: it reads as `pending` (ORC-303), so the
 * GitHub reconciliation sends no `pr.checks_passed`, and a merge refuses.
 */
export function aggregateChecks(buckets: string[]): PrInfo['checks'] {
  if (buckets.length === 0) return 'none';
  if (buckets.some((b) => FAILED.has(b))) return 'fail';
  if (buckets.every((b) => PASSED.has(b))) return 'pass';
  return 'pending';
}

/**
 * The verdict of `checks`, the failed ones, and the ones in a bucket it does not know, named so that a refused merge says
 * which one it waits on, never a bare `pending` read as a CI still running (ORC-304).
 */
export type CheckSummary = Pick<PrInfo, 'checks' | 'failedChecks' | 'unknownChecks'>;
export function summarizeChecks(checks: { name: string; bucket: string }[]): CheckSummary {
  const named = (keep: (bucket: string) => boolean) => checks.filter((c) => keep(c.bucket)).map((c) => c.name);
  const unknownChecks = named((b) => !KNOWN.has(b));
  return {
    checks: aggregateChecks(checks.map((c) => c.bucket)),
    failedChecks: named((b) => FAILED.has(b)),
    ...(unknownChecks.length ? { unknownChecks } : {}),
  };
}

const EXCERPT = 200;
/** The first EXCERPT code units of `out`, one less rather than half a character, `…` when cut, as a JSON string. */
export const excerpt = (out: string) => {
  if (out.length <= EXCERPT) return JSON.stringify(out);
  const end = /[\uD800-\uDBFF]/.test(out[EXCERPT - 1]!) ? EXCERPT - 1 : EXCERPT;
  return JSON.stringify(out.slice(0, end)) + '…';
};

/**
 * What `GET /repos/{owner}/{repo}/collaborators/{user}/permission` answers (ORC-186): its `role_name`
 * when it is a known one (`maintain`, `triage`), else the base `permission` (a custom role keeps its base).
 */
export function toRepoPermission(dto: { permission?: string; role_name?: string } | undefined): RepoPermission {
  const known = (v: string | undefined) => REPO_PERMISSIONS.find((p) => p === v);
  return known(dto?.role_name) ?? known(dto?.permission) ?? 'none';
}
