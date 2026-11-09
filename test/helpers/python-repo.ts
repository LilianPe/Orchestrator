import { cpSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The Python repository the tests hand to the factory (ORC-172): uv, pytest, ruff and mypy, no `.factory/config.yml`.
 * Its `uv.lock` is a real one (uv 0.13.7, `exclude-newer` a week before it was made): `uv sync --frozen`, then the
 * three commands `init` proposes, pass on it.
 */
export const PYTHON_REPO = join(import.meta.dirname, '../fixtures/python-repo');

/** What a run of uv, pytest, mypy or ruff in the fixture leaves there (`.venv`, `.pytest_cache`, `__pycache__`…): not the repository. */
const isRunLeftover = (path: string): boolean => relative(PYTHON_REPO, path).split(sep).some((s) => s.startsWith('.') || s === '__pycache__');

/** Its files by repository path (`/`-separated), as the fake workspaces take them. */
export function pythonRepoFiles(): Record<string, string> {
  const files = readdirSync(PYTHON_REPO, { recursive: true, withFileTypes: true })
    .map((e) => ({ e, path: join(e.parentPath, e.name) }))
    .filter(({ e, path }) => e.isFile() && !isRunLeftover(path));
  return Object.fromEntries(files.map(({ path }) => [relative(PYTHON_REPO, path).split(sep).join('/'), readFileSync(path, 'utf8')]));
}

/** Copies it into `dir`, an existing directory. */
export const copyPythonRepo = (dir: string): void => cpSync(PYTHON_REPO, dir, { recursive: true, filter: (src) => !isRunLeftover(src) });
