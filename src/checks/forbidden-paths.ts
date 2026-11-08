// `factory/chemins-interdits` (ORC-151): what the agent's diff never touches, whatever it was asked: what judges it, what
// runs at the next checkout or install, and the factory's knowledge. Pure: the caller reads the commit.
import { dirname, posix } from 'node:path';
import { Minimatch } from 'minimatch';
import { mdCode } from './markdown.js';
import { normalizePath } from './test-files.js';
import type { CheckResult } from './types.js';

export const FORBIDDEN_CHECK = 'factory/chemins-interdits';

/**
 * What no run writes, trusted or not (ORC-151, ORC-338): what judges the work (CI, `.github/**` whole: workflows, the
 * actions they call, dependabot; `CODEOWNERS`, which GitHub reads at the root, in `.github/` and in `docs/`), what
 * holds secrets or runs on entering the directory (`.env`, `.env.*` but the templates of `ENV_TEMPLATES`, `.envrc`),
 * what runs at the next checkout or install (git hooks and attributes, `.npmrc`, and the install files of
 * `factory/dependances` that execute: `setup.py`, `.pnpmfile.cjs`, `.yarnrc*` whose `yarnPath` runs, Yarn's releases
 * and plugins), the factory's knowledge, and `claims/**` (a fact written by a compromised agent would outlive its
 * ticket). `x/**` is the directory and all under it; `x*` a file name's start. At any depth, as the tools read them in
 * a subfolder too, but for those that only mean something at the root.
 */
export const FORBIDDEN_PATHS: readonly string[] = Object.freeze([
  '.github/**', 'CODEOWNERS', '.env', '.env.*', '.envrc', '.factory/**', '.claude/**', '.git/hooks/**', '.git/config', '.gitattributes', '.gitmodules', '.npmrc', '.yarnrc*', '.yarn/releases/**', '.yarn/plugins/**', '.pnpmfile.cjs',
  'setup.py', '.husky/**', '.vscode/**', 'Dockerfile*', '.devcontainer/**', 'claims/**',
]);
const ROOT_ONLY: ReadonlySet<string> = new Set(['.github/**', 'claims/**']);

/**
 * The `.env.*` a run may write: templates committed by design, which no loader reads (dotenv reads `.env`; Vite and
 * Next.js `.env`, `.env.local`, `.env.<mode>` and `.env.<mode>.local`; direnv runs `.envrc`). Any other `.env.*` is one
 * of those or unknown, and treated as one: it holds values, and a loader may read it in `verify` or in CI.
 */
const ENV_TEMPLATES: ReadonlySet<string> = new Set(['.env.example', '.env.sample', '.env.template']);

/** `anywhere`: the pattern also names the path's tail, `a/b` matching `x/a/b`; otherwise it starts at the root. */
function matches(path: string, pattern: string, anywhere: boolean): boolean {
  // A case-insensitive checkout reads `.GitHub/Workflows` as the real one.
  const p = path.toLowerCase();
  const pat = pattern.toLowerCase();
  const segments = p.split('/');
  const tails = anywhere ? segments.map((_, i) => segments.slice(i).join('/')) : [p];
  if (pat.endsWith('*') && !pat.endsWith('**')) {
    const start = pat.slice(0, -1);
    return tails.some((t) => t.startsWith(start) && !t.slice(start.length).includes('/'));
  }
  const isDir = pat.endsWith('/**');
  const name = isDir ? pat.slice(0, -3) : pat;
  return tails.some((t) => t === name || (isDir && t.startsWith(`${name}/`)));
}

export function forbiddenPattern(path: string): string | undefined {
  const p = normalizePath(path);
  // The templates leave the `.env.*` rule only: under a forbidden directory, they stay forbidden with it.
  const template = ENV_TEMPLATES.has((p.split('/').at(-1) ?? '').toLowerCase());
  return FORBIDDEN_PATHS.find((pattern) => !(template && pattern === '.env.*') && matches(p, pattern, !ROOT_ONLY.has(pattern)));
}

/** Dotfiles matched like any file, case ignored as a case-insensitive checkout reads it, and no `#` comment or `!` negation (the config refuses `!`). */
const GLOB = { dot: true, nocase: true, nocomment: true, nonegate: true } as const;

/**
 * A `sensitive_paths` entry as it is matched: `\` read as `/`, and `./infra/` or `/infra` naming what `infra` does, as the
 * paths compared are from the root and have neither.
 */
const normalizePattern = (pattern: string): string => pattern.replace(/\\/g, '/').replace(/^(\.?\/)+/, '').replace(/\/+$/, '');

/**
 * The repository's `sensitive_paths` (globs from the root), each compiled once: the first that names a path or one of its
 * parent directories. `infra` protects `infra/main.tf`, and `src/auth*` protects `src/authz/x.ts`.
 */
export function sensitiveMatcher(patterns: readonly string[]): (path: string) => string | undefined {
  const compiled = patterns.map((pattern) => ({ pattern, glob: new Minimatch(normalizePattern(pattern), GLOB) }));
  return (path) => {
    const segments = normalizePath(path).split('/');
    const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
    return compiled.find(({ glob }) => prefixes.some((p) => glob.match(p)))?.pattern;
  };
}

/**
 * Why a `sensitive_paths` entry would name no path of the repository, or undefined: it must compile, and each of its
 * expansions (`{a,b}`) must name something from the root (not `.` or empty), with no drive, no `..` and no absolute path
 * left inside a brace, where no `/` is stripped.
 */
export function repoPatternError(pattern: string): string | undefined {
  const p = normalizePattern(pattern);
  if (p === '' || p === '.') return 'it names the whole repository, or nothing: name a directory or a file';
  let glob: Minimatch;
  try {
    glob = new Minimatch(p, GLOB);
  } catch (err) {
    return `not a glob (${(err as Error).message})`;
  }
  for (const expanded of glob.braceExpand()) {
    const segments = expanded.split('/');
    if (expanded.startsWith('/') || /^[a-zA-Z]:/.test(expanded) || segments.includes('..')) return 'a path from the repository root is expected (no drive, no `..`, no absolute path in a brace)';
    if (expanded === '' || segments.every((s) => s === '.' || s === '')) return 'it names the whole repository, or nothing: name a directory or a file';
    // The paths compared have no `.` segment: `a/./b`, or `./infra` inside a brace, would match nothing.
    if (segments.includes('.') || segments.slice(0, -1).includes('')) return 'a `.` or empty segment matches no path: write `a/b`, not `a/./b` or `a//b`';
  }
  if (glob.empty || glob.makeRe() === false) return 'not a glob that can match a path';
  return undefined;
}

/** Out of the tree: absolute, or climbing above the root from where the link is. */
export function isOutwardLink(path: string, target: string): boolean {
  if (target.startsWith('/') || target.startsWith('\\') || /^[a-zA-Z]:/.test(target)) return true;
  const resolved = posix.normalize(posix.join(dirname(normalizePath(path)).replace(/\\/g, '/'), target.replace(/\\/g, '/')));
  return resolved === '..' || resolved.startsWith('../');
}

/** `scripts` of a `package.json`, canonical enough to compare; a file that does not parse is itself, whole. */
function scriptsOf(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  try {
    const scripts = (JSON.parse(content) as { scripts?: unknown }).scripts;
    return scripts === undefined ? undefined : JSON.stringify(scripts);
  } catch {
    return content;
  }
}

export interface ForbiddenView {
  /** Files changed from the base to the head; `link`, the target of one that is a symbolic link at the head. */
  changed: readonly { path: string; deleted: boolean; link?: string }[];
  showAtBase(path: string): Promise<string | undefined>;
  showAtHead(path: string): Promise<string | undefined>;
  /**
   * Given once the branch took untrusted content (ORC-338): the repository's `sensitive_paths`, forbidden among
   * `changed`, the paths changed since then. What trusted work committed before stays the human reviewer's.
   */
  sensitive?: { patterns: readonly string[]; changed: ReadonlySet<string> };
}

/** Every forbidden or sensitive path the diff touches, every outward link it adds, and `package.json#scripts` changed, at any depth. */
export async function checkForbiddenPaths(view: ForbiddenView): Promise<CheckResult> {
  const findings: string[] = [];
  const sensitivePattern = view.sensitive && sensitiveMatcher(view.sensitive.patterns);
  for (const { path, deleted, link } of view.changed) {
    const pattern = forbiddenPattern(path);
    const sensitive = pattern || !view.sensitive?.changed.has(path) ? undefined : sensitivePattern?.(path);
    if (pattern) findings.push(`${mdCode(path)}: forbidden path (${mdCode(pattern)})`);
    if (sensitive) findings.push(`${mdCode(path)}: sensitive path of the repository (${mdCode(sensitive)}), forbidden to work that read untrusted content`);
    if (link !== undefined && isOutwardLink(path, link)) findings.push(`${mdCode(path)}: symbolic link pointing outside (to ${mdCode(link)})`);
    if (normalizePath(path).split('/').at(-1) === 'package.json') {
      const [before, after] = [scriptsOf(await view.showAtBase(path)), deleted ? undefined : scriptsOf(await view.showAtHead(path))];
      if (before !== after) findings.push(`${mdCode(path)}: \`scripts\` changed (${mdCode('package.json#scripts')})`);
    }
  }
  const ok = findings.length === 0;
  const summary = ok ? 'No forbidden path touched' : `Paths forbidden to the agent, publication blocked. Remove these changes from the branch:\n${findings.map((f) => `- ${f}`).join('\n')}`;
  return { check: FORBIDDEN_CHECK, ok, summary };
}
