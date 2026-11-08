import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FactoryYmlError, type FactoryYml } from '../config/factory-yml.js';
import { parseRepoConfig, REPO_CONFIG_DIR, REPO_CONFIG_PATH, RepoConfigError, type RepoConfig } from '../config/repo-config.js';
import { worstCase } from '../presets/budget.js';
import { factoryDefault } from '../presets/factory-default.js';
import { compilePreset, PresetError } from '../presets/preset.js';

const FILE = REPO_CONFIG_PATH;
/** A spelling the factory never reads: validating around it would pass a file nobody applies. */
const MISSPELT = '.factory/config.yaml';

/**
 * `factory validate [repo]` (ORC-209): checks the repository's `.factory/config.yml` against the socle, then the worst
 * case of the preset against the ticket's budget (ORC-216), with `factory.yml`'s budgets (`factoryYml`, read when asked).
 * Exit code 1 when the file takes from the socle, is malformed or unreadable, or when a budget is unset or exceeded, one
 * line per violation; 0 otherwise.
 */
export function runValidateCommand(opts: { repoPath: string; out: (line: string) => void; factoryYml: () => FactoryYml | undefined }): number {
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
  let config: RepoConfig;
  if (!existsSync(path)) {
    opts.out(`no ${FILE}: the factory/default baseline applies as is.`);
    config = parseRepoConfig(undefined);
  } else {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      return refuse([`unreadable: ${(err as Error).message}`]);
    }
    try {
      config = parseRepoConfig(text);
    } catch (err) {
      if (!(err instanceof RepoConfigError)) throw err;
      return refuse(err.violations);
    }
    const warnings = config.sensitivePathWarnings ?? [];
    opts.out(`${FILE} valid: it only adds checks or prohibitions to the baseline.`);
    // ORC-338: kept out of the check, and a branch that took untrusted content is refused until they are fixed.
    if (warnings.length) opts.out(`Warning, ignored entries (a branch that took untrusted content is refused until they are fixed):`);
    for (const w of warnings) opts.out(`- ${w}`);
  }
  return checkBudgets(config, opts);
}

/** The invariant « budget caps » (ORC-216), on factory.yml's budgets and the repository's cap, which only lowers the ticket's. */
function checkBudgets(config: RepoConfig, opts: { out: (line: string) => void; factoryYml: () => FactoryYml | undefined }): number {
  const list = (head: string, violations: string[]): number => {
    opts.out(head);
    for (const v of violations) opts.out(`- ${v}`);
    return 1;
  };
  let budgets: FactoryYml['budgets'];
  try {
    budgets = opts.factoryYml()?.budgets;
  } catch (err) {
    if (!(err instanceof FactoryYmlError)) throw err;
    return list('factory.yml refused:', err.violations);
  }
  const ticketCaps = [budgets?.perTicketTokens, config.budgets?.perTicketTokens].filter((c) => c !== undefined);
  const caps = { ...budgets, ...(ticketCaps.length ? { perTicketTokens: Math.min(...ticketCaps) } : {}) };
  try {
    compilePreset(factoryDefault, { budgets: caps });
  } catch (err) {
    if (!(err instanceof PresetError)) throw err;
    return list(`Budgets of ${factoryDefault.name} refused:`, err.violations);
  }
  const worst = worstCase(factoryDefault, caps);
  // Compiled with its budgets, the worst case has its bound and the ticket its cap.
  if (!('missing' in worst)) opts.out(`Worst case of ${factoryDefault.name}: ${worst.tokens} tokens and ${worst.turns} turns per ticket, within budgets.per_ticket_tokens ${caps.perTicketTokens}.`);
  return 0;
}
