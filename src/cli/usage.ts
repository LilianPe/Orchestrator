import { PRODUCT_NAME } from '../product.js';

/** The help of `factory`: its first line, then one line per command, the name first (ORC-200: these and no others, as docs/cli.md lists them). */
export const USAGE = `Usage: factory <command>
  init [--dev]       set up ${PRODUCT_NAME} for the current repository (--dev: a smee.io relay for Linear's webhooks without a public URL, on a workstation)
  validate [repo]    check .factory/config.yml against the baseline (it can only add)
  doctor [repo] [--json] [--secrets] refuse a host without cgroup v2, a repository without a protected default branch or whose CI can expose secrets to the factory's branches
  up                 start ${PRODUCT_NAME} (interface on http://localhost:4100)
  status             state of the running instance
  stop <ID>          stop a ticket's run
  dry-run <project>  run the dry run of a project's default branch (setup, build, tests in the sandbox) and print what breaks
  replay <journal>... replay exported journals (bit-for-bit regression, --what-if <preset>, --export <ID>)
  run repair <ID> [replay|skip|force] [<event>]  repair an event set aside (dead letter)
  flaky <project> [add <test> --reason <why> [--frozen] | remove <test>]  the known flaky tests verify marks indicative
  baseline <project> --since <YYYY-MM-DD> [--replace]  freeze the 90 days before the start as the overview's baseline, from Linear and GitHub
  ghost start|collect|judge|report|list  replay closed tickets without effects, and judge the PRs blind against the human ones`;

/** The command names of a usage's lines: the first word of each, and the second of an `a | b` line. */
export function usageCommands(usage: string): string[] {
  return usage
    .split('\n')
    .slice(1)
    .flatMap((line) => /^\s+(\w[\w-]*)(?: \| (\w[\w-]*))?/.exec(line)?.slice(1).filter((n): n is string => !!n) ?? []);
}

/** The commands `factory` has; any other is answered `Unknown command`. */
export const COMMANDS: ReadonlySet<string> = new Set(usageCommands(USAGE));
