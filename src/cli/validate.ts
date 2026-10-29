import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRepoConfig, RepoConfigError } from '../config/repo-config.js';

const FILE = '.factory/config.yml';

/**
 * `factory validate [repo]` (ORC-209): checks the repository's `.factory/config.yml` against the socle. Exit code
 * 1 when the file takes from the socle or is malformed, one line per violation; 0 otherwise.
 */
export function runValidateCommand(opts: { repoPath: string; out: (line: string) => void }): number {
  const path = join(opts.repoPath, FILE);
  if (!existsSync(path)) {
    opts.out(`pas de ${FILE} : le socle de factory/default s'applique tel quel.`);
    return 0;
  }
  try {
    parseRepoConfig(readFileSync(path, 'utf8'));
  } catch (err) {
    if (!(err instanceof RepoConfigError)) throw err;
    opts.out(`${FILE} refusé :`);
    for (const v of err.violations) opts.out(`- ${v}`);
    return 1;
  }
  opts.out(`${FILE} valide : il n'ajoute que des contrôles ou des interdits au socle.`);
  return 0;
}
