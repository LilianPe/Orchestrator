import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { execCmd, type Exec } from '../adapters/exec.js';
import type { SandboxProvider } from '../adapters/sandbox/types.js';
import type { ActivityInput, Tracker } from '../adapters/tracker/types.js';
import type { AgentOutput } from '../core/agent-output.js';
import { boxOpener, gitleaksArgv, gitleaksFindings } from '../core/clean-verify.js';
import { VERIFY_TIMEOUT_MS } from '../core/verify.js';

/**
 * The caps of what the factory publishes (ORC-214), the one place they are named. The doc gives no value: these are read from
 * what the factory posts today, with room. `text`: a comment, an activity or a PR body; the longest composed today is a red
 * check's block, its output's last 4,000 characters around a few lines. `prTitle`: GitHub's own limit. `summary`, `field`
 * (why, the question), `item` and `items` (one entry, and the entries of a list): the fields of `submit_result`, whose schema
 * holds the same caps, so the agent shortens within its run. A dev summary in the pack's four sections runs to a few hundred
 * words. `relay`: what the live feed showed of a tool's parameter until ORC-214. `captureBytes` and `captureWidth`: a PNG of
 * a page at one of the three widths of ORC-176. `base64Run` and `hexRun`: a run that long is a blob, not prose; a sha-1 (40)
 * and a sha-256 (64) stay under `hexRun`.
 */
export const OUTPUT_LIMITS = {
  text: 10_000,
  prTitle: 256,
  summary: 6_000,
  field: 2_000,
  item: 500,
  items: 20,
  relay: 120,
  captureBytes: 2 * 1024 * 1024,
  captureWidth: { min: 320, max: 3_840 },
  base64Run: 100,
  hexRun: 65,
} as const;

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

const item = z.string().max(OUTPUT_LIMITS.item);
const list = z.array(item).max(OUTPUT_LIMITS.items);
/** The fields of `submit_result` the factory composes from, with their caps: `agentOutputSchema` applies them at submission. */
export const PUBLISHED_FIELDS = {
  summary: z.string().min(1).max(OUTPUT_LIMITS.summary),
  question: z.string().min(1).max(OUTPUT_LIMITS.field),
  why: z.string().max(OUTPUT_LIMITS.field),
  list,
  hints: z.array(z.object({ file: z.string().min(1).max(OUTPUT_LIMITS.item), reason: z.string().min(1).max(OUTPUT_LIMITS.item) }).strict()).max(OUTPUT_LIMITS.items),
};
const composedFrom = z
  .object({ summary: PUBLISHED_FIELDS.summary, why: PUBLISHED_FIELDS.why, risks: list, untested: list, review_hints: PUBLISHED_FIELDS.hints })
  .passthrough();

const line = (max: number) => z.string().min(1).max(max).regex(/^[^\r\n]*$/, 'one line');
const text = z.string().max(OUTPUT_LIMITS.text);
/** The texts the factory publishes, strict: a Linear comment or activity, a PR's text, a capture's caption. */
const activitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['thought', 'response', 'elicitation', 'error']), body: text.min(1), ephemeral: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('action'), action: line(OUTPUT_LIMITS.relay), parameter: z.string().max(OUTPUT_LIMITS.text), result: text.optional(), ephemeral: z.boolean().optional() }).strict(),
]);
const prSchema = z.object({ title: line(OUTPUT_LIMITS.prTitle), body: text.min(1) }).strict();
const captureSchema = z
  .object({
    width: z.number().int().min(OUTPUT_LIMITS.captureWidth.min).max(OUTPUT_LIMITS.captureWidth.max),
    png: z.instanceof(Uint8Array),
    caption: line(OUTPUT_LIMITS.item),
  })
  .strict();

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEX = new RegExp(`[0-9a-fA-F]{${OUTPUT_LIMITS.hexRun},}`);
const BASE64 = new RegExp(`[A-Za-z0-9+/_=-]{${OUTPUT_LIMITS.base64Run},}`, 'g');
/** Bits per character past which a run is encoded data: random base64 is near 6, and base64 of English above 4.5; prose, a path or a slug stay near 4. */
const BLOB_ENTROPY = 4.5;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.values()].reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}

function blob(s: string): string | undefined {
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

/** Every string of a value, for the blob and secret checks: an activity's fields, a PR's title and body. */
const strings = (v: Record<string, unknown>): string[] => Object.values(v).filter((x): x is string => typeof x === 'string');

/**
 * The comment of a run's end, composed by the factory from what the agent submitted (ORC-289, ORC-214), never from its last
 * text: the build's fields in the factory's order and words, a reply's or a synthesis's summary alone. A run that submitted
 * nothing has `NO_RESULT`; fields over their caps (a result read from a row older than them) have the notice that it is withheld.
 */
export function composeResult(o: AgentOutput | undefined, style: 'summary' | 'reply' | 'synthesis'): string {
  if (!o) return NO_RESULT;
  const valid = composedFrom.safeParse(o);
  if (!valid.success) return withheld(zodRefusals('result', valid.error));
  if (style !== 'summary') return o.summary;
  const section = (title: string, items: string[]) => (items.length ? [`**${title}**\n${items.map((i) => `- ${i}`).join('\n')}`] : []);
  return [
    o.summary,
    ...(o.why ? [`**Why**: ${o.why}`] : []),
    ...section('Risks', o.risks),
    ...section('Untested', o.untested),
    ...section('To review', o.review_hints.map((h) => `\`${h.file}\`: ${h.reason}`)),
  ].join('\n\n');
}

/** What is published in place of a refused text: the rules it broke, nothing of it. */
export function withheld(refusals: readonly Refusal[]): string {
  return `The factory withheld this message: it does not pass the output policy (${refusals.map((r) => r.detail).join('; ')}). Nothing of it is published; the factory's log has the run.`;
}

/**
 * The `OutputPolicy` (ORC-214): every text the factory publishes passes it, in Linear and on GitHub, and so will the
 * visual-proof captures (ORC-176). A strict schema, capped sizes (`OUTPUT_LIMITS`), no base64 or hexadecimal blob, and
 * gitleaks: the same scanner, flags and image as the check of the diff (`scanSecrets`), on the text exactly as published.
 * Without `scan`, the secret check is off: only a test, or the fake runner's daemon, which reaches no model, goes without.
 */
export class OutputPolicy {
  constructor(private readonly scan?: SecretScan) {}

  /** The checks that need no scanner, on one text: its cap and its blobs. */
  check(s: string, where = 'text', max: number = OUTPUT_LIMITS.text): Refusal[] {
    if (s.length > max) return [{ rule: 'size', detail: `${where}: ${s.length} characters, more than ${max}` }];
    const found = blob(s);
    return found ? [{ rule: 'blob', detail: `${where}: ${found}` }] : [];
  }

  /**
   * The live relay's whole check (`ActivityRelay`): its activities hold the factory's words alone, a closed table's label and the
   * job's step, so no gitleaks, which would cost a sandbox per activity. What would not pass is not sent.
   */
  checkRelay(a: ActivityInput): Refusal[] {
    const shape = activitySchema.safeParse(a);
    if (!shape.success) return zodRefusals('relay', shape.error);
    return strings(a as unknown as Record<string, unknown>).flatMap((s) => this.check(s, 'relay', OUTPUT_LIMITS.relay));
  }

  /** Rejects `OutputRefused` with what `text` breaks, gitleaks included. A scanner that cannot run rejects with its own error. */
  async vet(s: string, where = 'text', max: number = OUTPUT_LIMITS.text): Promise<void> {
    const refusals = this.check(s, where, max);
    if (!refusals.length) refusals.push(...(await this.secrets(s, where)));
    if (refusals.length) throw new OutputRefused(refusals);
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
      for (const s of strings(a as unknown as Record<string, unknown>)) await this.vet(s, 'activity');
    });
    if (notice === undefined) return a;
    return a.type === 'action' ? { type: 'action', action: 'Withheld', parameter: notice, ...(a.ephemeral ? { ephemeral: true } : {}) } : { type: a.type, body: notice, ...(a.ephemeral ? { ephemeral: true } : {}) };
  }

  /** A PR's title and body (ORC-125, ORC-195): as they are, or `OutputRefused`, and nothing goes out. */
  async pr(t: { title: string; body: string }): Promise<{ title: string; body: string }> {
    const shape = prSchema.safeParse(t);
    if (!shape.success) throw new OutputRefused(zodRefusals('pr', shape.error));
    await this.vet(t.title, 'pr.title', OUTPUT_LIMITS.prTitle);
    await this.vet(t.body, 'pr.body');
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

  private async secrets(s: string, where: string): Promise<Refusal[]> {
    const rules = this.scan ? await this.scan(s) : [];
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
 * replaced by its notice and logged without its text. Reads, and writes without free text (moves, labels, plans), go straight on.
 */
export function policedTracker(tracker: Tracker, policy: OutputPolicy, log: (message: string) => void): Tracker {
  const comment: Tracker['comment'] = async (id, body, effectId) => {
    const out = await policy.comment(body);
    if (out !== body) log(`comment on ${id}: ${out}`);
    return tracker.comment(id, out, effectId);
  };
  const activity: Tracker['activity'] = async (session, a, effectId) => {
    const out = await policy.activity(a);
    if (out !== a) log(`activity in session ${session}: ${out.type === 'action' ? out.parameter : out.body}`);
    return tracker.activity(session, out, effectId);
  };
  return new Proxy(tracker, {
    get(target, prop) {
      if (prop === 'comment') return comment;
      if (prop === 'activity') return activity;
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const TEXT_FILE = 'text.md';

/**
 * gitleaks on a text, in a sandbox of the runner's image without network, as the check of the diff runs it (ORC-125): the
 * text alone in a fresh dir, so no `.gitleaks.toml` or `.gitleaksignore` is read with it. The dir is under `runsDir`, where the
 * engine mounts from, and removed after.
 */
export function sandboxSecretScan(d: { sandboxes: SandboxProvider; runsDir: string; log: (message: string) => void }): SecretScan {
  return async (s) => {
    const id = `output-${randomUUID()}`;
    const dir = join(d.runsDir, id);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, TEXT_FILE), s);
      const inBox = boxOpener(d.sandboxes, { runId: id, ticketId: 'output-policy', log: d.log });
      const report = await inBox('scan', dir, [], (box) => d.sandboxes.exec(box, ['timeout', String(VERIFY_TIMEOUT_MS / 1000), ...gitleaksArgv(['dir'], '.')]));
      return gitleaksFindings(report).found.map((f) => f.RuleID);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch((err: Error) => d.log(`${dir} not removed: ${err.message}`));
    }
  };
}

/** The same scan with the host's gitleaks, for an instance whose runs are on the host (`FACTORY_ALLOW_HOST_RUNS`): none installed, nothing is posted. */
export function hostSecretScan(exec: Exec = execCmd): SecretScan {
  return async (s) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-output-'));
    try {
      writeFileSync(join(dir, TEXT_FILE), s);
      const [cmd, ...args] = gitleaksArgv(['dir'], dir);
      return gitleaksFindings(await exec(cmd!, args, { timeoutMs: VERIFY_TIMEOUT_MS })).found.map((f) => f.RuleID);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
