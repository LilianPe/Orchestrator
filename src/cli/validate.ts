import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { disabledControls, FactoryYmlError, type FactoryYml } from '../config/factory-yml.js';
import { parseRepoConfig, REPO_CONFIG_DIR, REPO_CONFIG_PATH, RepoConfigError, ticketTokenCap, type RepoConfig } from '../config/repo-config.js';
import { checkBudgets } from '../presets/budget.js';
import { factoryDefault } from '../presets/factory-default.js';

const FILE = REPO_CONFIG_PATH;
/** A spelling the factory never reads: validating around it would pass a file nobody applies. */
const MISSPELT = '.factory/config.yaml';

/** What `factory validate` reads of `factory.yml`: its budgets, and the controls it disables (ORC-381). */
type FactoryLimits = Pick<FactoryYml, 'budgets' | 'maxDiff'>;

/**
 * `factory validate [repo]` (ORC-209): checks the repository's `.factory/config.yml` against the socle, then the worst
 * case of the preset against the ticket's budget (ORC-216), with `factory.yml`'s budgets (`factoryYml`, read when asked),
 * and names the controls `factory.yml` disables (ORC-381). Exit code 1 when the file takes from the socle, is malformed
 * or unreadable, or when a budget is unset or exceeded, one line per violation; 0 otherwise.
 */
export function runValidateCommand(opts: { repoPath: string; out: (line: string) => void; factoryYml: () => FactoryLimits | undefined }): number {
  if (opts.repoPath.startsWith('-')) {
    opts.out('Usage: factory validate [repo] (no options)');
    return 1;
  }
  const refuse = (violations: string[]): number => list(opts.out, `${FILE} refused:`, violations);
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
  return validateBudgets(config, opts);
}

/** A refusal: its head, then one line per violation. Exit code 1. */
function list(out: (line: string) => void, head: string, violations: string[]): number {
  out(head);
  for (const v of violations) out(`- ${v}`);
  return 1;
}

/**
 * The invariant « budget caps » (ORC-216), on factory.yml's budgets and the repository's cap, which only lowers the ticket's.
 * A control factory.yml disables is said first (ORC-381).
 */
function validateBudgets(config: RepoConfig, opts: { out: (line: string) => void; factoryYml: () => FactoryLimits | undefined }): number {
  let yml: FactoryLimits | undefined;
  try {
    yml = opts.factoryYml();
  } catch (err) {
    // A file it cannot read (EACCES, EISDIR) is refused as unreadable, as the repository's own file is.
    return list(opts.out, 'factory.yml refused:', err instanceof FactoryYmlError ? err.violations : [`unreadable: ${(err as Error).message}`]);
  }
  const disabled = disabledControls(yml);
  if (disabled.length) opts.out(`Disabled in factory.yml: ${disabled.join(', ')}.`);
  const budgets = yml?.budgets;
  const perTicketTokens = ticketTokenCap(budgets?.perTicketTokens, config);
  const caps = { ...budgets, ...(perTicketTokens !== undefined ? { perTicketTokens } : {}) };
  // The preset's structure is compiled at load (`loadWorkflow`): only its budgets are left to check.
  const { violations, worst } = checkBudgets(factoryDefault, caps);
  if (violations.length) return list(opts.out, `Budgets of ${factoryDefault.name} refused:`, violations);
  if (!worst) opts.out(`No worst case of ${factoryDefault.name} in tokens: budgets.per_step_tokens is disabled.`);
  else opts.out(`Worst case of ${factoryDefault.name}: ${worst.tokens} tokens and ${worst.turns} turns per ticket, ${perTicketTokens === undefined ? 'under no ticket cap' : `within budgets.per_ticket_tokens ${perTicketTokens}`}.`);
  return 0;
}
