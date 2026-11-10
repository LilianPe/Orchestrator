export function slugify(s: string, max = 40): string {
  const slug = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'ticket';
}

/**
 * How a repository names the factory's branches (ORC-283): `branches` in `.factory/config.yml`, the team's convention
 * by default. `{type}` comes from the ticket's Linear labels through `types`, `{id}` is the ticket's identifier
 * lowercased, `{slug}` its title's (`slugify`).
 */
export interface BranchNaming {
  pattern: string;
  /** Label to type, in the repository's order: the first of them the ticket carries gives its type (labels compared without case). */
  types: readonly (readonly [label: string, type: string])[];
  /** The type of a ticket that carries none of those labels. */
  fallback: string;
}

/** The team's convention when the repository declares none: `fix/<id>-<slug>` for a bug, `feat/<id>-<slug>` otherwise. */
export const DEFAULT_BRANCH_NAMING: BranchNaming = { pattern: '{type}/{id}-{slug}', types: [['Bug', 'fix']], fallback: 'feat' };

/**
 * The branches the factory named before ORC-283, `factory/<id>-<slug>`: a ticket that already has one keeps it (its PR stays
 * the one), so the factory still recognizes them as its own.
 */
export const LEGACY_BRANCHES = 'factory/';

const VARIABLE = /\{([^{}]*)\}/g;
const VARIABLES = new Set(['type', 'id', 'slug']);

const render = (pattern: string, values: Partial<Record<string, string>>): string => pattern.replace(VARIABLE, (whole, name: string) => values[name] ?? whole);

/** The type a ticket's labels give: the first of the repository's `types` it carries, else its `fallback`. */
export function branchType(labels: readonly string[], naming: BranchNaming = DEFAULT_BRANCH_NAMING): string {
  const has = new Set(labels.map((l) => l.toLowerCase()));
  return naming.types.find(([label]) => has.has(label.toLowerCase()))?.[1] ?? naming.fallback;
}

export function branchName(identifier: string, title: string, labels: readonly string[] = [], naming: BranchNaming = DEFAULT_BRANCH_NAMING): string {
  return branchNameOfType(identifier, title, branchType(labels, naming), naming);
}

/** A ticket's branch name for a given type: `factory doctor` tries its filters on every type's (ORC-283). */
export const branchNameOfType = (identifier: string, title: string, type: string, naming: BranchNaming): string =>
  render(naming.pattern, { type, id: identifier.toLowerCase(), slug: slugify(title) });

/** What every name of a type starts with, before its first `{id}` or `{slug}`: a filter under it reaches the factory's branches. */
export const branchSpaces = (naming: BranchNaming): string[] =>
  [...new Set(branchTypes(naming).map((type) => render(naming.pattern.split(/\{id\}|\{slug\}/)[0]!, { type })))].filter(Boolean);

/** What every branch the factory named a ticket before ORC-283 starts with. */
const legacyPrefix = (identifier: string): string => `${LEGACY_BRANCHES}${identifier.toLowerCase()}-`;

/** A ticket's branch as the factory named it before ORC-283. */
export const legacyBranchName = (identifier: string, title: string): string => `${legacyPrefix(identifier)}${slugify(title)}`;

/** Every type a repository's naming can give. */
export const branchTypes = (naming: BranchNaming): string[] => [...new Set([...naming.types.map(([, type]) => type), naming.fallback])];

/**
 * The prefixes of the branches a ticket can have (ORC-207, ORC-283): its name for each type, up to its slug, and the
 * legacy `factory/<id>-`. What the forge is asked for; `ownBranchMatcher` then tells which of the branches found are the ticket's.
 */
export function ownBranchPrefixes(identifier: string, naming: BranchNaming = DEFAULT_BRANCH_NAMING): string[] {
  const id = identifier.toLowerCase();
  const head = naming.pattern.split('{slug}')[0]!;
  return [...new Set([...branchTypes(naming).map((type) => render(head, { type, id })), legacyPrefix(identifier)])];
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';

/** Whether a branch is one the factory names for this ticket, by the repository's naming (any type, any title) or the legacy one. Built once per ticket. */
export function ownBranchMatcher(identifier: string, naming: BranchNaming = DEFAULT_BRANCH_NAMING): (name: string) => boolean {
  const id = identifier.toLowerCase();
  const legacy = legacyPrefix(identifier);
  const types = branchTypes(naming).map(escape).join('|');
  const source = naming.pattern
    .split(/(\{[^{}]*\})/)
    .map((part) => (part === '{type}' ? `(?:${types})` : part === '{id}' ? escape(id) : part === '{slug}' ? SLUG : escape(part)))
    .join('');
  const own = new RegExp(`^${source}$`);
  return (name) => name.startsWith(legacy) || own.test(name);
}


/**
 * Git's own rules on a branch's name (`git check-ref-format`), what `refs/heads/<name>` must be: the agent's HEAD is read
 * by them (`agentHead`), so a name the repository's naming makes is too. Never `..`: it becomes a path.
 */
export const BRANCH_NAME = /^(?!-|\.)(?!.*(\.\.|@\{|\/\.|\/\/|\.lock(\/|$)))[^\s\p{Cc}~^:?*[\\]+$/u;

/** A name git takes for a branch, and that `BRANCH_NAME` reads: none that starts or ends with `/`, ends with `.`, nor `@` or `HEAD`. */
export const isBranchRefName = (name: string): boolean =>
  BRANCH_NAME.test(name) && name !== '@' && name !== 'HEAD' && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.');

/** Samples a naming is tried on: identifiers of several lengths, the empty title's slug and a long one. */
const SAMPLE_IDS = ['ORC-1', 'ZZ9-70000'];
const SAMPLE_SLUGS = ['ticket', slugify('x'.repeat(60))];

/**
 * Why a repository's naming cannot be used (ORC-283), empty when it can: a variable that is none, no `{id}` (two tickets
 * would share a branch), an `{id}` glued to its neighbours (`orc-1` would read as the start of `orc-12`), a name git refuses,
 * or one that collides with the default branch (`main` as a branch, or a folder of branches: git keeps one of the two).
 */
export function branchNamingErrors(naming: BranchNaming, defaultBranch?: string): string[] {
  const errors: string[] = [];
  const { pattern } = naming;
  const unknown = [...pattern.matchAll(VARIABLE)].map((m) => m[1]!).filter((v) => !VARIABLES.has(v));
  if (unknown.length) errors.push(`unknown variable(s) ${unknown.map((v) => `{${v}}`).join(', ')}: only {type}, {id} and {slug}`);
  if (/[{}]/.test(pattern.replace(VARIABLE, ''))) errors.push('a `{` or `}` that opens or closes no variable');
  const at = pattern.indexOf('{id}');
  // `factory doctor` holds a CI filter under that beginning as reaching the factory's branches, whatever team key it names.
  if (/^\{(id|slug)\}/.test(pattern)) errors.push('the pattern must start with fixed text or {type} (`agent/{id}`, `{type}/{id}`), never with {id} or {slug}');
  if (at === -1) errors.push('{id} is required: without it, two tickets would share a branch');
  else {
    const before = pattern.slice(0, at);
    const after = pattern.slice(at + '{id}'.length);
    if (/(?:[a-z0-9]|\})$/i.test(before) || /^(?:[a-z0-9]|\{)/i.test(after)) errors.push('{id} must stand between separators (`/`, `-`, `_`, `.`) or at an end of the pattern');
  }
  if (errors.length) return errors;
  const samples = branchTypes(naming).flatMap((type) => SAMPLE_IDS.flatMap((id) => SAMPLE_SLUGS.map((slug) => render(pattern, { type, id: id.toLowerCase(), slug }))));
  const refused = samples.find((s) => !isBranchRefName(s));
  if (refused !== undefined) errors.push(`"${refused}" is not a branch name git takes (git check-ref-format)`);
  const collides = defaultBranch && samples.find((s) => s === defaultBranch || s.startsWith(`${defaultBranch}/`) || defaultBranch.startsWith(`${s}/`));
  if (collides) errors.push(`"${collides}" collides with the default branch ${defaultBranch}`);
  return errors;
}
