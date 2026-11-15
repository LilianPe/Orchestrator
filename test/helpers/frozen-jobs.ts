import { blockingFix, humanRoundJob, nextOf, startMove } from '../../src/core/chain.js';
import type { JobSpec, Workflow } from '../../src/core/workflow.js';

/**
 * `workflow` as a version frozen before ORC-391 holds it: no preset, each job's start and end written on it (`onStart`,
 * `onSuccess`, `onBlocking`, `counter`) as the preset's steps decide them today. The tests of the versions frozen before
 * change those fields on it, as such a version could have them; they go with the frozen versions (ORC-392, ORC-393).
 */
export function beforeOrc391(workflow: Workflow): Workflow {
  const job = (j: JobSpec): JobSpec => {
    const end = nextOf(workflow, j);
    // The spec's end was its approval's: the job past the gate.
    const run = (end.step?.type === 'human_gate' ? nextOf(workflow, j, true) : end).run;
    const move = startMove(workflow, j);
    const fix = blockingFix(workflow, j);
    return {
      ...j,
      onStart: move ? { move } : {},
      onSuccess: { ...(end.move ? { move: end.move } : {}), ...(end.post ? { post: end.post } : {}), ...(run ? { run: run.name } : {}) },
      ...(fix ? { onBlocking: { run: fix.name } } : {}),
      ...(humanRoundJob(workflow, j) ? { counter: 'human_review' as const } : {}),
    };
  };
  const { preset: _preset, entry: _entry, ...rest } = workflow;
  return { ...rest, jobs: Object.fromEntries(Object.entries(workflow.jobs).map(([name, j]) => [name, job(j)])) };
}
