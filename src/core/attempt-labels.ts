import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { runSettingsTemplate, type Settings } from '../config/run-settings.js';
import type { JobSpec, Workflow } from '../config/workflow-schema.js';
import { VERSION } from '../version.js';
import { buildPrompt, type PromptInput } from './prompt.js';
import type { QueueName } from './types.js';

/**
 * What an attempt ran with, fixed when it is created (ORC-226): enough to group outcomes by
 * prompt, skills, workflow or model later. Each fingerprint is `sha256:<hex>`.
 */
export interface AttemptFingerprints {
  /** The prompt handed to the runner: unique to the attempt (ticket, branch, input). */
  prompt: string;
  /** The same prompt with the ticket's fields as placeholders (`promptTemplate`): equal across tickets. */
  promptTemplate: string;
  /** `<packDir>/skills`: every regular file, by relative POSIX path and bytes (text with LF line ends); null if unreadable. */
  skills: string | null;
  /** The loaded workflow, as JSON with sorted keys. */
  workflow: string;
  /** The run settings without the instance's home, plus the pack's plugin files (see `configFingerprint`); null if unreadable. */
  config: string | null;
  /** The knowledge index the attempt read; null until ORC-232. */
  knowledgeIndex: string | null;
}

export interface AttemptLabels {
  /** The job the attempt runs. */
  task: string;
  queue: QueueName;
  model: string;
  factoryVersion: string;
  /** The factory build's commit, from `FACTORY_COMMIT`, set at build time (ORC-203); null on a build not given it. */
  factoryCommit: string | null;
  effort: string | null;
  image: string | null;
  risk: string | null;
  registryCommit: string | null;
  deliveredFactIds: string[] | null;
  fingerprints: AttemptFingerprints;
}

/** Labels nothing in the factory provides yet, and the tickets that will. */
const PENDING_LABELS = {
  image: ['ORC-204'],
  // Null until the ticket's `intake` assessed it (ORC-206), and on a job out of the ticket's run.
  risk: ['ORC-206'],
  registryCommit: ['ORC-257'],
  deliveredFactIds: ['ORC-257'],
  knowledgeIndex: ['ORC-232'],
} as const satisfies Record<string, readonly string[]>;

type PendingLabel = keyof typeof PENDING_LABELS;

const sha256 = (h: ReturnType<typeof createHash>): string => `sha256:${h.digest('hex')}`;

/** By UTF-16 code unit, not locale: the order a hash depends on must not vary by machine. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function hashText(text: string): string {
  return sha256(createHash('sha256').update(text, 'utf8'));
}

/** JSON with object keys sorted at every level, so equal values give equal text. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => byCodeUnit(a, b)));
    }
    return v;
  });
}

const workflowPrints = new WeakMap<Workflow, string>();

/** Computed once per loaded workflow: a project's workflow object lives as long as the daemon. */
export function workflowFingerprint(workflow: Workflow): string {
  let print = workflowPrints.get(workflow);
  if (print === undefined) workflowPrints.set(workflow, (print = hashText(stableJson(workflow))));
  return print;
}

/** The prompt with the ticket's fields as placeholders: what the job asks, whatever the ticket. */
export function promptTemplate(p: PromptInput): string {
  return buildPrompt({
    ...p,
    issue: { identifier: '<TICKET>', title: '<TITRE>', description: '<DESCRIPTION>', url: '<URL>' },
    branch: p.branch && '<BRANCHE>',
    prUrl: p.prUrl && '<PR>',
    promptContext: p.promptContext && '<CONTEXTE>',
    conventions: p.conventions && '<CONVENTIONS>',
    commit: p.commit && '<COMMIT>',
    input: p.input && { kind: p.input.kind, text: '<ENTREE>' },
  });
}

interface FileEntry {
  path: string;
  bytes: Buffer;
}

/**
 * A text file (no NUL byte) with CRLF turned into LF, so a Windows checkout (autocrlf) and a
 * Linux one hash alike; other files as they are. latin1 maps every byte to itself.
 */
function normalizeEol(bytes: Buffer): Buffer {
  if (bytes.includes(0) || !bytes.includes(13)) return bytes;
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

/**
 * Every regular file under `dir`, by POSIX path relative to `dir` prefixed with `label`, with
 * normalized line ends; none when `dir` is missing. Symbolic links are neither followed nor hashed.
 */
async function treeFiles(dir: string, label: string): Promise<FileEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e) => {
        const full = join(e.parentPath, e.name);
        return { path: `${label}/${relative(dir, full).split(sep).join('/')}`, bytes: normalizeEol(await readFile(full)) };
      }),
  );
}

/** Hashes files by sorted path, each path and content length-prefixed so no two sets collide. */
function hashFiles(files: FileEntry[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => byCodeUnit(a.path, b.path))) {
    h.update(`${Buffer.byteLength(f.path)}:${f.path}\n${f.bytes.length}:`);
    h.update(f.bytes);
    h.update('\n');
  }
  return sha256(h);
}

export async function skillsFingerprint(packDir: string): Promise<string> {
  return hashFiles(await treeFiles(join(packDir, 'skills'), 'skills'));
}

/** The pack's directories and files, besides skills/, that Claude Code loads with the plugin. */
const PLUGIN_DIRS = ['hooks', '.claude-plugin', 'agents', 'commands'];
const PLUGIN_FILES = ['.mcp.json'];

/** A file of the pack, as it is, or none when it is missing. */
async function packFile(packDir: string, name: string): Promise<FileEntry[]> {
  try {
    return [{ path: name, bytes: await readFile(join(packDir, name)) }];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * The run settings as `runSettingsTemplate` builds them from `<packDir>/settings.json` (`<HOME>`
 * in place of the instance's home, keys sorted), plus the plugin's other files: `hooks/`,
 * `.claude-plugin/`, `agents/`, `commands/` and `.mcp.json`. Not the `<home>/run-settings.json`
 * file itself: written from the same pack settings at each start, its absolute paths differ by
 * instance and OS.
 */
export async function configFingerprint(packDir: string): Promise<string> {
  const [[pack], ...plugin] = await Promise.all([
    packFile(packDir, 'settings.json'),
    ...PLUGIN_DIRS.map((d) => treeFiles(join(packDir, d), d)),
    ...PLUGIN_FILES.map(async (f) => (await packFile(packDir, f)).map((e) => ({ ...e, bytes: normalizeEol(e.bytes) }))),
  ]);
  const settings = pack
    ? [{ path: 'settings', bytes: Buffer.from(stableJson(runSettingsTemplate(JSON.parse(pack.bytes.toString('utf8')) as Settings)), 'utf8') }]
    : [];
  return hashFiles([...settings, ...plugin.flat()]);
}

export interface PackFingerprints {
  skills: string | null;
  config: string | null;
}

/**
 * The fingerprints of the pack as a run reads it now: Claude Code loads the pack at each run, so an
 * edit counts from the next attempt, without a restart. A pack that cannot be read gives null
 * fingerprints, reported to `onError`: labels never stop a launch.
 */
export async function packFingerprints(packDir: string, onError: (err: Error) => void = () => {}): Promise<PackFingerprints> {
  const read = (p: Promise<string>) =>
    p.catch((err: Error) => {
      onError(err);
      return null;
    });
  const [skills, config] = await Promise.all([read(skillsFingerprint(packDir)), read(configFingerprint(packDir))]);
  return { skills, config };
}

export interface AttemptLabelInput {
  job: JobSpec;
  /** The prompt handed to the runner. */
  prompt: string;
  /** What it was built from: its template is hashed from it. */
  promptInput: PromptInput;
  workflow: Workflow;
  pack: PackFingerprints;
  /** Defaults to `FACTORY_COMMIT`, or null when unset. */
  factoryCommit?: string | null;
  /** The ticket's risk when the attempt starts (ORC-206): null before `intake` assessed it. */
  risk?: string | null;
}

export function attemptLabels(i: AttemptLabelInput): AttemptLabels {
  const { skills, config } = i.pack;
  const factoryCommit = i.factoryCommit !== undefined ? i.factoryCommit : process.env['FACTORY_COMMIT'] || null;
  return {
    task: i.job.name,
    queue: i.job.queue,
    model: i.job.model,
    factoryVersion: VERSION,
    factoryCommit,
    effort: i.job.effort ?? null,
    image: null,
    risk: i.risk ?? null,
    registryCommit: null,
    deliveredFactIds: null,
    fingerprints: {
      prompt: hashText(i.prompt),
      promptTemplate: hashText(promptTemplate(i.promptInput)),
      skills,
      workflow: workflowFingerprint(i.workflow),
      config,
      knowledgeIndex: null,
    },
  };
}

/**
 * The labels of an attempt still null, each with the tickets that will fill it. Derived when read,
 * not stored, so an old attempt names the tickets still to come.
 */
export function pendingLabels(l: AttemptLabels): Partial<Record<PendingLabel, string[]>> {
  const values: Record<PendingLabel, unknown> = { ...l, knowledgeIndex: l.fingerprints.knowledgeIndex };
  const pending: Partial<Record<PendingLabel, string[]>> = {};
  for (const [name, tickets] of Object.entries(PENDING_LABELS) as [PendingLabel, readonly string[]][]) {
    if (values[name] === null) pending[name] = [...tickets];
  }
  return pending;
}
