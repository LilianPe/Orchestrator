import { createHash } from 'node:crypto';
import type { Workflow } from '../config/workflow-schema.js';
import type { WorkflowVersion } from '../store/types.js';

/** JSON with sorted keys: the same workflow always gives the same text, whatever its key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The version a ticket is frozen on (ORC-149): the workflow and the sha256 of its canonical JSON. */
export function workflowVersion(workflow: Workflow): WorkflowVersion & { definition: Workflow } {
  return { hash: createHash('sha256').update(canonical(workflow)).digest('hex'), definition: workflow };
}
