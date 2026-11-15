import { createHash } from 'node:crypto';
import { WORKFLOW_FORMAT, type Workflow } from '../core/workflow.js';
import type { WorkflowVersion } from '../store/types.js';

/** JSON with sorted keys: the same workflow always gives the same text, whatever its key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 of the canonical JSON: the hash of a workflow or a preset version. */
export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** The version a ticket is frozen on (ORC-149): the workflow and the sha256 of its canonical JSON. */
export function workflowVersion(workflow: Workflow): WorkflowVersion & { definition: Workflow } {
  return { hash: hashCanonical(workflow), definition: workflow };
}

/**
 * The workflow a ticket is frozen on, read back (ORC-393). A version of another format than this factory's, the v1 ones frozen
 * before the preset drove the chain, throws: its ticket is refused rather than decided on rules it no longer has.
 */
export function frozenWorkflow(version: WorkflowVersion): Workflow {
  const format = (version.definition as { version?: unknown } | null)?.version;
  if (format !== WORKFLOW_FORMAT) {
    throw new Error(`workflow version ${version.hash.slice(0, 12)} is of format ${String(format)}, not ${WORKFLOW_FORMAT}: frozen before ORC-393, its ticket is refused`);
  }
  return version.definition as Workflow;
}
