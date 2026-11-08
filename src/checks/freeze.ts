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
}

/** A commit of the branch, read on the factory's repository, never in the agent's worktree (ORC-205). */
export interface FreezeView {
  head: string;
  /** Files changed from the frozen commit to `head`. */
  changed: readonly { path: string; deleted: boolean }[];
  filesAtHead(): Promise<string[]>;
  showAtHead(path: string): Promise<string | undefined>;
}

/** The section pytest reads in the INI files it shares with other tools (ORC-311). */
const PYTEST_INI_SECTION = new Map([['tox.ini', 'pytest'], ['setup.cfg', 'tool:pytest']]);

/**
 * The harness beyond the runner's config (`isTestHarnessFile`): `conftest.py` (pytest's shared fixtures), `tsconfig*.json`,
 * and the files whose test part only is frozen (`package.json`'s `test` script, the pytest section of `pyproject.toml`,
 * `tox.ini` and `setup.cfg`).
 */
export function isFrozenHarness(path: string): boolean {
  const name = normalizePath(path).split('/').at(-1) ?? '';
  return isTestHarnessFile(path) || PYTEST_INI_SECTION.has(name) || /^(?:conftest\.py|tsconfig(?:\.[\w-]+)*\.json|package\.json|pyproject\.toml)$/.test(name);
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * The lines of `[section]` in an INI file, blank and comment lines left out, indentation kept (it continues a value).
 * A header as pytest's iniconfig reads it: exact, alone on its line but for a comment. Undefined when the file has no such section.
 */
function iniSection(content: string, section: string): string[] | undefined {
  let lines: string[] | undefined;
  let inside = false;
  for (const raw of content.split(/\r?\n/)) {
    const header = /^\[([^\]]*)\]\s*(?:[#;].*)?$/.exec(raw);
    if (header) {
      inside = header[1] === section;
      if (inside) lines ??= [];
    } else if (inside && raw.trim() !== '' && !/^\s*[#;]/.test(raw)) lines!.push(raw.trimEnd());
  }
  return lines;
}

/**
 * sha256 of what the test run reads in `content`: the whole file, but the `test` script of a `package.json` and the
 * pytest section of a `pyproject.toml` (`[tool.pytest]`), a `tox.ini` (`[pytest]`) or a `setup.cfg` (`[tool:pytest]`).
 * Undefined when such a file has none: nothing to freeze. A manifest that does not parse is fingerprinted whole: any
 * change to it then counts.
 */
export function fingerprint(path: string, content: string): string | undefined {
  const name = normalizePath(path).split('/').at(-1) ?? '';
  const ini = PYTEST_INI_SECTION.get(name);
  // A NUL is no INI text: the read of a blob too large to show, fingerprinted whole below.
  if (ini && !content.includes('\0')) {
    const section = iniSection(content, ini);
    return section === undefined ? undefined : sha256(JSON.stringify(section));
  }
  try {
    if (name === 'package.json') {
      const test = (JSON.parse(content) as { scripts?: { test?: unknown } }).scripts?.test;
      return test === undefined ? undefined : sha256(JSON.stringify(test));
    }
    if (name === 'pyproject.toml') {
      const tool = parseToml(content).tool;
      const pytest = isTable(tool) ? tool.pytest : undefined;
      return pytest === undefined ? undefined : sha256(JSON.stringify(pytest));
    }
  } catch {
    // Unreadable: whole, below.
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
  return { sha: view.head, files };
}

/**
 * What a later `tests` step adds to a freeze already there: its tests, never the harness. A harness file added since the
 * first freeze stays out, and `checkFrozen` keeps failing on it: only a `/refreeze` takes it in.
 */
export function newTestsOnly(read: FrozenTests): FrozenTests {
  return { sha: read.sha, files: Object.fromEntries(Object.entries(read.files).filter(([path]) => !isFrozenHarness(path))) };
}

/** `factory/tests-gelés` on `view.head`: every frozen file the commits since the freeze changed, and every harness file they added. */
export async function checkFrozen(frozen: FrozenTests, view: FreezeView): Promise<CheckResult> {
  const findings: string[] = [];
  for (const { path: raw, deleted } of view.changed) {
    const path = normalizePath(raw);
    const was = frozen.files[path];
    if (was === undefined && !isFrozenHarness(path)) continue;
    const content = deleted ? undefined : await view.showAtHead(path);
    const now = content === undefined ? undefined : fingerprint(path, content);
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
