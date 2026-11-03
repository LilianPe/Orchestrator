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

/**
 * The harness beyond the runner's config (`isTestHarnessFile`): `conftest.py` (pytest's shared fixtures), `tsconfig*.json`,
 * and the manifests whose test part only is frozen (`package.json`'s `test` script, `pyproject.toml`'s pytest section).
 */
export function isFrozenHarness(path: string): boolean {
  const name = normalizePath(path).split('/').at(-1) ?? '';
  return isTestHarnessFile(path) || /^(?:conftest\.py|tsconfig(?:\.[\w-]+)*\.json|package\.json|pyproject\.toml)$/.test(name);
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * sha256 of what the test run reads in `content`: the whole file, but the `test` script of a `package.json` and the
 * `[tool.pytest]` section of a `pyproject.toml`. Undefined when such a manifest has none: nothing to freeze. A manifest
 * that does not parse is fingerprinted whole: any change to it then counts.
 */
export function fingerprint(path: string, content: string): string | undefined {
  const name = normalizePath(path).split('/').at(-1);
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

/** The freeze at `view.head`: the step's `tests`, and every harness file of the commit. */
export async function freezeTests(tests: readonly string[], view: FreezeView): Promise<FrozenTests> {
  const paths = new Set([...tests.map(normalizePath), ...(await view.filesAtHead()).filter(isFrozenHarness).map(normalizePath)]);
  const files: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const content = await view.showAtHead(path);
    const print = content === undefined ? undefined : fingerprint(path, content);
    if (print !== undefined) files[path] = print;
  }
  return { sha: view.head, files };
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
    findings.push(`${mdCode(path)} : ${was === undefined ? 'harnais ajouté après le gel' : now === undefined ? 'supprimé' : 'modifié'}`);
  }
  const count = Object.keys(frozen.files).length;
  const ok = findings.length === 0;
  const summary = ok
    ? `${count} fichiers gelés, inchangés depuis le gel`
    : `Modifié depuis le gel, publication bloquée (un mainteneur peut regeler par \`${REFREEZE}\`) :\n${findings.map((f) => `- ${f}`).join('\n')}`;
  return { check: FREEZE_CHECK, ok, summary };
}
