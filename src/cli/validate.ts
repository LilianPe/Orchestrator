import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRepoConfig, REPO_CONFIG_DIR, REPO_CONFIG_PATH, RepoConfigError } from '../config/repo-config.js';

const FILE = REPO_CONFIG_PATH;
/** A spelling the factory never reads: validating around it would pass a file nobody applies. */
const MISSPELT = '.factory/config.yaml';

/**
 * `factory validate [repo]` (ORC-209): checks the repository's `.factory/config.yml` against the socle. Exit code
 * 1 when the file takes from the socle, is malformed or unreadable, one line per violation; 0 otherwise.
 */
export function runValidateCommand(opts: { repoPath: string; out: (line: string) => void }): number {
  if (opts.repoPath.startsWith('-')) {
    opts.out('Usage: factory validate [repo] (no options)');
    return 1;
  }
  const refuse = (violations: string[]): number => {
    opts.out(`${FILE} refused:`);
    for (const v of violations) opts.out(`- ${v}`);
    return 1;
  };
  if (existsSync(join(opts.repoPath, MISSPELT))) return refuse([`${MISSPELT}: rename it to ${FILE}, the only name the factory reads`]);
  // As the daemon reads it on the default branch (`makeRepoConfig`): through a link, git sees no file, and the launch refuses it.
  // `lstat`, not `existsSync`, which follows a link: a dangling one would read as no file at all.
  const entry = (p: string) => lstatSync(p, { throwIfNoEntry: false });
  const path = join(opts.repoPath, FILE);
  // A path it cannot look into (EACCES, ELOOP) is refused as unreadable, as the file itself is below.
  try {
    const dir = entry(join(opts.repoPath, REPO_CONFIG_DIR));
    if (dir && !dir.isDirectory()) return refuse([`${REPO_CONFIG_DIR}: a folder is expected, not a symbolic link or a file`]);
    if (entry(path)?.isSymbolicLink()) return refuse([`${FILE}: a file is expected, not a symbolic link`]);
  } catch (err) {
    return refuse([`unreadable: ${(err as Error).message}`]);
  }
  if (!existsSync(path)) {
    opts.out(`no ${FILE}: the factory/default baseline applies as is.`);
    return 0;
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return refuse([`unreadable: ${(err as Error).message}`]);
  }
  let warnings: string[];
  try {
    warnings = parseRepoConfig(text).sensitivePathWarnings ?? [];
  } catch (err) {
    if (!(err instanceof RepoConfigError)) throw err;
    return refuse(err.violations);
  }
  opts.out(`${FILE} valid: it only adds checks or prohibitions to the baseline.`);
  // ORC-338: kept out of the check, and a branch that took untrusted content is refused until they are fixed.
  if (warnings.length) opts.out(`Warning, ignored entries (a branch that took untrusted content is refused until they are fixed):`);
  for (const w of warnings) opts.out(`- ${w}`);
  return 0;
}
