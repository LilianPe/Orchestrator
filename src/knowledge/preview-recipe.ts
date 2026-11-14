import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { parseGitHubRemote } from '../adapters/forge/github-app.js';
import { firstLine } from '../checks/visual-proof.js';
import { previewRecipeSchema, type PreviewRecipe } from '../core/agent-output.js';
import type { PreviewOutcome } from '../core/clean-verify.js';
import { PREVIEW_DIR, type KnowledgeBase } from './kb.js';

export type { PreviewRecipe };

/**
 * A start recipe the factory validated for a repository (ORC-386), as `notes/preview/<repo>.md` of the knowledge base holds it:
 * shaped as a Claim Ledger fact of type `command` (ORC-239), which it is meant to become. `research`: found by the one search
 * after an invalidation. Invalid, `searchesLeft` says whether that search is still owed.
 */
export interface RecipeNote {
  scope: string;
  recipe: PreviewRecipe;
  sha: string;
  port: number;
  checkedAt: string;
  origin: string;
  ticket: string;
  status: 'valid' | 'invalid';
  research: boolean;
  invalidated?: { reason: string; sha: string; ticket: string; at: string };
  searchesLeft?: 0 | 1;
}

/** A note that does not parse: a human's edit, never overwritten nor read as none. */
export type ReadNote = RecipeNote | 'unreadable' | undefined;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const frontSchema = z
  .object({
    type: z.literal('command'),
    key: z.literal('preview'),
    scope: z.string().min(1),
    value: previewRecipeSchema,
    evidence: z.tuple([z.object({ kind: z.literal('command'), sha, port: z.number().int().positive(), checked_at: day }).strict()]),
    origin: z.string().min(1),
    ticket: z.string().min(1),
    status: z.enum(['valid', 'invalid']),
    research: z.boolean(),
    invalidated: z.object({ reason: z.string().min(1), sha, ticket: z.string().min(1), at: day }).strict().optional(),
    searches_left: z.union([z.literal(0), z.literal(1)]).optional(),
  })
  .strict();


const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * The repository's `owner/name`, read from its GitHub origin as the forge reads it (`parseGitHubRemote`), never with the URL's
 * credentials; `fallback` (the project's id) when the URL names none, a local path say, or a name no file could carry.
 */
export function repoNameOf(originUrl: string | undefined, fallback: string): string {
  const ref = originUrl ? parseGitHubRemote(originUrl) : undefined;
  return ref && SEGMENT.test(ref.owner) && SEGMENT.test(ref.name) ? `${ref.owner}/${ref.name}` : fallback;
}

export const recipeNotePath = (repo: string): string => `${PREVIEW_DIR}/${repo}.md`;

export const isNote = (n: ReadNote): n is RecipeNote => n !== undefined && n !== 'unreadable';

/** A search is owed with no note, or once after an invalidation; never past a valid note, nor over a note a human broke. */
export const searchOwed = (n: ReadNote): boolean => n === undefined || (isNote(n) && n.status === 'invalid' && n.searchesLeft === 1);

/** What decides whether the `build` agent searches a recipe (ORC-386): the same inputs at its launch and at its check. */
export interface SearchContext {
  step: string | undefined;
  /** The instance has a browser: a recipe has a proof to serve. */
  canShoot: boolean;
  /** A replayed ticket (ORC-376) writes nothing to the knowledge base. */
  replayed: boolean;
  /** The repository declares its start (`preview`). */
  declared: boolean;
  /** The repository declares `services`, which the captures and the probe run without (ORC-282). */
  services: boolean;
}

export const searchAsked = (c: SearchContext, note: ReadNote): boolean => c.step === 'build' && c.canShoot && !c.replayed && !c.declared && !c.services && searchOwed(note);

export function formatRecipeNote(n: RecipeNote): string {
  const front = {
    type: 'command',
    key: 'preview',
    scope: n.scope,
    value: n.recipe,
    evidence: [{ kind: 'command', sha: n.sha, port: n.port, checked_at: n.checkedAt }],
    origin: n.origin,
    ticket: n.ticket,
    status: n.status,
    research: n.research,
    ...(n.invalidated ? { invalidated: n.invalidated } : {}),
    ...(n.searchesLeft !== undefined ? { searches_left: n.searchesLeft } : {}),
  };
  const repo = n.scope.replace(/^repo:/, '');
  const said =
    n.status === 'valid'
      ? `Recorded by the factory (ORC-386): it started this recipe and the application answered on PORT at ${n.sha.slice(0, 12)}.`
      : `Invalidated by the factory (ORC-386): ${n.invalidated?.reason ?? 'it no longer starts the application'}.`;
  return `---\n${stringify(front, { lineWidth: 0 })}---\n\n# How to start ${repo}\n\n${said} Declare \`preview\` in .factory/config.yml, or delete this note, to replace it.\n`;
}

export function parseRecipeNote(text: string): Exclude<ReadNote, undefined> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return 'unreadable';
  let raw: unknown;
  try {
    raw = parse(m[1]!);
  } catch {
    return 'unreadable';
  }
  const r = frontSchema.safeParse(raw);
  if (!r.success) return 'unreadable';
  const f = r.data;
  const [e] = f.evidence;
  return {
    scope: f.scope,
    recipe: f.value,
    sha: e.sha,
    port: e.port,
    checkedAt: e.checked_at,
    origin: f.origin,
    ticket: f.ticket,
    status: f.status,
    research: f.research,
    ...(f.invalidated ? { invalidated: f.invalidated } : {}),
    ...(f.searches_left !== undefined ? { searchesLeft: f.searches_left } : {}),
  };
}

/** Each note through the `OutputPolicy` before it leaves (ORC-214): it is pushed to the knowledge base's remote. */
type Vet = (text: string) => Promise<unknown>;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The factory's one way to write to the knowledge base (ORC-386), apart from `learn` and `remember`, which sleep (ORC-193): the
 * start recipes it validated itself, under `notes/preview/`, through `KnowledgeBase.commitNote`. Each write returns what to log
 * (a push refused, no remote), never throws for it.
 */
export class PreviewRecipes {
  constructor(private kb: KnowledgeBase) {}

  /** The repository's note, in the knowledge base or, for a replayed ticket (ORC-376), in its checkout at the ticket's start. */
  read(repo: string, at?: string): ReadNote {
    const f = join(at ?? this.kb.repoPath, recipeNotePath(repo));
    return existsSync(f) ? parseRecipeNote(readFileSync(f, 'utf8')) : undefined;
  }

  /** A recipe that answered on `port` at `sha`; over an invalidated note, as found by its one search. */
  record(repo: string, r: { recipe: PreviewRecipe; sha: string; port: number; runId: string; ticket: string; at: Date }, previous: ReadNote, vet: Vet): Promise<string | undefined> {
    const note: RecipeNote = {
      scope: `repo:${repo}`, recipe: r.recipe, sha: r.sha, port: r.port, checkedAt: isoDay(r.at), origin: `agent:build@${r.runId}`, ticket: r.ticket,
      status: 'valid', research: isNote(previous) && previous.status === 'invalid',
    };
    return this.write(repo, note, previous, `start recipe validated on ${r.sha.slice(0, 12)} (${r.ticket})`, vet);
  }

  /** A recipe that no longer starts the application: one search owed, none when it came from that search. */
  invalidate(repo: string, note: RecipeNote, why: { reason: string; sha: string; ticket: string; at: Date }, vet: Vet): Promise<string | undefined> {
    const invalid: RecipeNote = { ...note, status: 'invalid', invalidated: { reason: why.reason, sha: why.sha, ticket: why.ticket, at: isoDay(why.at) }, searchesLeft: note.research ? 0 : 1 };
    return this.write(repo, invalid, note, `start recipe invalidated on ${why.sha.slice(0, 12)} (${why.ticket})`, vet);
  }

  /** The one search after an invalidation found no recipe that answers: none owed any more. */
  searchSpent(repo: string, note: RecipeNote, at: { ticket: string; sha: string }, vet: Vet): Promise<string | undefined> {
    return this.write(repo, { ...note, searchesLeft: 0 }, note, `no start recipe found again on ${at.sha.slice(0, 12)} (${at.ticket})`, vet);
  }

  /**
   * What `verify` made of the recipe (ORC-386), as the note `note` stood before the check: the found recipe that answered, recorded;
   * the learned one that no longer starts, invalidated; the one search owed, asked and finding none that answers, spent.
   */
  settle(repo: string, note: ReadNote, s: { asked: boolean; found: PreviewRecipe | undefined; outcome: PreviewOutcome | undefined; sha: string; port: number; runId: string; ticket: string; at: Date }, vet: Vet): Promise<string | undefined> {
    const o = s.outcome;
    if (o?.of === 'found' && o.answered && s.found) return this.record(repo, { recipe: s.found, sha: s.sha, port: s.port, runId: s.runId, ticket: s.ticket, at: s.at }, note, vet);
    if (o?.of === 'learned' && isNote(note)) return this.invalidate(repo, note, { reason: firstLine(o.detail) || 'the application did not start', sha: s.sha, ticket: s.ticket, at: s.at }, vet);
    // No recipe handed back, or one tried that did not answer; never one the check did not reach.
    if (s.asked && isNote(note) && (!s.found || o?.of === 'found')) return this.searchSpent(repo, note, { ticket: s.ticket, sha: s.sha }, vet);
    return Promise.resolve(undefined);
  }

  /** `note` over `read`, the note its writer read before its check: another ticket's write since then wins, this one is dropped. */
  private async write(repo: string, note: RecipeNote, read: ReadNote, what: string, vet: Vet): Promise<string | undefined> {
    const text = formatRecipeNote(note);
    await vet(text);
    const asRead = JSON.stringify(read);
    return this.kb.commitNote(recipeNotePath(repo), text, `preview(${repo}): ${what}`, (current) => JSON.stringify(current === undefined ? undefined : parseRecipeNote(current)) === asRead);
  }
}
