import type { Workflow } from '../../src/config/workflow-schema.js';

/**
 * `workflow` as a version frozen before ORC-183 holds it: its `review` a session that fixed and pushed, its commit verified
 * then published, a failed check blocking (the review does not fix it), its end in Human Review with a synthesis. A ticket
 * started on such a version keeps deciding so: what the engine tests of verify, publication and step ends read.
 */
export function beforeOrc183(workflow: Workflow): Workflow {
  const { lens: _, ...review } = workflow.jobs['review']!;
  return {
    ...workflow,
    jobs: { ...workflow.jobs, review: { ...review, workspace: 'worktree', structuredOutput: false, repoChecks: true, verifyFailure: 'block', onSuccess: { move: 'human_review', post: 'synthesis' } } },
  };
}
