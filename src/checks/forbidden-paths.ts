// `factory/chemins-interdits` (ORC-151): what the agent's diff never touches, whatever it was asked: what judges it, what
// runs at the next checkout or install, and the factory's knowledge. Pure: the caller reads the commit.
import { dirname, posix } from 'node:path';
import { mdCode } from './markdown.js';
import { normalizePath } from './test-files.js';
import type { CheckResult } from './types.js';

export const FORBIDDEN_CHECK = 'factory/chemins-interdits';

/**
 * The list of the MVP doc, and `claims/**` (a fact written by a compromised agent would outlive its ticket). `x/**` is
 * the directory and all under it; `x*` a file name's start. At any depth, as the tools read them in a subfolder too,
 * but for those that only mean something at the root.
 */
export const FORBIDDEN_PATHS: readonly string[] = Object.freeze([
  '.github/workflows/**', '.factory/**', '.claude/**', '.git/hooks/**', '.git/config', '.gitattributes', '.gitmodules', '.npmrc', '.husky/**', '.vscode/**', 'Dockerfile*', '.devcontainer/**', 'claims/**',
]);
const ROOT_ONLY: ReadonlySet<string> = new Set(['.github/workflows/**', 'claims/**']);

function matches(path: string, pattern: string): boolean {
  // A case-insensitive checkout reads `.GitHub/Workflows` as the real one.
  const p = path.toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat.endsWith('*') && !pat.endsWith('**')) return (p.split('/').at(-1) ?? '').startsWith(pat.slice(0, -1));
  const dir = pat.endsWith('/**') ? pat.slice(0, -3) : pat;
  const at = (prefix: string) => p === prefix || (pat.endsWith('/**') && p.startsWith(`${prefix}/`));
  if (at(dir)) return true;
  if (ROOT_ONLY.has(pattern)) return false;
  const segments = p.split('/');
  return segments.some((_, i) => i > 0 && at(`${segments.slice(i).join('/').startsWith(dir) ? segments.slice(i).join('/').slice(0, dir.length) : '\0'}`) && (segments.slice(i).join('/') === dir || segments.slice(i).join('/').startsWith(`${dir}/`)) && (pat.endsWith('/**') || segments.slice(i).join('/') === dir));
}

export function forbiddenPattern(path: string): string | undefined {
  const p = normalizePath(path);
  return FORBIDDEN_PATHS.find((pattern) => matches(p, pattern));
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
}

/** Every forbidden path the diff touches, every outward link it adds, and `package.json#scripts` changed, at any depth. */
export async function checkForbiddenPaths(view: ForbiddenView): Promise<CheckResult> {
  const findings: string[] = [];
  for (const { path, deleted, link } of view.changed) {
    const pattern = forbiddenPattern(path);
    if (pattern) findings.push(`${mdCode(path)} : chemin interdit (${mdCode(pattern)})`);
    if (link !== undefined && isOutwardLink(path, link)) findings.push(`${mdCode(path)} : lien symbolique sortant (vers ${mdCode(link)})`);
    if (normalizePath(path).split('/').at(-1) === 'package.json') {
      const [before, after] = [scriptsOf(await view.showAtBase(path)), deleted ? undefined : scriptsOf(await view.showAtHead(path))];
      if (before !== after) findings.push(`${mdCode(path)} : \`scripts\` modifié (${mdCode('package.json#scripts')})`);
    }
  }
  const ok = findings.length === 0;
  const summary = ok ? 'Aucun chemin interdit touché' : `Chemins interdits à l'agent, publication bloquée. Retire ces changements de la branche :\n${findings.map((f) => `- ${f}`).join('\n')}`;
  return { check: FORBIDDEN_CHECK, ok, summary };
}
