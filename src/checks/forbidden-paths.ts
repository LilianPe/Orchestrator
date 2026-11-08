// `factory/chemins-interdits` (ORC-151): what the agent's diff never touches, whatever it was asked: what judges it, what
// runs at the next checkout or install, and the factory's knowledge. Pure: the caller reads the commit.
import { dirname, posix } from 'node:path';
import { mdCode } from './markdown.js';
import { normalizePath } from './test-files.js';
import type { CheckResult } from './types.js';

export const FORBIDDEN_CHECK = 'factory/chemins-interdits';

/**
 * What no run writes, trusted or not (ORC-151, ORC-338): what judges the work (CI, `.github/**` whole: workflows, the
 * actions they call, dependabot; `CODEOWNERS`, which GitHub reads at the root, in `.github/` and in `docs/`), what
 * holds secrets (`.env*`, `.envrc` included, which direnv runs), what runs at the next checkout or install (git hooks
 * and attributes, `.npmrc`, and the install files of `factory/dependances` that execute: `setup.py`, `.pnpmfile.cjs`,
 * `.yarnrc*` whose `yarnPath` runs, Yarn's releases and plugins), the factory's knowledge, and `claims/**` (a fact
 * written by a compromised agent would outlive its ticket). `x/**` is the directory and all under it; `x*` a file
 * name's start. At any depth, as the tools read them in a subfolder too, but for those that only mean something at the root.
 * `SENSITIVE_PATHS` (`core/engine.ts`) is within this list: an untrusted run is held to it like any other.
 */
export const FORBIDDEN_PATHS: readonly string[] = Object.freeze([
  '.github/**', 'CODEOWNERS', '.env*', '.factory/**', '.claude/**', '.git/hooks/**', '.git/config', '.gitattributes', '.gitmodules', '.npmrc', '.yarnrc*', '.yarn/releases/**', '.yarn/plugins/**', '.pnpmfile.cjs', 'setup.py',
  '.husky/**', '.vscode/**', 'Dockerfile*', '.devcontainer/**', 'claims/**',
]);
const ROOT_ONLY: ReadonlySet<string> = new Set(['.github/**', 'claims/**']);

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
  return FORBIDDEN_PATHS.find((pattern) => matches(p, pattern, !ROOT_ONLY.has(pattern)));
}

/** The first of the repository's `sensitive_paths` that names `path`, from the root (`repoPatternError` keeps them to what this reads). */
export function sensitivePattern(path: string, patterns: readonly string[]): string | undefined {
  const p = normalizePath(path);
  return patterns.find((pattern) => matches(p, pattern, false));
}

/**
 * Why a `sensitive_paths` entry cannot be enforced as written, or undefined: a path from the root, `dir/**`, a name's
 * start `x*`, or an exact path. Any other glob would match nothing here, and a path the repository believes protected
 * must not be silently open.
 */
export function repoPatternError(pattern: string): string | undefined {
  const segments = pattern.split('/');
  if (pattern.includes('\\') || pattern.startsWith('/') || segments.some((s) => s === '' || s === '.' || s === '..')) return 'a path from the repository root is expected (no leading `/`, `./`, `..`, `\\` or empty segment)';
  const body = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
  if (/[*?[\]{}]/.test(body) || body === '') return 'only `dir/**`, `name*` at the end, or an exact path are supported';
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
  /** The repository's `sensitive_paths`, given only when the work read untrusted content (ORC-338): then forbidden too. */
  sensitive?: readonly string[];
}

/** Every forbidden or sensitive path the diff touches, every outward link it adds, and `package.json#scripts` changed, at any depth. */
export async function checkForbiddenPaths(view: ForbiddenView): Promise<CheckResult> {
  const findings: string[] = [];
  for (const { path, deleted, link } of view.changed) {
    const pattern = forbiddenPattern(path);
    const sensitive = pattern ? undefined : sensitivePattern(path, view.sensitive ?? []);
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
