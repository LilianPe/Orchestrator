import { cpSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * The Python repository the tests hand to the factory (ORC-172): uv, pytest, ruff and mypy, no `.factory/config.yml`.
 * Its `uv.lock` is a real one (uv 0.13.7, `exclude-newer` a week before it was made): `uv sync --frozen`, then the
 * three commands `init` proposes, pass on it.
 */
export const PYTHON_REPO = join(import.meta.dirname, '../fixtures/python-repo');

/** What a run of uv, pytest, mypy or ruff in the fixture leaves there (`.venv`, `.pytest_cache`, `__pycache__`…): not the repository. */
const isRunLeftover = (name: string): boolean => name.startsWith('.') || name === '__pycache__';

/** The files under `dir`, by path from it (`/`-separated), without descending into a leftover. */
function readTree(dir: string, prefix = ''): [string, string][] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !isRunLeftover(e.name))
    .flatMap((e) => (e.isDirectory() ? readTree(join(dir, e.name), `${prefix}${e.name}/`) : [[`${prefix}${e.name}`, readFileSync(join(dir, e.name), 'utf8')] as [string, string]]));
}

let files: Readonly<Record<string, string>> | undefined;

/** Its files by repository path, as the fake workspaces take them: read once. */
export const pythonRepoFiles = (): Readonly<Record<string, string>> => (files ??= Object.freeze(Object.fromEntries(readTree(PYTHON_REPO))));

/** Copies it into `dir`, an existing directory. */
export const copyPythonRepo = (dir: string): void => cpSync(PYTHON_REPO, dir, { recursive: true, filter: (src) => src === PYTHON_REPO || !isRunLeftover(basename(src)) });
