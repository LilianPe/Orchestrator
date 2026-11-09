/**
 * The class of a diff (ORC-198), computed by the factory on what `verify` read, never on what the agent says of it, and
 * the `revue:` label of the PR it sends to Human Review. Pure: the caller reads the branch.
 *
 * - `verification-config`: what verifies the work, the frozen harness (`isFrozenHarness`, ORC-131), `.factory/**` and
 *   `.github/workflows/**`. Approved by a designated maintainer's `/refreeze` before publication, then a human's review.
 * - `sensitive`: a path of the repository's `sensitive_paths` (`.factory/config.yml`, ORC-209).
 * - `normal`: the rest.
 *
 * A diff takes the highest class it touches. Who approves each class is the preset's (`Preset.approvers`).
 */
import { createHash } from 'node:crypto';
import { fingerprint, isFrozenHarness } from '../checks/freeze.js';
import { sensitiveMatcher } from '../checks/forbidden-paths.js';
import type { AuthzAction } from './authz.js';

export type DiffClassName = 'normal' | 'sensitive' | 'verification-config';

/**
 * A class, and the paths of the diff that made it so: every one of the verification configuration, which the publication gate
 * checks; at most `CLASS_PATHS` sensitive ones, which only the reviewer is told.
 */
export interface ClassifiedDiff {
  class: DiffClassName;
  paths: string[];
}

/** The authz actions (ORC-186) a class can be approved by: their roles are the matrix's. */
type ApprovalAction = Extract<AuthzAction, 'refreeze' | 'done_merge'>;
export type Approvers = Readonly<Record<DiffClassName, readonly ApprovalAction[]>>;

export const CLASS_PATHS = 20;

/** The verification configuration beyond the frozen harness: the factory's and the CI's own configuration, from the root. */
export function isVerificationConfig(path: string): boolean {
  return isFrozenHarness(path) || CONFIG_DIRS(path) !== undefined;
}

/** Matched as `sensitive_paths`: from the root, case ignored as a case-insensitive checkout reads `.GitHub/Workflows`. */
const CONFIG_DIRS = sensitiveMatcher(['.factory', '.github/workflows']);

/** The class of a diff by its paths alone: a shared file (`package.json`...) counts whole, as `classifyBranch` refines. */
export function classifyDiff(paths: readonly string[], sensitivePaths: readonly string[]): ClassifiedDiff {
  return classOf(paths.filter(isVerificationConfig), paths, sensitivePaths);
}

/** The highest class: `config`, the verification configuration among `paths`, else the sensitive ones among them. */
function classOf(config: readonly string[], paths: readonly string[], sensitivePaths: readonly string[]): ClassifiedDiff {
  if (config.length) return { class: 'verification-config', paths: [...config] };
  const sensitive = sensitiveMatcher(sensitivePaths);
  const touched = paths.filter((p) => sensitive(p) !== undefined);
  return touched.length ? { class: 'sensitive', paths: touched.slice(0, CLASS_PATHS) } : { class: 'normal', paths: [] };
}

/** How a branch's files read at its fork point and at its head (`BranchReader`'s); undefined, a file absent or unreadable there. */
export interface ClassRead {
  showAtFork(path: string): Promise<string | undefined>;
  showAtHead(path: string): Promise<string | undefined>;
}

/**
 * The class of a branch's diff: as `classifyDiff`, but a harness file whose part the test run reads is the same at the fork
 * point and at the head (a dependency bump in `package.json`) is no verification configuration, as the freeze leaves it
 * (`fingerprint`); it still counts for `sensitive_paths`. A file absent or unreadable on either side counts.
 */
export async function classifyBranch(paths: readonly string[], sensitivePaths: readonly string[], read: ClassRead): Promise<ClassifiedDiff> {
  const same = async (path: string) => {
    const [before, after] = await Promise.all([read.showAtFork(path), read.showAtHead(path)]);
    return before !== undefined && after !== undefined && fingerprint(path, before) === fingerprint(path, after);
  };
  const harness = paths.filter(isFrozenHarness);
  const flags = await Promise.all(harness.map(same));
  const unchanged = new Set(harness.filter((_, i) => flags[i]));
  // Left out of the verification configuration only: such a file may still be one of `sensitive_paths`.
  return classOf(paths.filter((p) => isVerificationConfig(p) && !unchanged.has(p)), paths, sensitivePaths);
}

/** Whether a class waits, before publication, for a designated maintainer's `/refreeze`. Unknown (verified before ORC-198): no. */
export function needsRefreeze(diffClass: DiffClassName | undefined, approvers: Approvers): boolean {
  return diffClass !== undefined && approvers[diffClass].includes('refreeze');
}

/** The labels of the review, an exclusive group: one at a time on a PR. */
export const REVIEW_LABELS = ['revue: requise', 'revue: échantillon', 'revue: auto'] as const;
export type ReviewLabel = (typeof REVIEW_LABELS)[number];

/** Percent of the tickets of the rest drawn for a sample. */
const SAMPLE_PERCENT = 10;

/** The deterministic draw of a ticket (its id hashed): the same ticket is drawn, or not, every time. */
export function sampled(ticketId: string): boolean {
  return createHash('sha256').update(ticketId).digest().readUInt32BE(0) % 100 < SAMPLE_PERCENT;
}

/**
 * The PR's `revue:` label: required on a sensitive or verification-config diff, a class unknown, or blocking findings of
 * the AI review; a sample for a drawn ticket of the rest; else auto. Every PR still goes through Human Review at the MVP.
 */
export function reviewLabel(opts: { diffClass: DiffClassName | undefined; blocking: number; ticketId: string }): ReviewLabel {
  if (opts.diffClass !== 'normal' || opts.blocking > 0) return 'revue: requise';
  return sampled(opts.ticketId) ? 'revue: échantillon' : 'revue: auto';
}
