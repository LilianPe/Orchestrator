import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec } from '../adapters/exec.js';
import { DEFAULT_REQUIREMENTS, type SandboxProvider } from '../adapters/sandbox/types.js';
import { SHA } from '../adapters/workspace/git-workspaces.js';
import { runAndRerun, settle, type CommandRun, type KnownFlaky, type Standing } from '../checks/flaky.js';
import { ANSI, logExcerpt } from '../checks/log-excerpt.js';
import { parseRepoConfig, REPO_CONFIG_PATH, RepoConfigError, type RepoConfig } from '../config/repo-config.js';
import { IN_SANDBOX } from '../publish/extract.js';
import { BASE, boxOpener, cloneGit, fetchFromForge, initHardenedClone, reportRun, show, testCommands, verifyCommand, withDeadline, within, zFields, type CloneGit } from './clean-verify.js';
import { RELEASE_AGE_DAYS, runSealedSetup, SetupFailure } from './sealed-setup.js';
import { VERIFY_TIMEOUT_MS } from './verify.js';

/** What breaks a dry run, as its report classifies it (ORC-408). */
export type DryRunBreakKind = 'dependency' | 'service' | 'variable' | 'flaky' | 'failure';

export interface DryRunBreak {
  kind: DryRunBreakKind;
  /** Where: the commit's `.factory/config.yml`, its `setup`, or one of its commands. */
  step: 'config' | 'setup' | 'command';
  command: string;
  /** The line that names the cause, or what the factory says of it. */
  detail: string;
  /** An excerpt of what the command printed. */
  output: string;
}

/**
 * What the dry run ran with: part 3 (ORC-409) runs it again when this changes. `setup`, a hash of its commands; `image`, the
 * runner image as configured; `lockfiles`, the blob of each lockfile at the commit's root; `hash`, of the three.
 */
export interface DryRunFingerprint {
  setup: string;
  image: string;
  lockfiles: Record<string, string>;
  hash: string;
}

/** A dry run of a repository (ORC-408): `setup`, then its commands, on a commit of its default branch, in the sandbox. */
export interface DryRun {
  id: string;
  projectId: string;
  sha: string;
  /** `main`: the forge's default branch as it stood; `commit`: a commit given (the replay of closed tickets, ORC-231). */
  target: 'main' | 'commit';
  ok: boolean;
  fingerprint: DryRunFingerprint;
  breaks: DryRunBreak[];
  /** What ran after the setup. */
  commands: string[];
  startedAt: number;
  endedAt: number;
}

export interface DryRunRequest {
  sandboxes: SandboxProvider;
  /** The dry run's id: its sandboxes are `<runId>-prepare`, `<runId>-run-setup` and `<runId>-run`, so `recover()` finds them among the dead. */
  runId: string;
  projectId: string;
  /** Where the commit is read: on the forge, with the daemon's credentials. */
  originUrl: string;
  /** A commit given; absent, the forge's default branch. */
  sha?: string;
  /** On the host, empty, and the caller's to remove: the clone the sandboxes mount is in its `clone/`, the host git's config beside it. */
  workDir: string;
  /** The workflow's (`workspace.setup`, `jobs.dev.verify`): what the commit's `.factory/config.yml` does not declare. */
  setup: readonly string[];
  commands: readonly string[];
  /** The runner image the sandboxes run, as configured (`FACTORY_RUNNER_IMAGE`). */
  image: string;
  /** The variables the repository declares (ORC-211), never a secret. */
  env: (config: RepoConfig) => Promise<Record<string, string>>;
  knownFlaky?: readonly KnownFlaky[];
  now: () => number;
  log: (message: string) => void;
  /** Each sandbox's, and each fetch from the forge's. */
  deadlineMs?: number;
  exec?: Exec;
}

/** The lockfiles the fingerprint reads, at the commit's root. */
export const LOCKFILES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock',
] as const;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function dryRunFingerprint(i: { setup: readonly string[]; image: string; lockfiles: Record<string, string> }): DryRunFingerprint {
  const lockfiles = Object.fromEntries(Object.entries(i.lockfiles).sort(([a], [b]) => a.localeCompare(b)));
  const setup = sha256(JSON.stringify(i.setup));
  return { setup, image: i.image, lockfiles, hash: sha256(JSON.stringify({ setup, image: i.image, lockfiles })) };
}

/** Each lockfile of `LOCKFILES` at the root of `sha`, by its blob: git's own hash of its content. */
async function lockfilesAt(git: CloneGit, sha: string): Promise<Record<string, string>> {
  const out = await git.raw('ls-tree', '-z', sha, '--', ...LOCKFILES);
  const entries = zFields(out).map((e) => /^\d+ blob (\w+)\t(.+)$/.exec(e)).filter((m) => m !== null);
  return Object.fromEntries(entries.map((m) => [m[2]!, m[1]!]));
}

/** As a ticket's `verify`, unless the request says otherwise: each sandbox, and each fetch from the forge. */
const DEADLINE_MS = VERIFY_TIMEOUT_MS + 60_000;
const OUTPUT_MAX = 4000;
const DETAIL_MAX = 300;
const DEPENDENCY = `a dependency is missing, or younger than the ${RELEASE_AGE_DAYS} days the setup allows`;

/** What names a cause, in its order: the first pattern a line matches wins. A module named by a path is the repository's own, not a dependency. */
const DEPENDENCY_LINES = [
  /No matching version found for \S+/,
  /ERR_PNPM_NO_MATURE_MATCHING_VERSION|minimumReleaseAge/,
  /Because there (?:is|are) no versions? of \S+|was not found in the package registry/,
  /No matching distribution found for \S+|Could not find a version that satisfies the requirement/,
  /Couldn't find any versions for|Couldn't find package/,
  /Cannot find (?:module|package) '(?![./~]|@\/)[^']+'/,
  /ModuleNotFoundError: No module named/,
  /No solution found when resolving/,
];
/** In the setup only: what an installer prints; in a test's output, a 404 is the application's. */
const INSTALL_LINES = [
  /can only install packages when your package\.json and package-lock\.json|ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_FETCH_404/,
  /\b404\b.*Not Found|\bE404\b/,
  /\b(?:ETARGET|notarget|ERESOLVE)\b/,
];
/** The egress proxy's refusal of a host it does not allow: the repository needs a registry the factory does not let it reach. */
const REFUSED_LINES = [/egress proxy:|\b403\b.*Forbidden/];
/**
 * Each with the variable's name as its first group, upper case: a lower-case word is not one. Where nothing says it is a
 * variable, its name must hold a `_`: `URL is not defined` is a global, not a variable of the environment.
 */
const VARIABLE_LINES = [
  /(?:[Mm]issing|[Uu]ndefined|[Rr]equired|[Uu]nset) (?:required )?(?:environment |env )?variables?:?\s*[`'"]?([A-Z][A-Z0-9_]{2,})/,
  /[Ee]nvironment variable [`'"]?([A-Z][A-Z0-9_]{2,})/,
  /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)[`'"]?\s+(?:is not set|is not defined|is undefined|is required|must be set|is missing)\b/,
  /KeyError: '([A-Z][A-Z0-9]*_[A-Z0-9_]+)'/,
];
/** On the loopback, where the services listen; `:3128` is the egress proxy's relay, never a service. */
const SERVICE_LINES = [/ECONNREFUSED (?:127\.0\.0\.1|localhost|::1|\[::1\])(?!:3128\b)(?::\d+)?/, /could not connect to (?:server|database)/i, /Is the server running/];
/** A registry or the egress proxy not answering: nothing of the repository's state, which the dry run then does not record. */
const UNREACHABLE_LINES = [
  /\b(?:ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNRESET|ESOCKETTIMEDOUT)\b|\b50[234]\b.*(?:Bad Gateway|Service Unavailable|Gateway Time-?out)/,
  // pip's and uv's.
  /Failed to establish a new connection|Temporary failure in name resolution|\bdns error\b/,
];
const ERROR_LINE = /\b(?:error|fail(?:ed|ure)?|assert\w*|exception|traceback|panic)\b/i;

const brief = (line: string) => line.trim().slice(0, DETAIL_MAX);
const linesOf = (output: string) => output.replace(ANSI, '').split('\n').filter((l) => l.trim());

function firstLine(lines: readonly string[], patterns: readonly RegExp[], keep: (m: RegExpExecArray) => boolean = () => true): string | undefined {
  for (const p of patterns) {
    for (const line of lines) {
      const m = p.exec(line);
      if (m && keep(m)) return line;
    }
  }
  return undefined;
}

/**
 * What a failed setup or command broke on, read from its output: a dependency missing or too recent (in the setup, a registry the
 * egress proxy refuses too), a variable the code reads and the repository does not declare, a service that does not answer on the
 * loopback; anything else, a failure, said by its first error line. A reading of text: what a tool prints otherwise is a failure,
 * never a guess.
 */
export function classifyBreak(output: string, step: DryRunBreak['step'], declared: Pick<RepoConfig, 'env'>): { kind: DryRunBreakKind; detail: string } {
  const lines = linesOf(output);
  const dependency = firstLine(lines, step === 'setup' ? [...DEPENDENCY_LINES, ...INSTALL_LINES] : DEPENDENCY_LINES);
  if (dependency) return { kind: 'dependency', detail: `${DEPENDENCY}: ${brief(dependency)}` };
  const refused = step === 'setup' ? firstLine(lines, REFUSED_LINES) : undefined;
  if (refused) return { kind: 'dependency', detail: `a registry the egress proxy does not allow: ${brief(refused)}` };
  const variable = firstLine(lines, VARIABLE_LINES, (m) => !declared.env.includes(m[1]!));
  if (variable) return { kind: 'variable', detail: `a variable the repository does not declare under \`env\`: ${brief(variable)}` };
  const service = firstLine(lines, SERVICE_LINES);
  if (service) return { kind: 'service', detail: `a service does not answer: ${brief(service)}` };
  const error = lines.find((l) => ERROR_LINE.test(l)) ?? lines.at(-1);
  return { kind: 'failure', detail: error ? brief(error) : 'it printed nothing' };
}

/** The line of a setup's output that says a registry or the egress proxy did not answer: a breakdown, not the repository's state. */
export function unreachable(output: string): string | undefined {
  const line = firstLine(linesOf(output), UNREACHABLE_LINES);
  return line && brief(line);
}

const breakOf = (step: DryRunBreak['step'], command: string, output: string, declared: Pick<RepoConfig, 'env'>): DryRunBreak => ({
  ...classifyBreak(output, step, declared), step, command, output: logExcerpt(output, OUTPUT_MAX),
});

/**
 * The breaks of the failed commands: a failing test that passed on its rerun is flaky; a command that failed on its flaky tests
 * alone has no other break, one that failed on more is classified by its output. A known flaky test of the repository does not count.
 */
export function breaksOfRuns(runs: readonly CommandRun[], standing: Standing, declared: Pick<RepoConfig, 'env'>): DryRunBreak[] {
  return runs.flatMap((run) => {
    const settled = settle([run], standing);
    if (!settled.failures.length) return [];
    const counted = settled.flaky.filter((t) => !t.indicative);
    const flaky = counted.filter((t) => t.attempts.some((a) => a.on === 'head' && a.attempt === 2 && a.outcome === 'passed'));
    const output = logExcerpt(run.output, OUTPUT_MAX);
    const breaks = flaky.map((t): DryRunBreak => ({ kind: 'flaky', step: 'command', command: run.command, detail: `${t.test} failed, then passed on its rerun`, output }));
    // `withoutIndicative` is set only when every failing test is a known flaky one, none of them counted.
    const onlyFlaky = flaky.length > 0 && flaky.length === counted.length && !run.notRerun && run.withoutIndicative === undefined;
    return onlyFlaky ? breaks : [...breaks, breakOf('command', run.command, run.output, declared)];
  });
}

/** The forge's default branch into the clone, and the commit given when the fetch of it did not bring it. */
async function fetchCommit(req: DryRunRequest, git: CloneGit, cloneDir: string): Promise<string> {
  const fetch = (refspecs: string[], said: string) =>
    within(fetchFromForge(req, cloneDir, refspecs, said), req.deadlineMs ?? DEADLINE_MS, `the forge no longer responds: ${said}`);
  await fetch([`+HEAD:${BASE}`], "the forge's default branch");
  if (!req.sha) return git('rev-parse', '--verify', `${BASE}^{commit}`);
  const sha = req.sha;
  const held = async () => {
    const r = await git.status('rev-parse', '--verify', '--quiet', `${sha}^{commit}`);
    return r.code === 0 ? r.stdout.trim() : undefined;
  };
  const said = `the commit ${sha.slice(0, 12)}`;
  const found = await held();
  if (found) return found;
  await fetch([sha], `${said} of the forge`);
  const fetched = await held();
  if (!fetched) throw new Error(`${said} is not on the forge`);
  return fetched;
}

/**
 * The dry run (ORC-408): the commit, the forge's default branch or the one given, as `verify` would set it up for a ticket.
 *
 * 1. on the host, a clone of ours without the repository's config, the commit fetched from the forge; `.factory/config.yml`,
 *    the fingerprint's inputs and the runner of each command read there, before any of its code runs;
 * 2. the checkout, in a sandbox at network `none`;
 * 3. `setup`, sealed as an attempt's (`runSealedSetup`), at `limited` (N2: the registries the egress proxy allows), without a
 *    secret, on services of its own;
 * 4. the commands, in a new sandbox at `none` on those services, each failing test their runner names rerun once (`runAndRerun`).
 *
 * What the commit breaks on is recorded red, classified (`classifyBreak`): its config refused, a service no sandbox provides, its
 * setup, its commands. What the factory cannot tell of it rejects, without a dry run: the forge or the engine down.
 */
export async function runDryRun(req: DryRunRequest): Promise<DryRun> {
  if (req.sha !== undefined && !SHA.test(req.sha)) throw new Error(`${req.sha}: a full commit sha expected`);
  const startedAt = req.now();
  const sandboxes = withDeadline(req.sandboxes, req.deadlineMs ?? DEADLINE_MS);
  const inBox = boxOpener(sandboxes, { runId: req.runId, ticketId: req.projectId, log: req.log });
  // Beside the host git's own config (`cloneGit` writes it in `workDir`), never in the tree the sandboxes mount.
  const cloneDir = join(req.workDir, 'clone');
  mkdirSync(cloneDir);
  const git = cloneGit(req, cloneDir);
  await initHardenedClone(git);
  const sha = await fetchCommit(req, git, cloneDir);
  const lockfiles = await lockfilesAt(git, sha);
  const dryRun = (breaks: DryRunBreak[], ranSetup: readonly string[], ran: readonly string[]): DryRun => ({
    id: req.runId, projectId: req.projectId, sha, target: req.sha ? 'commit' : 'main', ok: !breaks.length,
    fingerprint: dryRunFingerprint({ setup: ranSetup, image: req.image, lockfiles }), breaks, commands: [...ran], startedAt, endedAt: req.now(),
  });
  let config: RepoConfig;
  try {
    config = parseRepoConfig(await show(git, sha, REPO_CONFIG_PATH));
  } catch (err) {
    if (!(err instanceof RepoConfigError)) throw err;
    const broke: DryRunBreak = { kind: 'failure', step: 'config', command: REPO_CONFIG_PATH, detail: brief(err.message.replaceAll('\n', ' ')), output: err.message };
    return dryRun([broke], req.setup, []);
  }
  const declared = Object.values(config.commands);
  const commands = declared.length ? declared : req.commands;
  const setup = config.setup ? [config.setup] : req.setup;
  const unprovided = req.sandboxes.unprovided([...new Set(config.services)]);
  if (unprovided.length) {
    const detail = `${unprovided.join(', ')}: declared under \`services\` in ${REPO_CONFIG_PATH}, and no sandbox backend of this factory provides ${unprovided.length === 1 ? 'it' : 'them'}`;
    return dryRun([{ kind: 'service', step: 'config', command: REPO_CONFIG_PATH, detail, output: '' }], setup, []);
  }
  await inBox('prepare', cloneDir, [], async (id) => {
    // `-c`: the clone's config is ours.
    const out = await sandboxes.exec(id, ['git', ...IN_SANDBOX, 'checkout', '--quiet', '--detach', sha]);
    if (out.code !== 0) throw new Error(`git checkout (sandbox): ${out.stderr.trim()}`);
  });
  // Read before any of its code runs, and before the setup opens services that a failure here would leave behind.
  const tests = await testCommands(git, sha, commands);
  const env = await req.env(config);
  if (setup.length) {
    try {
      await runSealedSetup(sandboxes, { runId: `${req.runId}-run`, ticketId: req.projectId, workspacePath: cloneDir, mounts: [], commands: setup, argv: verifyCommand, env, secrets: {}, services: config.services, now: new Date(req.now()) });
    } catch (err) {
      if (!(err instanceof SetupFailure)) throw err;
      const broke: DryRunBreak = err.exitCode === null
        ? { kind: 'failure', step: 'setup', command: err.command, detail: err.message, output: logExcerpt(err.output, OUTPUT_MAX) }
        : breakOf('setup', err.command, err.output, config);
      // A registry or the proxy that did not answer says nothing of the repository: no dry run, as for the forge or the engine.
      // A dependency it then says is missing was not reached; a service of the repository's own that refuses is its own.
      const down = broke.kind === 'failure' || broke.kind === 'dependency' ? unreachable(err.output) : undefined;
      if (down) throw new Error(`${err.command}: a registry or the egress proxy did not answer, no dry run recorded: ${down}`, { cause: err });
      return dryRun([broke], setup, []);
    }
  }
  const standing: Standing = { known: req.knownFlaky ?? [] };
  const failed: CommandRun[] = [];
  await inBox('run', cloneDir, [], async (id) => {
    for (const command of commands) {
      const { line, runner } = tests.get(command)!;
      const run = await runAndRerun(command, runner, reportRun(sandboxes, id, env), standing, line);
      if (run) failed.push(run);
    }
  }, { ...DEFAULT_REQUIREMENTS, services: config.services });
  return dryRun(breaksOfRuns(failed, standing, config), setup, commands);
}
