// The freeze of the tests and their harness (ORC-131): after `red`, the factory fingerprints the tests the `tests` step
// wrote and the harness that runs them; from then on, any change to one of them blocks `factory/tests-gelés`, whoever
// made it (the agent or a human commit), until a maintainer's `/refreeze`. Blocking from the first ticket.
import { createHash } from 'node:crypto';
import { mdCode } from './markdown.js';
import { isTestHarnessFile, normalizePath } from './test-files.js';
import { isTable, parseToml } from './toml.js';
import type { CheckResult } from './types.js';

export const FREEZE_CHECK = 'factory/tests-gelés';

/** The command of the Linear thread that freezes the tests again, as they are at the branch's head. */
export const REFREEZE = '/refreeze';

/** What is frozen: the commit it was read on, and the fingerprint of each frozen file by path. */
export interface FrozenTests {
  sha: string;
  files: Record<string, string>;
  /**
   * `FREEZE_RULES` for a freeze made since ORC-342; absent on one made before, which keeps the harness and the
   * `package.json` part it was made with: a deploy blocks no ticket frozen before it on files it did not freeze.
   */
  rules?: number;
}

/** A commit of the branch, read on the factory's repository, never in the agent's worktree (ORC-205). */
export interface FreezeView {
  head: string;
  /** Files changed from the frozen commit to `head`. */
  changed: readonly { path: string; deleted: boolean }[];
  filesAtHead(): Promise<string[]>;
  showAtHead(path: string): Promise<string | undefined>;
}

const fileName = (path: string): string => normalizePath(path).split('/').at(-1) ?? '';

/**
 * The lines of `[section]` in an INI file, blank and comment lines left out, indentation kept (it continues a value).
 * A header as pytest's iniconfig reads it: exact, alone on its line but for a comment. Undefined when the file has no such section.
 */
function iniSection(content: string, section: string): string[] | undefined {
  const lines: string[] = [];
  let [inside, found] = [false, false];
  for (const raw of content.split(/\r?\n/)) {
    const header = /^\[([^\]]*)\]\s*(?:[#;].*)?$/.exec(raw);
    if (header) {
      inside = header[1] === section;
      found ||= inside;
    } else if (inside && !/^\s*(?:[#;]|$)/.test(raw)) lines.push(raw.trimEnd());
  }
  return found ? lines : undefined;
}

// The package.json keys of the tools a test run may read.
const PACKAGE_TOOLS = ['jest', 'mocha', 'ava', 'babel', 'c8', 'nyc'];

/**
 * The scripts `npm test` runs: `test`, `pretest`, `posttest`, and every script they run in turn (`npm run x`, `yarn x`,
 * `run-s x`...), with its own `pre` and `post`.
 */
function testScripts(scripts: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const queue = ['test'];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name) || typeof scripts[name] !== 'string') continue;
    seen.add(name);
    const body = scripts[name] as string;
    queue.push(`pre${name}`, `post${name}`);
    for (const m of body.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g)) queue.push(m[1]!);
    // npm-run-all and its `run-s`/`run-p`: its arguments are script names, globs included (`test:*`).
    if (/\b(?:run-[sp]|npm-run-all)\b/.test(body)) {
      for (const word of body.split(/\s+/)) {
        const glob = /^([\w:.-]+)\*$/.exec(word)?.[1];
        queue.push(...(glob === undefined ? [word] : Object.keys(scripts).filter((s) => s.startsWith(glob))));
      }
    }
  }
  return [...seen];
}

/**
 * What a test run reads of a package.json: the scripts `npm test` runs and the keys of the test tools; undefined when it
 * has none of them.
 */
function packageTestPart(content: string): unknown {
  const pkg = JSON.parse(content) as { scripts?: Record<string, unknown> } & Record<string, unknown>;
  const scripts = pkg.scripts ?? {};
  const run = testScripts(scripts);
  const tools = PACKAGE_TOOLS.filter((k) => k in pkg);
  if (tools.length === 0 && run.length === 0) return undefined;
  return { scripts: Object.fromEntries(run.map((s) => [s, scripts[s]])), ...Object.fromEntries(tools.map((k) => [k, pkg[k]])) };
}

/**
 * The files shared with other tools, of which only the part the test run reads is frozen: undefined when they have none,
 * a throw when they do not parse.
 */
const TEST_PART = new Map<string, (content: string) => unknown>([
  ['package.json', packageTestPart],
  [
    'pyproject.toml',
    (c) => {
      const tool = parseToml(c).tool;
      return isTable(tool) ? tool.pytest : undefined;
    },
  ],
  // The sections pytest reads in the INI files it shares (ORC-311).
  ['tox.ini', (c) => iniSection(c, 'pytest')],
  ['setup.cfg', (c) => iniSection(c, 'tool:pytest')],
]);

// The configuration of a tool, by the shape of its name (ORC-342): `<tool>.config.<ext>`, `<tool>.conf.<ext>`,
// `.<tool>rc[.<ext>]`. The runner reads more than its own file: vite's config (vitest's `test`, the aliases a test
// imports through), the transforms of babel, swc or a framework, npm's shell. So any tool's, but those below.
const TOOL_CONFIG = /^(?:\.?([\w-]+?)\.(?:config|conf)(?:\.[\w-]+)*\.(?:[cm]?[jt]s|json5?|ya?ml|toml)|\.([\w-]+?)rc(?:\.(?:[cm]?[jt]s|json5?|ya?ml|toml))?)$/;
// The tools whose configuration changes no test: linters, formatters, commit hooks, styles, the Node version manager,
// the application's own (`app.config.ts` of Angular, Expo, Nuxt).
const NOT_TEST_TOOLS = new Set(['eslint', 'prettier', 'stylelint', 'commitlint', 'lint-staged', 'lintstaged', 'markdownlint', 'markdownlint-cli2', 'cspell', 'tailwind', 'postcss', 'browserslist', 'renovate', 'husky', 'nvm', 'editorconfig', 'app']);

function isToolConfig(path: string): boolean {
  const m = TOOL_CONFIG.exec(fileName(path));
  return !!m && !NOT_TEST_TOOLS.has(m[1] ?? m[2]!);
}

/** The harness of a freeze made before ORC-342 (`FrozenTests.rules` absent): the runner's config, `conftest.py`, `tsconfig*.json`, the shared files. */
function isHarnessBefore342(path: string): boolean {
  return isTestHarnessFile(path) || TEST_PART.has(fileName(path)) || /^(?:conftest\.py|tsconfig(?:\.[\w-]+)*\.json)$/.test(fileName(path));
}

/**
 * The harness beyond the runner's config (`isTestHarnessFile`): `conftest.py` (pytest's shared fixtures), `tsconfig*.json`
 * and `jsconfig.json`, bun's `bunfig.toml`, any tool's configuration that can change which tests run or how (ORC-342), and
 * the files whose test part only is frozen (what `npm test` runs of `package.json`, the pytest section of `pyproject.toml`,
 * `tox.ini` and `setup.cfg`).
 */
export function isFrozenHarness(path: string): boolean {
  return isHarnessBefore342(path) || /^(?:jsconfig\.json|bunfig\.toml)$/.test(fileName(path)) || isToolConfig(path);
}

/** The rules a freeze was made with: absent before ORC-342, whose harness and `package.json` part it keeps. */
const FREEZE_RULES = 2;
/** What a freeze made before ORC-342 read of a package.json: its `test` script. */
const packageTestScript = (content: string): unknown => (JSON.parse(content) as { scripts?: { test?: unknown } }).scripts?.test;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * sha256 of what the test run reads in `content`: the whole file, but the `test` script of a `package.json` and the
 * pytest section of a `pyproject.toml` (`[tool.pytest]`), a `tox.ini` (`[pytest]`) or a `setup.cfg` (`[tool:pytest]`).
 * Undefined when such a file has none: nothing to freeze. A file that does not parse, or the read of a blob too large to
 * show (a NUL in it, ORC-311), is fingerprinted whole: any change to it then counts. `before342`: a `package.json` read as
 * a freeze made before ORC-342 read it, its `test` script alone.
 */
export function fingerprint(path: string, content: string, before342 = false): string | undefined {
  const name = fileName(path);
  const part = before342 && name === 'package.json' ? packageTestScript : TEST_PART.get(name);
  if (part && !content.includes('\0')) {
    try {
      const read = part(content);
      return read === undefined ? undefined : sha256(JSON.stringify(read));
    } catch {
      // Unreadable: whole, below.
    }
  }
  return sha256(content);
}

/**
 * The freeze at `view.head`: the step's `tests`, and every harness file of the commit. A path the commit does not have
 * is left out (frozen before and deleted since); one it has but that cannot be read throws: a breakdown opens no freeze.
 */
export async function freezeTests(tests: readonly string[], view: FreezeView): Promise<FrozenTests> {
  const atHead = (await view.filesAtHead()).map(normalizePath);
  const listed = new Set(atHead);
  const paths = new Set([...tests.map(normalizePath), ...atHead.filter(isFrozenHarness)]);
  const files: Record<string, string> = {};
  for (const path of paths) {
    const content = await view.showAtHead(path);
    if (content === undefined && listed.has(path)) throw new Error(`${path} is unreadable at commit ${view.head}`);
    const print = content === undefined ? undefined : fingerprint(path, content);
    if (print !== undefined) files[path] = print;
  }
  return { sha: view.head, files, rules: FREEZE_RULES };
}

/**
 * What a later `tests` step adds to a freeze already there: its tests, never the harness. A harness file added since the
 * first freeze stays out, and `checkFrozen` keeps failing on it: only a `/refreeze` takes it in.
 */
export function newTestsOnly(read: FrozenTests): FrozenTests {
  return { ...read, files: Object.fromEntries(Object.entries(read.files).filter(([path]) => !isFrozenHarness(path))) };
}

/** `factory/tests-gelés` on `view.head`: every frozen file the commits since the freeze changed, and every harness file they added. */
export async function checkFrozen(frozen: FrozenTests, view: FreezeView): Promise<CheckResult> {
  const findings: string[] = [];
  const before342 = frozen.rules === undefined;
  const isHarness = before342 ? isHarnessBefore342 : isFrozenHarness;
  for (const { path: raw, deleted } of view.changed) {
    const path = normalizePath(raw);
    const was = frozen.files[path];
    if (was === undefined && !isHarness(path)) continue;
    const content = deleted ? undefined : await view.showAtHead(path);
    const now = content === undefined ? undefined : fingerprint(path, content, before342);
    if (now === was) continue;
    findings.push(`${mdCode(path)}: ${was === undefined ? 'harness added after the freeze' : now === undefined ? 'deleted' : 'changed'}`);
  }
  const count = Object.keys(frozen.files).length;
  const ok = findings.length === 0;
  const summary = ok
    ? `${count} frozen files, unchanged since the freeze`
    : `Changed since the freeze, publication blocked (a maintainer can refreeze with \`${REFREEZE}\`):\n${findings.map((f) => `- ${f}`).join('\n')}`;
  return { check: FREEZE_CHECK, ok, summary };
}
