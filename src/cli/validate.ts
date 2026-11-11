import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FactoryYmlError, type FactoryYml } from '../config/factory-yml.js';
import { parseRepoConfig, REPO_CONFIG_DIR, REPO_CONFIG_PATH, RepoConfigError, ticketTokenCap, type RepoConfig } from '../config/repo-config.js';
import { checkBudgets } from '../presets/budget.js';
import { factoryDefault } from '../presets/factory-default.js';
import { isAgentStep } from '../presets/preset.js';
import { narrowTools, stepTools, toolRefusal } from '../presets/tools.js';

const FILE = REPO_CONFIG_PATH;
/** A spelling the factory never reads: validating around it would pass a file nobody applies. */
const MISSPELT = '.factory/config.yaml';

/**
 * `factory validate [repo]` (ORC-209): checks the repository's `.factory/config.yml` against the socle, shows the tools of each
 * agent step (ORC-383), then checks the worst case of the preset against the ticket's budget (ORC-216), with `factory.yml`'s
 * budgets and tools (`factoryYml`, read when asked). Exit code 1 when the file takes from the socle, is malformed or unreadable,
 * when factory.yml gives a step a tool it may not have, or when a budget is unset or exceeded, one line per violation; 0 otherwise.
 */
export function runValidateCommand(opts: { repoPath: string; out: (line: string) => void; factoryYml: () => FactoryChecks | undefined }): number {
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
  let yml: FactoryChecks | undefined;
  try {
    yml = opts.factoryYml();
  } catch (err) {
    // A file it cannot read (EACCES, EISDIR) is refused as unreadable, as the repository's own file is.
    return list(opts.out, 'factory.yml refused:', err instanceof FactoryYmlError ? err.violations : [`unreadable: ${(err as Error).message}`]);
  }
  return validateTools(config, yml, opts.out) || validateBudgets(config, yml?.budgets, opts.out);
}

/** What `factory validate` reads of factory.yml: its budgets and its tools, never its secrets. */
type FactoryChecks = Pick<FactoryYml, 'budgets' | 'tools'>;

/**
 * The tools each agent step gets (ORC-383), as the launch hands them out: factory.yml's or the preset's, kept to the repository's,
 * without WebFetch at network none. A tool factory.yml may not give is refused, as the daemon refuses it at load; one the repository
 * names that factory.yml does not give is a warning: the repository only restricts, the launch ignores it.
 */
function validateTools(config: RepoConfig, yml: FactoryChecks | undefined, out: (line: string) => void): number {
  const steps = factoryDefault.steps.filter(isAgentStep);
  const given = (id: string) => yml?.tools?.perStep?.[id] ?? stepTools(steps.find((s) => s.id === id)!)!;
  const refused = Object.entries(yml?.tools?.perStep ?? {}).flatMap(([id, tools]) => {
    const step = steps.find((s) => s.id === id);
    if (!step) return [`tools.per_step.${id}: not an agent step of ${factoryDefault.name}`];
    return tools.flatMap((t) => toolRefusal(step, t) ?? []).map((r) => `tools.per_step.${id}: ${r}`);
  });
  if (refused.length) return list(out, 'factory.yml refused:', refused);
  const ignored = Object.entries(config.tools?.perStep ?? {}).flatMap(([id, tools]) => {
    const extra = tools.filter((t) => !given(id).includes(t));
    return extra.length ? [`tools.per_step.${id}: ${extra.join(', ')}`] : [];
  });
  if (ignored.length) list(out, 'Warning, tools the repository names that factory.yml does not give the step (ignored):', ignored);
  out(`Tools of each agent step of ${factoryDefault.name}:`);
  for (const s of steps) {
    const network = config.network.level === 'none' ? 'none' : s.network;
    out(`- ${s.id}: ${narrowTools(given(s.id), config.tools?.perStep[s.id], network)!.join(', ') || 'none'}`);
  }
  return 0;
}

/** A refusal: its head, then one line per violation. Exit code 1. */
function list(out: (line: string) => void, head: string, violations: string[]): number {
  out(head);
  for (const v of violations) out(`- ${v}`);
  return 1;
}

/** The invariant « budget caps » (ORC-216), on factory.yml's budgets and the repository's cap, which only lowers the ticket's. */
function validateBudgets(config: RepoConfig, budgets: FactoryYml['budgets'], out: (line: string) => void): number {
  const perTicketTokens = ticketTokenCap(budgets?.perTicketTokens, config);
  const caps = { ...budgets, ...(perTicketTokens !== undefined ? { perTicketTokens } : {}) };
  // The preset's structure is compiled at load (`loadWorkflow`): only its budgets are left to check.
  const { violations, worst } = checkBudgets(factoryDefault, caps);
  if (violations.length) return list(out, `Budgets of ${factoryDefault.name} refused:`, violations);
  out(`Worst case of ${factoryDefault.name}: ${worst!.tokens} tokens and ${worst!.turns} turns per ticket, within budgets.per_ticket_tokens ${perTicketTokens}.`);
  return 0;
}
