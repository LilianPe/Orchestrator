import type { FactoryYml } from '../config/factory-yml.js';
import { checkBudgets } from '../presets/budget.js';
import { factoryDefault } from '../presets/factory-default.js';

/** What the daemon's start resolved, that decides whether a ticket can reach its end. */
export interface ConfigFacts {
  /** `--fake-runner`: no model reached, no token spent, nothing real published. */
  fakeRunner: boolean;
  /** A container per attempt (FACTORY_CONTAINER_CLI). */
  sandboxes: boolean;
  /** FACTORY_ALLOW_HOST_VERIFY=1, or the fake runner's checks. */
  hostVerify: boolean;
  /** The factory can publish: the sandboxes and the GitHub App, or the fake publisher. */
  publisher: boolean;
  budgets: FactoryYml['budgets'];
}

/**
 * The settings under which every ticket would be blocked, most after a whole agent pipeline paid (ORC-350): the daemon
 * then takes none. The budgets are refused as `factory validate` refuses them (ORC-209, ORC-216), but for a ticket cap
 * factory.yml leaves to the repositories. Only what a restart reads: the Claude account, read again at each launch
 * (ORC-215), stays a warning. Empty when a ticket can reach its end.
 */
export function configProblems(c: ConfigFacts): string[] {
  const problems: string[] = [];
  if (!c.sandboxes && !c.hostVerify) problems.push('verify cannot run: no sandbox (FACTORY_CONTAINER_CLI) and no FACTORY_ALLOW_HOST_VERIFY=1');
  if (!c.publisher) problems.push('publication impossible: it needs the sandboxes and the GitHub App');
  if (c.fakeRunner) return problems;
  // A repository's `.factory/config.yml` may set the ticket's cap, read at each launch: its absence here is no refusal.
  const unsetTicketCap = c.budgets?.perTicketTokens === undefined;
  const budgets = checkBudgets(factoryDefault, c.budgets ?? {}).violations.filter((v) => !(unsetTicketCap && v.startsWith('budgets.per_ticket_tokens:')));
  problems.push(...budgets.map((v) => `factory.yml: ${v}`));
  return problems;
}
