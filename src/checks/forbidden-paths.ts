// `factory/chemins-interdits` (ORC-151): what the agent's diff never touches, whatever it was asked: what judges it, what
// runs at the next checkout or install, and the factory's knowledge. Pure: the caller reads the commit.
import { dirname, posix } from 'node:path';
import { minimatch } from 'minimatch';
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
  if (ENV_TEMPLATES.has((p.split('/').at(-1) ?? '').toLowerCase())) return undefined;
  return FORBIDDEN_PATHS.find((pattern) => matches(p, pattern, !ROOT_ONLY.has(pattern)));
}

/** Dotfiles matched like any file, case ignored as a case-insensitive checkout reads it, and no `#` comment or `!` negation (the config refuses `!`). */
const GLOB = { dot: true, nocase: true, nocomment: true, nonegate: true } as const;

/**
 * The first of the repository's `sensitive_paths` (globs from the root) that names `path` or one of its parent
 * directories: `infra` protects `infra/main.tf`, and `src/auth*` protects `src/authz/x.ts`.
 */
export function sensitivePattern(path: string, patterns: readonly string[]): string | undefined {
  const segments = normalizePath(path).split('/');
  const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
  // `./infra/` names what `infra` does: the paths compared have neither.
  return patterns.find((pattern) => prefixes.some((p) => minimatch(p, pattern.replace(/^(\.\/)+/, '').replace(/\/+$/, ''), GLOB)));
}

/** Why a `sensitive_paths` entry can name no path of the repository, or undefined: it starts at the root and stays inside it. */
export function repoPatternError(pattern: string): string | undefined {
  if (pattern.startsWith('/') || pattern.startsWith('\\') || /^[a-zA-Z]:/.test(pattern) || pattern.split(/[/\\]/).includes('..')) return 'a path from the repository root is expected (no leading `/`, no drive, no `..`)';
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
  for (const { path, deleted, link } of view.changed) {
    const pattern = forbiddenPattern(path);
    const sensitive = pattern || !view.sensitive?.changed.has(path) ? undefined : sensitivePattern(path, view.sensitive.patterns);
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
