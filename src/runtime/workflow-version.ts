import { createHash } from 'node:crypto';
import { WORKFLOW_FORMAT, type Workflow } from '../core/workflow.js';
import type { Preset } from '../presets/preset.js';
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

/** A ticket frozen on a workflow of another format than this factory's (ORC-393): refused, never decided on. */
export class FrozenFormatError extends Error {}

/**
 * The workflow a ticket is frozen on, read back (ORC-393). A version of another format than this factory's throws: format 1
 * is every version frozen before ORC-393, the preset-driven ones of ORC-391 and ORC-392 included. Its ticket is refused rather
 * than decided on rules the engine no longer has, or on a shape it does not know.
 */
export function frozenWorkflow(version: WorkflowVersion): Workflow {
  const format = (version.definition as { version?: unknown } | null)?.version;
  if (format !== WORKFLOW_FORMAT) {
    throw new FrozenFormatError(`workflow version ${version.hash.slice(0, 12)} is of format ${String(format)}, not ${WORKFLOW_FORMAT}: its ticket is refused (format 1: frozen before ORC-393)`);
  }
  const wf = renamedSkills(version.definition as Workflow);
  // A version frozen before ORC-382 has neither step table in its preset: the constants the chain read then.
  return (wf.preset as Partial<Preset>).statuses ? wf : { ...wf, preset: { ...wf.preset, statuses: FORMER_STATUSES, posts: FORMER_POSTS } };
}

/** The skills ORC-460 renamed after their step, `fix-ci` folded into `feedback`: the pack no longer ships the old names. */
const FORMER_SKILLS: Readonly<Record<string, string>> = { 'factory:dev': 'factory:build', 'factory:spec': 'factory:spec_draft', 'factory:fix-ci': 'factory:feedback' };

/** A version frozen before ORC-460, its jobs on the skills of today's pack: the launch reads `job.skill`, never the preset's steps. */
function renamedSkills(wf: Workflow): Workflow {
  const jobs = Object.fromEntries(Object.entries(wf.jobs).map(([name, job]) => [name, { ...job, skill: FORMER_SKILLS[job.skill] ?? job.skill }]));
  return { ...wf, jobs };
}

/** The step → status and step → post tables of the chain before ORC-382 moved them into the preset. */
const FORMER_STATUSES: Preset['statuses'] = { build: 'dev', review: 'ai_review', human_review: 'human_review' };
const FORMER_POSTS: Preset['posts'] = { build: 'summary', fix: 'reply', review: 'review' };
