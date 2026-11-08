import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { execCmd, type Exec } from '../adapters/exec.js';
import type { SandboxProvider } from '../adapters/sandbox/types.js';
import type { ActivityInput, SearchHit, Tracker, TrackerIssue } from '../adapters/tracker/types.js';
import { agentOutputSchema, type AgentOutput } from '../core/agent-output.js';
import { boxOpener, gitleaksArgv, gitleaksFindings, sandboxGitleaksArgv, withDeadline } from '../core/clean-verify.js';
import type { PlanStep } from '../core/session-plan.js';
import { VERIFY_TIMEOUT_MS } from '../core/verify.js';
import { formatRecap, type RecapRun } from './describe.js';
import { OUTPUT_LIMITS } from './output-limits.js';

/** What the policy refuses, and where: never the text itself, which may be the secret. */
export interface Refusal {
  rule: 'schema' | 'size' | 'blob' | 'secret' | 'capture';
  detail: string;
}

export class OutputRefused extends Error {
  constructor(readonly refusals: readonly Refusal[]) {
    super(`refused by the output policy: ${refusals.map((r) => r.detail).join('; ')}`);
    this.name = 'OutputRefused';
  }
}

/** The gitleaks rules a text matches; rejects when gitleaks could not run, which is never a green. */
export type SecretScan = (text: string) => Promise<string[]>;

/** A visual-proof capture (ORC-176), as the factory will publish it: the PNG it took, at its width, with its caption. */
export interface Capture {
  width: number;
  png: Uint8Array;
  caption: string;
}

/** Posted for a run that returned no `submit_result`: nothing of its last message is (ORC-214). */
export const NO_RESULT = 'The agent ended without returning its result (`submit_result`): nothing of what it wrote is published. Its run is in the dashboard.';

const line = (max: number) => z.string().min(1).max(max).regex(/^[^\r\n]*$/, 'one line');
const text = z.string().max(OUTPUT_LIMITS.text);
/** The texts the factory publishes, strict: a Linear comment or activity, a PR's text, a capture's caption. */
const activitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['thought', 'response', 'error']), body: text.min(1), ephemeral: z.boolean().optional() }).strict(),
  /** A question; `options` are the choices of Linear's `select` signal (ORC-210), each one line. */
  z
    .object({
      type: z.literal('elicitation'),
      body: text.min(1),
      options: z.array(line(OUTPUT_LIMITS.item)).max(OUTPUT_LIMITS.options).optional(),
      ephemeral: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('action'), action: line(OUTPUT_LIMITS.item), parameter: text, result: text.optional(), ephemeral: z.boolean().optional() }).strict(),
]);
const prSchema = z.object({ title: line(OUTPUT_LIMITS.prTitle), body: text.min(1) }).strict();
const captureSchema = z
  .object({
    width: z.number().int().min(OUTPUT_LIMITS.captureWidth.min).max(OUTPUT_LIMITS.captureWidth.max),
    png: z.instanceof(Uint8Array),
    caption: line(OUTPUT_LIMITS.item),
  })
  .strict();

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEX = new RegExp(`[0-9a-fA-F]{${OUTPUT_LIMITS.hexRun},}`);
const BASE64 = new RegExp(`[A-Za-z0-9+/_=-]{${OUTPUT_LIMITS.base64Run},}`, 'g');
/** Bits per character past which a run is encoded data: random base64 is near 6, and base64 of English above 4.5; prose, a path or a slug stay near 4. */
const BLOB_ENTROPY = 4.5;
/** A line break between two long runs of the encoders' charset: how `base64` (76 columns) and `xxd -p` (60) wrap a blob, joined before it is measured. */
const WRAP = /(?<=[A-Za-z0-9+/_=-]{16})\r?\n(?=[A-Za-z0-9+/_=-]{16})/g;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.values()].reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}

function blob(raw: string): string | undefined {
  const s = raw.replace(WRAP, '');
  if (HEX.test(s)) return 'a hexadecimal blob';
  for (const [run] of s.matchAll(BASE64)) if (entropy(run) >= BLOB_ENTROPY) return 'a base64 blob';
  return undefined;
}

const zodRefusals = (where: string, error: z.ZodError): Refusal[] =>
  error.issues.map((i) => {
    const at = [where, ...i.path].join('.');
    if (i.code === 'too_big') return { rule: 'size', detail: `${at}: more than ${String(i.maximum)} ${i.origin === 'string' ? 'characters' : i.origin === 'array' ? 'entries' : ''}`.trim() };
    return { rule: 'schema', detail: `${at}: ${i.message}` };
  });

/** The texts of an activity, for the blob and secret checks: every string field but its `type`, which the schema closes. */
const texts = (a: ActivityInput): string[] =>
  Object.entries(a).flatMap(([k, v]) => (k === 'type' ? [] : typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((o): o is string => typeof o === 'string') : []));

/** What is published in place of a refused text: the rules it broke, nothing of it. */
const withheld = (refusals: readonly Refusal[]): string =>
  `The factory withheld this message: it does not pass the output policy (${refusals.map((r) => r.detail).join('; ')}). Nothing of it is published; the factory's log has the run.`;

/**
 * The comment of a run's end, composed by the factory from what the agent submitted (ORC-289, ORC-214), never from its last
 * text: a build's recap, with the work of the ticket's attempts `runs` (`formatRecap`, ORC-195), a reply's or a synthesis's
 * summary alone. A run that submitted nothing has `NO_RESULT`; a result its schema refuses today (a row older than the caps)
 * has the notice that it is withheld.
 */
export function composeResult(o: AgentOutput | undefined, style: 'summary' | 'reply' | 'synthesis', runs: readonly RecapRun[] = []): string {
  if (!o) return NO_RESULT;
  const valid = agentOutputSchema.safeParse(o);
  if (!valid.success) return withheld(zodRefusals('result', valid.error));
  return style === 'summary' ? formatRecap(o, runs) : o.summary;
}

/** Scans kept by the text's hash: a retried effect, or the ack's comment and activity, scan once. Same text, same rules, same verdict. */
const SCANS_KEPT = 256;

/**
 * The `OutputPolicy` (ORC-214): every text the factory publishes passes it, in Linear and on GitHub, and so will the
 * visual-proof captures (ORC-176). A strict schema, capped sizes (`OUTPUT_LIMITS`), no base64 or hexadecimal blob, and
 * gitleaks: the same scanner, flags and image as the check of the diff (`scanSecrets`), on the text exactly as published.
 * Without `scan`, the secret check is off: only a test, or the fake runner's daemon, which reaches no model, goes without.
 * The live relay (`ActivityRelay`) does not come here: its words are a closed table's and the job's step, none of the agent's.
 */
export class OutputPolicy {
  private scanned = new Map<string, string[]>();

  constructor(private readonly scan?: SecretScan) {}

  /** The checks that need no scanner, on one text: its cap and its blobs. */
  check(s: string, where = 'text', max: number = OUTPUT_LIMITS.text): Refusal[] {
    if (s.length > max) return [{ rule: 'size', detail: `${where}: ${s.length} characters, more than ${max}` }];
    const found = blob(s);
    return found ? [{ rule: 'blob', detail: `${where}: ${found}` }] : [];
  }

  /** Rejects `OutputRefused` with what `text` breaks, gitleaks included. A scanner that cannot run rejects with its own error. */
  vet(s: string, where = 'text', max: number = OUTPUT_LIMITS.text): Promise<void> {
    return this.vetAll([{ where, text: s, max }]);
  }

  /** A Linear comment: `body`, or the notice that it is withheld. */
  async comment(body: string): Promise<string> {
    return (await this.refused(() => this.vet(body, 'comment'))) ?? body;
  }

  /** A Linear activity: as it is, or of the same type with the notice in place of its texts. */
  async activity(a: ActivityInput): Promise<ActivityInput> {
    const notice = await this.refused(async () => {
      const shape = activitySchema.safeParse(a);
      if (!shape.success) throw new OutputRefused(zodRefusals('activity', shape.error));
      await this.vetAll(texts(a).map((t) => ({ where: 'activity', text: t })));
    });
    if (notice === undefined) return a;
    const ephemeral = a.ephemeral ? { ephemeral: true } : {};
    return a.type === 'action' ? { type: 'action', action: 'Withheld', parameter: notice, ...ephemeral } : { type: a.type, body: notice, ...ephemeral };
  }

  /** A PR's title and body (ORC-125, ORC-195): as they are, or `OutputRefused`, and nothing goes out. */
  async pr(t: { title: string; body: string }): Promise<{ title: string; body: string }> {
    const shape = prSchema.safeParse(t);
    if (!shape.success) throw new OutputRefused(zodRefusals('pr', shape.error));
    await this.vetAll([
      { where: 'pr.title', text: t.title, max: OUTPUT_LIMITS.prTitle },
      { where: 'pr.body', text: t.body },
    ]);
    return t;
  }

  /**
   * The entry point of a visual-proof capture (ORC-176), before it is published anywhere: a PNG by its signature, under its
   * weight, at a width a page is shot at, its caption a text like any other. What the image shows is not read: ORC-176 shoots
   * the factory's own preview of the branch, never a page the agent hands it.
   */
  async capture(c: Capture): Promise<Capture> {
    const shape = captureSchema.safeParse(c);
    if (!shape.success) throw new OutputRefused(zodRefusals('capture', shape.error));
    if (!PNG_SIGNATURE.every((b, i) => c.png[i] === b)) throw new OutputRefused([{ rule: 'capture', detail: 'capture: not a PNG' }]);
    if (c.png.byteLength > OUTPUT_LIMITS.captureBytes) throw new OutputRefused([{ rule: 'size', detail: `capture: ${c.png.byteLength} bytes, more than ${OUTPUT_LIMITS.captureBytes}` }]);
    await this.vet(c.caption, 'capture.caption', OUTPUT_LIMITS.item);
    return c;
  }

  /** The texts of one published item together: each checked on its own, then one gitleaks scan of them all, one sandbox per item. */
  private async vetAll(parts: readonly { where: string; text: string; max?: number }[]): Promise<void> {
    const refusals = parts.flatMap((p) => this.check(p.text, p.where, p.max));
    if (!refusals.length) refusals.push(...(await this.secrets(parts.map((p) => p.text).join('\n'), parts.map((p) => p.where).join(', '))));
    if (refusals.length) throw new OutputRefused(refusals);
  }

  private async secrets(s: string, where: string): Promise<Refusal[]> {
    if (!this.scan) return [];
    const key = createHash('sha256').update(s).digest('hex');
    let rules = this.scanned.get(key);
    if (!rules) {
      rules = await this.scan(s);
      if (this.scanned.size >= SCANS_KEPT) this.scanned.delete(this.scanned.keys().next().value!);
      this.scanned.set(key, rules);
    }
    return rules.length ? [{ rule: 'secret', detail: `${where}: a secret found by gitleaks (${[...new Set(rules)].join(', ')})` }] : [];
  }

  /** The notice of a refusal, undefined when `check` passes; any other rejection (a scanner down) goes on. */
  private async refused(check: () => Promise<void>): Promise<string | undefined> {
    try {
      await check();
      return undefined;
    } catch (err) {
      if (err instanceof OutputRefused) return withheld(err.refusals);
      throw err;
    }
  }
}

/**
 * The tracker every write of the orchestrator goes through (ORC-214): its comments and activities pass the policy, a refused one
 * replaced by its notice and logged without its text. Every method is written out, so a new one with free text cannot slip past:
 * reads, and writes without free text (moves, labels, the plan's fixed steps, the PR's link), go straight on.
 */
export class PolicedTracker implements Tracker {
  constructor(
    private readonly tracker: Tracker,
    private readonly policy: OutputPolicy,
    private readonly log: (message: string) => void,
  ) {}

  async comment(id: string, body: string, effectId?: string): Promise<void> {
    const out = await this.policy.comment(body);
    if (out !== body) this.log(`comment on ${id}: ${out}`);
    return this.tracker.comment(id, out, effectId);
  }

  async activity(session: string, a: ActivityInput, effectId?: string): Promise<void> {
    const out = await this.policy.activity(a);
    if (out !== a) this.log(`activity in session ${session}: ${out.type === 'action' ? out.parameter : out.body}`);
    return this.tracker.activity(session, out, effectId);
  }

  getIssue(id: string): Promise<TrackerIssue> { return this.tracker.getIssue(id); }
  listDelegated(teamKey: string): Promise<TrackerIssue[]> { return this.tracker.listDelegated(teamKey); }
  search(term: string, teamKey: string): Promise<SearchHit[]> { return this.tracker.search(term, teamKey); }
  moveTo(id: string, state: string): Promise<void> { return this.tracker.moveTo(id, state); }
  setLabels(id: string, add: string[], remove: string[]): Promise<void> { return this.tracker.setLabels(id, add, remove); }
  findComment(id: string, effectId: string): Promise<string | undefined> { return this.tracker.findComment(id, effectId); }
  findActivity(session: string, effectId: string): Promise<string | undefined> { return this.tracker.findActivity(session, effectId); }
  addExternalUrl(session: string, label: string, url: string): Promise<void> { return this.tracker.addExternalUrl(session, label, url); }
  ensureSession(id: string): Promise<string> { return this.tracker.ensureSession(id); }
  setSessionPlan(session: string, plan: readonly PlanStep[]): Promise<void> { return this.tracker.setSessionPlan(session, plan); }
}

const TEXT_FILE = 'text.md';

/** `run` on a dir that holds the text alone, so no `.gitleaks.toml` or `.gitleaksignore` is read with it, removed after. */
async function inTextDir<T>(dir: string, s: string, run: () => Promise<T>, log?: (message: string) => void): Promise<T> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, TEXT_FILE), s);
    return await run();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((err: Error) => log?.(`${dir} not removed: ${err.message}`));
  }
}

/** Past gitleaks' own cap: only an engine that no longer answers is still there. */
const SCAN_DEADLINE_MS = VERIFY_TIMEOUT_MS + 60_000;

/**
 * gitleaks on a text, in a sandbox of the runner's image without network, as the check of the diff runs it (ORC-125). The dir is
 * under `runsDir`, where the engine mounts from.
 */
export function sandboxSecretScan(d: { sandboxes: SandboxProvider; runsDir: string; log: (message: string) => void }): SecretScan {
  const sandboxes = withDeadline(d.sandboxes, SCAN_DEADLINE_MS);
  return (s) => {
    const id = `output-${randomUUID()}`;
    const dir = join(d.runsDir, id);
    const inBox = boxOpener(sandboxes, { runId: id, ticketId: 'output-policy', log: d.log });
    return inTextDir(dir, s, () => inBox('scan', dir, [], async (box) => gitleaksFindings(await sandboxes.exec(box, sandboxGitleaksArgv(['dir'], '.'))).found.map((f) => f.RuleID)), d.log);
  };
}

/** The same scan with the host's gitleaks, for an instance whose runs are on the host (`FACTORY_ALLOW_HOST_RUNS`): none installed, nothing is posted. */
export function hostSecretScan(exec: Exec = execCmd): SecretScan {
  return async (s) => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-output-'));
    const [cmd, ...args] = gitleaksArgv(['dir'], dir);
    return inTextDir(dir, s, async () => gitleaksFindings(await exec(cmd!, args, { timeoutMs: VERIFY_TIMEOUT_MS })).found.map((f) => f.RuleID));
  };
}
