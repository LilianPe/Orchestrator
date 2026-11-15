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

/**
 * The searches that found no recipe (ORC-406): `failures` of them while the files that decide how the application starts
 * kept `fingerprint` (`makeStartFingerprint`; absent where git could not read them). A declared `preview` sets it back to 0.
 */
export interface NotFoundNote {
  scope: string;
  status: 'not_found';
  failures: number;
  fingerprint?: string;
  origin: string;
  ticket: string;
  checkedAt: string;
}

/** A note that does not parse: a human's edit, never overwritten nor read as none. */
export type ReadNote = RecipeNote | NotFoundNote | 'unreadable' | undefined;

/** Past this many searches that found nothing, none is asked while the fingerprint holds (ORC-406). */
export const MAX_FAILED_SEARCHES = 3;

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
const notFoundSchema = z
  .object({
    type: z.literal('command'),
    key: z.literal('preview'),
    scope: z.string().min(1),
    status: z.literal('not_found'),
    failures: z.number().int().nonnegative(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    origin: z.string().min(1),
    ticket: z.string().min(1),
    checked_at: day,
  })
  .strict();

/**
 * The files at the root of the default branch that decide how the application starts (ORC-406), whose fingerprint bounds the
 * search: the lockfiles, package.json (its scripts only), a Makefile, pyproject.toml, a compose file.
 */
export const START_FILES = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
  'Makefile', 'makefile', 'GNUmakefile', 'pyproject.toml', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'requirements.txt',
  'Gemfile.lock', 'Cargo.lock', 'go.sum', 'composer.lock',
  'compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml',
] as const;

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

/** A note that holds a recipe, valid or invalidated. */
export const isNote = (n: ReadNote): n is RecipeNote => typeof n === 'object' && n.status !== 'not_found';

export const isNotFound = (n: ReadNote): n is NotFoundNote => typeof n === 'object' && n.status === 'not_found';

/** No search past `MAX_FAILED_SEARCHES` that found nothing, while the files that decide the start are as they were (ORC-406). */
const exhausted = (n: NotFoundNote, fingerprint: string | undefined): boolean => n.failures >= MAX_FAILED_SEARCHES && n.fingerprint === fingerprint;

/**
 * A search is owed with no note, under three that found nothing on the same start files (ORC-406), or once after an invalidation;
 * never past a valid note, nor over a note a human broke.
 */
export const searchOwed = (n: ReadNote, fingerprint?: string): boolean =>
  n === undefined || (isNotFound(n) && !exhausted(n, fingerprint)) || (isNote(n) && n.status === 'invalid' && n.searchesLeft === 1);

/** Why no search is asked any more for a repository with no recipe (ORC-406), for the proof it leaves unavailable. */
export function noSearchReason(n: ReadNote, fingerprint: string | undefined): string | undefined {
  if (!isNotFound(n) || !exhausted(n, fingerprint)) return undefined;
  return `the build agent searched ${n.failures} times without finding how to start it (last on ${n.ticket}); no search until the files that decide how it starts change (lockfiles, package.json scripts, Makefile, pyproject.toml, compose)`;
}

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
  /** The fingerprint of the files that decide the start, as the launch read it on the default branch (ORC-406). */
  fingerprint: string | undefined;
}

export const searchAsked = (c: SearchContext, note: ReadNote): boolean => c.step === 'build' && c.canShoot && !c.replayed && !c.declared && !c.services && searchOwed(note, c.fingerprint);

export function formatRecipeNote(n: RecipeNote | NotFoundNote): string {
  const repo = n.scope.replace(/^repo:/, '');
  const replace = 'Declare `preview` in .factory/config.yml, or delete this note, to replace it.';
  if (n.status === 'not_found') {
    const nf = { type: 'command', key: 'preview', scope: n.scope, status: n.status, failures: n.failures, ...(n.fingerprint ? { fingerprint: n.fingerprint } : {}), origin: n.origin, ticket: n.ticket, checked_at: n.checkedAt };
    const said = `The build agent searched ${n.failures} time(s) since the files that decide how it starts last changed, and found no command that starts the application (ORC-406). After ${MAX_FAILED_SEARCHES}, no search until they change.`;
    return `---\n${stringify(nf, { lineWidth: 0 })}---\n\n# How to start ${repo}\n\n${said} ${replace}\n`;
  }
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
  const said =
    n.status === 'valid'
      ? `Recorded by the factory (ORC-386): it started this recipe and the application answered on PORT at ${n.sha.slice(0, 12)}.`
      : `Invalidated by the factory (ORC-386): ${n.invalidated?.reason ?? 'it no longer starts the application'}.`;
  return `---\n${stringify(front, { lineWidth: 0 })}---\n\n# How to start ${repo}\n\n${said} ${replace}\n`;
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
  const nf = notFoundSchema.safeParse(raw);
  if (nf.success) {
    const { failures, fingerprint, origin, ticket, checked_at } = nf.data;
    return { scope: nf.data.scope, status: 'not_found', failures, ...(fingerprint ? { fingerprint } : {}), origin, ticket, checkedAt: checked_at };
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
   * A search with no recipe to show for it, over no note or earlier ones (ORC-406): counted while the files that decide the start
   * hold `fingerprint`, counted from one when they changed.
   */
  searchFailed(repo: string, previous: NotFoundNote | undefined, s: { fingerprint: string | undefined; sha: string; runId: string; ticket: string; at: Date }, vet: Vet): Promise<string | undefined> {
    const failures = previous && previous.fingerprint === s.fingerprint ? previous.failures + 1 : 1;
    const note: NotFoundNote = { scope: `repo:${repo}`, status: 'not_found', failures, ...(s.fingerprint ? { fingerprint: s.fingerprint } : {}), origin: `agent:build@${s.runId}`, ticket: s.ticket, checkedAt: isoDay(s.at) };
    return this.write(repo, note, previous, `no start recipe found on ${s.sha.slice(0, 12)} (${s.ticket}, ${failures} of ${MAX_FAILED_SEARCHES})`, vet);
  }

  /**
   * What `verify` made of the recipe (ORC-386), as the note `note` stood before the check: the found recipe that answered, recorded;
   * the learned one that no longer starts, invalidated; the one search owed, asked and finding none that answers, spent; any other
   * search that found none, counted (ORC-406). A declared `preview` sets that count back to zero.
   */
  settle(
    repo: string,
    note: ReadNote,
    s: { asked: boolean; found: PreviewRecipe | undefined; outcome: PreviewOutcome | undefined; sha: string; port: number; runId: string; ticket: string; at: Date; fingerprint: string | undefined; declared: boolean },
    vet: Vet,
  ): Promise<string | undefined> {
    const o = s.outcome;
    if (o?.of === 'found' && o.answered && s.found) return this.record(repo, { recipe: s.found, sha: s.sha, port: s.port, runId: s.runId, ticket: s.ticket, at: s.at }, note, vet);
    if (o?.of === 'learned' && isNote(note)) return this.invalidate(repo, note, { reason: firstLine(o.detail) || 'the application did not start', sha: s.sha, ticket: s.ticket, at: s.at }, vet);
    if (s.declared && isNotFound(note) && note.failures > 0) return this.write(repo, { ...note, failures: 0, ticket: s.ticket, checkedAt: isoDay(s.at) }, note, `failed searches reset, \`preview\` declared (${s.ticket})`, vet);
    // No recipe handed back, or one tried that did not answer; never one the check did not reach.
    if (!s.asked || (s.found && o?.of !== 'found')) return Promise.resolve(undefined);
    if (isNote(note)) return this.searchSpent(repo, note, { ticket: s.ticket, sha: s.sha }, vet);
    if (note === undefined || isNotFound(note)) return this.searchFailed(repo, note, s, vet);
    return Promise.resolve(undefined);
  }

  /** `note` over `read`, the note its writer read before its check: another ticket's write since then wins, this one is dropped. */
  private async write(repo: string, note: RecipeNote | NotFoundNote, read: ReadNote, what: string, vet: Vet): Promise<string | undefined> {
    const text = formatRecipeNote(note);
    await vet(text);
    const asRead = JSON.stringify(read);
    return this.kb.commitNote(recipeNotePath(repo), text, `preview(${repo}): ${what}`, (current) => JSON.stringify(current === undefined ? undefined : parseRecipeNote(current)) === asRead);
  }
}
