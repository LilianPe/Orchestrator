import type { JobSpec, Workflow } from '../../src/core/workflow.js';
import { beforeOrc391 } from './frozen-jobs.js';

/**
 * `workflow` as a version frozen before ORC-193 holds it: `learn` in a knowledge worktree after a merge, the `retiens`
 * command that runs `remember`, and `fais-le` answered by `propose_delegate`. A ticket started on such a version keeps
 * deciding so; the launch refuses its knowledge jobs, as the memory in writing sleeps.
 */
export function beforeOrc193(given: Workflow): Workflow {
  // Frozen before the preset drove the chain, too (ORC-391): its jobs chain by their own ends.
  const workflow = beforeOrc391(given);
  const learn: JobSpec = { ...workflow.jobs['ask']!, name: 'learn', model: 'haiku', workspace: 'knowledge', skill: 'factory:learn', input: undefined, onSuccess: {} };
  return {
    ...workflow,
    commands: ['retiens', 'fais-le'],
    on: {
      ...workflow.on,
      command: [{ say: 'retiens', run: 'remember' }, { say: 'fais-le', do: 'propose_delegate' }],
      'pr.merged': [{ move: 'done', do: 'cleanup', run: 'learn' }],
    },
    jobs: { ...workflow.jobs, learn, remember: { ...learn, name: 'remember', input: 'thread', onSuccess: { post: 'reply' } } },
  };
}
