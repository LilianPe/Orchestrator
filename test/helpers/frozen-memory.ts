import type { JobSpec, Workflow } from '../../src/core/workflow.js';
import { beforeOrc391 } from './frozen-jobs.js';

/**
 * `workflow` as a version frozen before ORC-193 holds it: its knowledge jobs, `learn` and `remember`, in a knowledge
 * worktree. The launch refuses them, as the memory in writing sleeps. The rules that started them (`learn` after a merge,
 * the `retiens` command) and `fais-le` answered by `propose_delegate` went with the rules (ORC-392).
 */
export function beforeOrc193(given: Workflow): Workflow {
  // Frozen before the preset drove the chain, too (ORC-391): its jobs chain by their own ends.
  const workflow = beforeOrc391(given);
  const learn: JobSpec = { ...workflow.jobs['ask']!, name: 'learn', model: 'haiku', workspace: 'knowledge', skill: 'factory:learn', input: undefined, onSuccess: {} };
  return {
    ...workflow,
    jobs: { ...workflow.jobs, learn, remember: { ...learn, name: 'remember', input: 'thread', onSuccess: { post: 'reply' } } },
  };
}
