import { createHash } from 'node:crypto';
import type { Page, Shots } from '../adapters/browser/types.js';
import type { VerifyFailure } from '../core/types.js';
import type { Capture, OutputRefused } from '../publish/output-policy.js';
import { sensitiveMatcher } from './forbidden-paths.js';
import { mdCode } from './markdown.js';

/** The check of the visual proof (ORC-176), on the published commit. */
export const VISUAL_PROOF_CHECK = 'factory/preuve-visuelle';

/** One capture the factory took and kept (`artifacts`): its image by its hash, never its bytes, in the journal. */
export interface VisualCapture {
  side: 'before' | 'after';
  sha: string;
  width: number;
  sha256: string;
}

/**
 * What `verify` decided and did of the visual proof, journaled with its verdict (ORC-176). `triggers`: the paths of the
 * diff in `visual_paths`; `intake`: the ticket asked for it at `intake` (ORC-206). Required, it was taken (`captures`), or
 * the factory could not take it (`unavailable`, why): the check is then indicative, until ORC-152.
 */
export interface VisualProof {
  decision: 'required' | 'not_applicable';
  triggers: string[];
  intake?: true;
  captures?: VisualCapture[];
  unavailable?: string;
}

/**
 * The decision, on the real diff (ORC-176): required when the ticket asked for it at `intake`, which can only harden, or when
 * the diff touches `visual_paths`. Nothing the agent writes comes in: a model's `not_applicable` has no way here.
 */
export function decideVisualProof(at: { intake: boolean; changed: readonly string[]; visualPaths: readonly string[] }): VisualProof {
  const visual = sensitiveMatcher(at.visualPaths);
  const triggers = at.changed.filter((p) => visual(p) !== undefined);
  const required = at.intake || triggers.length > 0;
  return { decision: required ? 'required' : 'not_applicable', triggers, ...(at.intake ? { intake: true as const } : {}) };
}

/** A path of the app, from `visual_scenario.url` of `submit_result`: never another host (`//x`, `https://x`), the root otherwise. */
export function scenarioPath(url: string | undefined): string {
  return url && /^\/(?![/\\])[^\s\\]*$/.test(url) ? url : '/';
}

/** A capture as it goes out, through the `OutputPolicy` (ORC-214): refused, it rejects `OutputRefused`. */
export type CaptureGate = (c: Capture) => Promise<unknown>;

export interface Judged {
  failures: VerifyFailure[];
  /** Not taken, through no fault of the branch: the base does not start, or its page does not pass the policy. */
  unavailable?: string;
  files: { capture: VisualCapture; png: Uint8Array }[];
}

/** The id of the artifact kept of a capture `verify` took for `runId` (ORC-176), by which a changelog entry names it (ORC-197). */
export const captureArtifactId = (runId: string, c: Pick<VisualCapture, 'side' | 'width'>): string => `visual:${runId}:${c.side}:${c.width}`;

/** A capture as the factory names it, in its caption and in the published check. */
export const captureLabel = (c: Pick<VisualCapture, 'side' | 'sha' | 'width'>): string => `${c.side === 'before' ? 'Before' : 'After'}, ${c.sha.slice(0, 12)}, ${c.width} px`;

const sha256 = (png: Uint8Array): string => createHash('sha256').update(png).digest('hex');
const fail = (output: string): VerifyFailure => ({ command: VISUAL_PROOF_CHECK, exitCode: 1, output });
/** What the base's failure says in the journal and the published check: its first line, short, as code. Its log stays out. */
const brief = (detail: string): string => mdCode((detail.split('\n')[0] ?? '').slice(0, 200));

/** A refusal of the policy is a verdict on the capture; any other rejection (its scanner down) is an infrastructure failure, and goes on. */
async function vetted<T>(work: () => Promise<T>): Promise<{ files: T } | { refused: string }> {
  try {
    return { files: await work() };
  } catch (err) {
    // By its name: `checks` takes only the type of the policy, whose module imports `verify`'s.
    if ((err as Error).name !== 'OutputRefused') throw err;
    return { refused: (err as OutputRefused).refusals.map((r) => r.detail).join('; ') };
  }
}

/**
 * The controls of the visual proof (ORC-176) on what the browser shot: the commit's page starts and loads without a console
 * error; only then is the base shot (`shootBefore`); every capture passes the policy, and the commit's differs from the base's at
 * one width at least. What fails on the commit goes back to `build`; what fails on the base is no fault of the agent, and leaves
 * the proof unavailable.
 */
export async function judgeShots(after: Shots, shootBefore: () => Promise<Shots>, shas: { before: string; after: string }, gate: CaptureGate): Promise<Judged> {
  const short = (sha: string) => sha.slice(0, 12);
  if (!after.started) return { failures: [fail(`The application did not start on ${short(shas.after)}, no capture could be taken:\n${after.detail}`)], files: [] };
  const errors = after.pages.flatMap((p) => p.consoleErrors.map((e) => `- ${p.width} px: ${mdCode(e)}`));
  if (errors.length) return { failures: [fail(`The page loads with errors in its console on ${short(shas.after)}:\n${errors.join('\n')}`)], files: [] };
  const before = await shootBefore();
  if (!before.started) return { failures: [], unavailable: `the application does not start on the base ${short(shas.before)}: ${brief(before.detail)}`, files: [] };

  const kept = async (side: VisualCapture['side'], pages: Page[]) => {
    const files = [];
    for (const { width, png } of pages) {
      const capture = { side, sha: shas[side], width, sha256: sha256(png) };
      await gate({ width, png, caption: captureLabel(capture) });
      files.push({ capture, png });
    }
    return files;
  };
  const afterKept = await vetted(() => kept('after', after.pages));
  if ('refused' in afterKept) return { failures: [fail(`A capture of ${short(shas.after)} does not pass the output policy: ${afterKept.refused}`)], files: [] };
  const beforeKept = await vetted(() => kept('before', before.pages));
  if ('refused' in beforeKept) return { failures: [], unavailable: `a capture of the base ${short(shas.before)} does not pass the output policy: ${brief(beforeKept.refused)}`, files: [] };
  const hashBefore = new Map(beforeKept.files.map((f) => [f.capture.width, f.capture.sha256]));
  if (afterKept.files.every((f) => hashBefore.get(f.capture.width) === f.capture.sha256)) {
    return { failures: [fail(`The captures before (${short(shas.before)}) and after (${short(shas.after)}) are identical at every width: the change shows nothing on the page shot.`)], files: [] };
  }
  return { failures: [], files: [...beforeKept.files, ...afterKept.files] };
}
